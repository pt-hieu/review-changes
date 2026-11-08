import { FileFlag, type FileStatusCode } from '../types.ts'

type TypedArray = Uint8Array | Uint32Array | Float64Array

const INITIAL_FILE_CAPACITY = 1024
const INITIAL_HUNK_CAPACITY = 4096
const INITIAL_PATH_CAPACITY = 64 * 1024
const PATCH_BYTES_PER_FILE_ESTIMATE = 8192
const PATCH_BYTES_PER_HUNK_ESTIMATE = 2048
const MAXIMUM_ESTIMATED_CAPACITY = 1 << 24

const pathDecoder = new TextDecoder('utf-8', { ignoreBOM: true })

function grown<Array extends TypedArray>(array: Array, minimumLength: number): Array {
  if (array.length >= minimumLength) return array

  let length = array.length * 2
  while (length < minimumLength) length *= 2

  const replacement = new (array.constructor as new (length: number) => Array)(length)
  replacement.set(array)

  return replacement
}

function estimatedCapacity(patchByteLength: number, bytesPerEntry: number, minimum: number): number {
  return Math.max(minimum, Math.min(MAXIMUM_ESTIMATED_CAPACITY, Math.ceil(patchByteLength / bytesPerEntry)))
}

function comparePathBytes(left: Uint8Array, right: Uint8Array): number {
  const shared = Math.min(left.length, right.length)

  for (let index = 0; index < shared; index++) {
    const difference = left[index]! - right[index]!
    if (difference !== 0) return difference
  }

  return left.length - right.length
}

export type FileTableEntry = {
  patchOffset: number
  patchStartLine: number
  firstHunk: number
  path: Uint8Array
  previousPath: Uint8Array | undefined
  status: FileStatusCode
  flags: number
  additions: number
  deletions: number
  rowCount: number
  reviewKey: number
}

export class HunkTable {
  constructor(
    readonly count: number,
    readonly offset: Float64Array,
    readonly oldStart: Uint32Array,
    readonly oldLines: Uint32Array,
    readonly newStart: Uint32Array,
    readonly newLines: Uint32Array,
    readonly rowCount: Uint32Array,
  ) {}
}

export class FileTable {
  readonly fileCount: number
  readonly hunkCount: number
  readonly patchByteLength: number
  readonly patchLineCount: number
  readonly patchOffset: Float64Array
  readonly patchStartLine: Uint32Array
  readonly firstHunk: Uint32Array
  readonly pathOffset: Uint32Array
  readonly pathBytes: Uint8Array
  readonly previousPathLength: Uint32Array
  readonly status: Uint8Array
  readonly flags: Uint8Array
  readonly additions: Uint32Array
  readonly deletions: Uint32Array
  readonly rowCount: Uint32Array
  readonly reviewKey: Float64Array

  readonly retainedHunks: ReadonlyMap<number, HunkTable>

  private cachedSortedOrder: Uint32Array | undefined

  constructor(builder: FileTableBuilder, patchByteLength: number, patchLineCount: number) {
    const fileCount = builder.fileCount
    const hunkCount = builder.hunkCount

    this.fileCount = fileCount
    this.hunkCount = hunkCount
    this.retainedHunks = builder.retainedHunks
    this.patchByteLength = patchByteLength
    this.patchLineCount = patchLineCount
    this.patchOffset = builder.patchOffset.subarray(0, fileCount + 1)
    this.patchOffset[fileCount] = patchByteLength
    this.patchStartLine = builder.patchStartLine.subarray(0, fileCount + 1)
    this.patchStartLine[fileCount] = patchLineCount
    this.firstHunk = builder.firstHunk.subarray(0, fileCount + 1)
    this.firstHunk[fileCount] = hunkCount
    this.pathOffset = builder.pathOffset.subarray(0, fileCount + 1)
    this.pathBytes = builder.pathBytes.subarray(0, builder.pathOffset[fileCount])
    this.previousPathLength = builder.previousPathLength.subarray(0, fileCount)
    this.status = builder.status.subarray(0, fileCount)
    this.flags = builder.flags.subarray(0, fileCount)
    this.additions = builder.additions.subarray(0, fileCount)
    this.deletions = builder.deletions.subarray(0, fileCount)
    this.rowCount = builder.rowCount.subarray(0, fileCount)
    this.reviewKey = builder.reviewKey.subarray(0, fileCount)
  }

  pathBytesOf(fileIndex: number): Uint8Array {
    const start = this.pathOffset[fileIndex]!
    const end = this.pathOffset[fileIndex + 1]! - this.previousPathLength[fileIndex]!

    return this.pathBytes.subarray(start, end)
  }

  previousPathBytesOf(fileIndex: number): Uint8Array | undefined {
    const length = this.previousPathLength[fileIndex]!

    if (length === 0) return undefined

    return this.pathBytes.subarray(this.pathOffset[fileIndex + 1]! - length, this.pathOffset[fileIndex + 1]!)
  }

  pathOf(fileIndex: number): string {
    return pathDecoder.decode(this.pathBytesOf(fileIndex))
  }

  previousPathOf(fileIndex: number): string | undefined {
    const bytes = this.previousPathBytesOf(fileIndex)

    return bytes === undefined ? undefined : pathDecoder.decode(bytes)
  }

  hunkRange(fileIndex: number): { first: number; end: number } {
    return { first: this.firstHunk[fileIndex]!, end: this.firstHunk[fileIndex + 1]! }
  }

  isBinary(fileIndex: number): boolean {
    return (this.flags[fileIndex]! & FileFlag.Binary) !== 0
  }

  totalAdditions(): number {
    return this.additions.reduce((total, count) => total + count, 0)
  }

  totalDeletions(): number {
    return this.deletions.reduce((total, count) => total + count, 0)
  }

  isPathOrdered(): boolean {
    for (let fileIndex = 1; fileIndex < this.fileCount; fileIndex++) {
      if (comparePathBytes(this.pathBytesOf(fileIndex - 1), this.pathBytesOf(fileIndex)) > 0) return false
    }

    return true
  }

  sortedOrder(): Uint32Array {
    if (this.cachedSortedOrder !== undefined) return this.cachedSortedOrder

    const order = new Uint32Array(this.fileCount)
    for (let fileIndex = 0; fileIndex < this.fileCount; fileIndex++) order[fileIndex] = fileIndex

    if (!this.isPathOrdered()) {
      order.sort((left, right) => comparePathBytes(this.pathBytesOf(left), this.pathBytesOf(right)) || left - right)
    }

    this.cachedSortedOrder = order

    return order
  }
}

export class FileTableBuilder {
  fileCount = 0
  hunkCount = 0
  readonly retainedHunks = new Map<number, HunkTable>()
  patchOffset: Float64Array
  patchStartLine: Uint32Array
  firstHunk: Uint32Array
  pathOffset: Uint32Array
  pathBytes = new Uint8Array(INITIAL_PATH_CAPACITY)

  constructor(
    patchByteLength = 0,
    private readonly isRecordingHunks = false,
  ) {
    const files = estimatedCapacity(patchByteLength, PATCH_BYTES_PER_FILE_ESTIMATE, INITIAL_FILE_CAPACITY)
    const hunks = isRecordingHunks ? estimatedCapacity(patchByteLength, PATCH_BYTES_PER_HUNK_ESTIMATE, INITIAL_HUNK_CAPACITY) : 0

    this.patchOffset = new Float64Array(files)
    this.patchStartLine = new Uint32Array(files)
    this.firstHunk = new Uint32Array(files)
    this.pathOffset = new Uint32Array(files)
    this.previousPathLength = new Uint32Array(files)
    this.status = new Uint8Array(files)
    this.flags = new Uint8Array(files)
    this.additions = new Uint32Array(files)
    this.deletions = new Uint32Array(files)
    this.rowCount = new Uint32Array(files)
    this.reviewKey = new Float64Array(files)
    this.hunkOffset = new Float64Array(hunks)
    this.hunkOldStart = new Uint32Array(hunks)
    this.hunkOldLines = new Uint32Array(hunks)
    this.hunkNewStart = new Uint32Array(hunks)
    this.hunkNewLines = new Uint32Array(hunks)
    this.hunkRowCount = new Uint32Array(hunks)
  }
  previousPathLength: Uint32Array
  status: Uint8Array
  flags: Uint8Array
  additions: Uint32Array
  deletions: Uint32Array
  rowCount: Uint32Array
  reviewKey: Float64Array
  hunkOffset: Float64Array
  hunkOldStart: Uint32Array
  hunkOldLines: Uint32Array
  hunkNewStart: Uint32Array
  hunkNewLines: Uint32Array
  hunkRowCount: Uint32Array

  addHunk(offset: number, oldStart: number, oldLines: number, newStart: number, newLines: number): number {
    const index = this.hunkCount
    this.hunkCount = index + 1

    if (!this.isRecordingHunks) return index

    if (index >= this.hunkOffset.length) {
      this.hunkOffset = grown(this.hunkOffset, index + 1)
      this.hunkOldStart = grown(this.hunkOldStart, index + 1)
      this.hunkOldLines = grown(this.hunkOldLines, index + 1)
      this.hunkNewStart = grown(this.hunkNewStart, index + 1)
      this.hunkNewLines = grown(this.hunkNewLines, index + 1)
      this.hunkRowCount = grown(this.hunkRowCount, index + 1)
    }

    this.hunkOffset[index] = offset
    this.hunkOldStart[index] = oldStart
    this.hunkOldLines[index] = oldLines
    this.hunkNewStart[index] = newStart
    this.hunkNewLines[index] = newLines

    return index
  }

  setHunkRowCount(hunkIndex: number, rowCount: number): void {
    if (this.isRecordingHunks) this.hunkRowCount[hunkIndex] = rowCount
  }

  resetHunks(): void {
    this.hunkCount = 0
  }

  copyOfHunks(): HunkTable {
    const hunks = this.buildHunks()

    return new HunkTable(hunks.count, hunks.offset.slice(), hunks.oldStart.slice(), hunks.oldLines.slice(), hunks.newStart.slice(), hunks.newLines.slice(), hunks.rowCount.slice())
  }

  buildHunks(): HunkTable {
    const count = this.hunkCount

    return new HunkTable(
      count,
      this.hunkOffset.subarray(0, count),
      this.hunkOldStart.subarray(0, count),
      this.hunkOldLines.subarray(0, count),
      this.hunkNewStart.subarray(0, count),
      this.hunkNewLines.subarray(0, count),
      this.hunkRowCount.subarray(0, count),
    )
  }

  addFile(entry: FileTableEntry): void {
    const index = this.fileCount
    const previousLength = entry.previousPath === undefined ? 0 : entry.previousPath.length
    const pathStart = this.pathOffset[index]!
    const pathEnd = pathStart + entry.path.length + previousLength

    if (index + 1 >= this.patchOffset.length) {
      this.patchOffset = grown(this.patchOffset, index + 2)
      this.patchStartLine = grown(this.patchStartLine, index + 2)
      this.firstHunk = grown(this.firstHunk, index + 2)
      this.pathOffset = grown(this.pathOffset, index + 2)
      this.previousPathLength = grown(this.previousPathLength, index + 2)
      this.status = grown(this.status, index + 2)
      this.flags = grown(this.flags, index + 2)
      this.additions = grown(this.additions, index + 2)
      this.deletions = grown(this.deletions, index + 2)
      this.rowCount = grown(this.rowCount, index + 2)
      this.reviewKey = grown(this.reviewKey, index + 2)
    }

    if (pathEnd > this.pathBytes.length) this.pathBytes = grown(this.pathBytes, pathEnd)

    this.pathBytes.set(entry.path, pathStart)
    if (entry.previousPath !== undefined) this.pathBytes.set(entry.previousPath, pathStart + entry.path.length)

    this.patchOffset[index] = entry.patchOffset
    this.patchStartLine[index] = entry.patchStartLine
    this.firstHunk[index] = entry.firstHunk
    this.pathOffset[index + 1] = pathEnd
    this.previousPathLength[index] = previousLength
    this.status[index] = entry.status
    this.flags[index] = entry.flags
    this.additions[index] = entry.additions
    this.deletions[index] = entry.deletions
    this.rowCount[index] = entry.rowCount
    this.reviewKey[index] = entry.reviewKey
    this.fileCount = index + 1
  }

  build(patchByteLength: number, patchLineCount: number): FileTable {
    return new FileTable(this, patchByteLength, patchLineCount)
  }
}
