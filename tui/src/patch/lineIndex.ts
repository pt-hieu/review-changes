import { RowKind } from '../types.ts'
import { HunkTable, type FileTable } from './fileTable.ts'
import { scanFileHunks } from './scanIndex.ts'
import type { PatchReader } from './patchReader.ts'
import { readSync } from 'node:fs'

const SCAN_BUFFER_BYTES = 1024 * 1024
const PROBE_BYTES = 24
const CHECKPOINT_INTERVAL = 256
const MAXIMUM_INDEXED_BYTES = 0xffffffff
const MAXIMUM_CACHED_ROWS = 4_000_000
export const MAXIMUM_ROWS_PER_FILE = 8_000_000
const NEWLINE = 10
const PLUS = 43
const MINUS = 45
const BACKSLASH = 92

const scratchBuffer = Buffer.allocUnsafe(SCAN_BUFFER_BYTES)
const EMPTY_HUNKS = new HunkTable(0, new Float64Array(0), new Uint32Array(0), new Uint32Array(0), new Uint32Array(0), new Uint32Array(0), new Uint32Array(0))
const textDecoder = new TextDecoder('utf-8', { ignoreBOM: true })

export type RowText = { text: string; contentByteLength: number; hasMoreAfter: boolean }

function kindOfFirstByte(first: number | undefined): RowKind {
  if (first === PLUS) return RowKind.Addition
  if (first === MINUS) return RowKind.Deletion
  if (first === BACKSLASH) return RowKind.NoNewline

  return RowKind.Context
}

function isContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80
}

function trimToCharacterBoundaries(bytes: Uint8Array, isStartAligned: boolean, isEndAligned: boolean): Uint8Array {
  let start = 0
  let end = bytes.length

  if (!isStartAligned) {
    while (start < end && start < 3 && isContinuationByte(bytes[start]!)) start++
  }

  if (!isEndAligned) {
    let lead = end - 1
    let continuations = 0

    while (lead > start && continuations < 3 && isContinuationByte(bytes[lead]!)) {
      lead--
      continuations++
    }

    const leadByte = bytes[lead]
    const expected = leadByte === undefined ? 1 : leadByte >= 0xf0 ? 4 : leadByte >= 0xe0 ? 3 : leadByte >= 0xc0 ? 2 : 1

    if (leadByte !== undefined && leadByte >= 0xc0 && continuations + 1 < expected) end = lead
  }

  return bytes.subarray(start, end)
}

export class LineIndex {
  readonly fileIndex: number
  readonly rowCount: number
  readonly isTooLarge: boolean
  readonly totalRowCount: number
  readonly isTruncated: boolean
  readonly hunkFirstRow: Uint32Array
  readonly hunks: HunkTable

  private readonly table: FileTable
  private readonly reader: PatchReader
  private readonly baseOffset: number
  private readonly lineStart: Uint32Array
  private readonly rowKind: Uint8Array
  private readonly checkpointOldLine: Uint32Array
  private readonly checkpointNewLine: Uint32Array
  private readonly lastLineHasNewline: boolean
  private recordedRows = 0
  private completedRows = 0
  private position = 0
  private isSkippingOversizedLine = false
  private hasEnded = false
  private nextHunk = 0
  private oldLine = 0
  private newLine = 0

  constructor(table: FileTable, reader: PatchReader, fileIndex: number) {
    const fileStart = table.patchOffset[fileIndex]!
    const fileEnd = table.patchOffset[fileIndex + 1]!
    const hunks = fileEnd - fileStart > MAXIMUM_INDEXED_BYTES ? EMPTY_HUNKS : (table.retainedHunks.get(fileIndex) ?? scanFileHunks(reader.descriptor, fileStart, fileEnd))
    const hunkFileOffset = hunks.count > 0 ? hunks.offset[0]! : fileEnd

    this.fileIndex = fileIndex
    this.table = table
    this.reader = reader
    this.hunks = hunks
    this.baseOffset = hunkFileOffset
    this.isTooLarge = fileEnd - hunkFileOffset > MAXIMUM_INDEXED_BYTES
    this.totalRowCount = this.isTooLarge ? 0 : table.rowCount[fileIndex]!
    this.isTruncated = this.totalRowCount > MAXIMUM_ROWS_PER_FILE
    this.rowCount = Math.min(this.totalRowCount, MAXIMUM_ROWS_PER_FILE)
    this.lineStart = new Uint32Array(this.rowCount + 1)
    this.rowKind = new Uint8Array(this.rowCount)
    this.checkpointOldLine = new Uint32Array(Math.ceil(this.rowCount / CHECKPOINT_INTERVAL) + 1)
    this.checkpointNewLine = new Uint32Array(this.checkpointOldLine.length)

    const firstRows: number[] = []
    let row = 0

    for (let hunk = 0; hunk < hunks.count && row < this.rowCount; hunk++) {
      firstRows.push(row)
      row += hunks.rowCount[hunk]!
    }

    this.hunkFirstRow = Uint32Array.from(firstRows)

    const lastByte = fileEnd > hunkFileOffset ? reader.readView(fileEnd - 1, 1)[0] : undefined
    this.lastLineHasNewline = lastByte === NEWLINE || this.isTruncated
    this.lineStart[this.rowCount] = this.isTooLarge ? 0 : fileEnd - hunkFileOffset
  }

  get indexedRowCount(): number {
    return this.completedRows
  }

  get isComplete(): boolean {
    return this.completedRows >= this.rowCount || this.hasEnded
  }

  advance(budgetMilliseconds: number): boolean {
    const deadline = performance.now() + budgetMilliseconds

    while (!this.isComplete) {
      if (this.isSkippingOversizedLine) this.skipOversizedLine()
      else this.indexChunk()

      if (performance.now() >= deadline) break
    }

    return this.isComplete
  }

  get regionStart(): number {
    return this.baseOffset
  }

  get indexedByteLimit(): number {
    return this.lineStart[this.completedRows]!
  }

  byteRangeOfRows(firstRow: number, endRow: number): { start: number; length: number } {
    const start = this.lineStart[firstRow]!
    const end = this.lineStart[Math.min(endRow, this.completedRows)]!

    return { start: this.baseOffset + start, length: end - start }
  }

  rowAtOffset(relativeOffset: number): number {
    let low = 0
    let high = Math.max(0, this.completedRows - 1)

    while (low < high) {
      const middle = (low + high + 1) >> 1
      if (this.lineStart[middle]! <= relativeOffset) low = middle
      else high = middle - 1
    }

    return low
  }

  kindAt(row: number): RowKind {
    return this.rowKind[row] as RowKind
  }

  hunkIndexOfRow(row: number): number {
    let low = 0
    let high = this.hunkFirstRow.length - 1

    while (low < high) {
      const middle = (low + high + 1) >> 1
      if (this.hunkFirstRow[middle]! <= row) low = middle
      else high = middle - 1
    }

    return low
  }

  rowOfHunk(hunkIndex: number): number {
    return this.hunkFirstRow[hunkIndex]!
  }

  lineNumbersAt(row: number): { oldLine: number; newLine: number } {
    const checkpoint = Math.floor(row / CHECKPOINT_INTERVAL)
    let oldLine = this.checkpointOldLine[checkpoint]!
    let newLine = this.checkpointNewLine[checkpoint]!

    for (let current = checkpoint * CHECKPOINT_INTERVAL; current < row; current++) {
      const kind = this.rowKind[current] as RowKind

      if (kind === RowKind.HunkHeader) {
        const hunk = this.hunkIndexOfRow(current)
        oldLine = this.hunks.oldStart[hunk]!
        newLine = this.hunks.newStart[hunk]!
      } else if (kind === RowKind.Addition) newLine++
      else if (kind === RowKind.Deletion) oldLine++
      else if (kind === RowKind.Context) {
        oldLine++
        newLine++
      }
    }

    const kind = this.rowKind[row] as RowKind

    if (kind === RowKind.HunkHeader) {
      const hunk = this.hunkIndexOfRow(row)
      return { oldLine: this.hunks.oldStart[hunk]!, newLine: this.hunks.newStart[hunk]! }
    }

    if (kind === RowKind.Addition) return { oldLine: 0, newLine }
    if (kind === RowKind.Deletion) return { oldLine, newLine: 0 }
    if (kind === RowKind.NoNewline) return { oldLine: 0, newLine: 0 }

    return { oldLine, newLine }
  }

  readRow(row: number, startByte: number, maximumBytes: number): RowText {
    const kind = this.rowKind[row] as RowKind
    const lineStartOffset = this.baseOffset + this.lineStart[row]!
    const nextStart = this.baseOffset + this.lineStart[row + 1]!
    const isLastRow = row === this.rowCount - 1
    const lineEnd = isLastRow && !this.lastLineHasNewline ? nextStart : nextStart - 1
    const prefixBytes = kind === RowKind.HunkHeader || lineEnd <= lineStartOffset ? 0 : 1
    const contentStart = lineStartOffset + prefixBytes
    const contentByteLength = Math.max(0, lineEnd - contentStart)
    const windowStart = contentStart + Math.min(startByte, contentByteLength)
    const windowLength = Math.min(maximumBytes, lineEnd - windowStart)
    const hasMoreAfter = windowStart + windowLength < lineEnd
    const bytes = windowLength > 0 ? this.reader.readView(windowStart, windowLength) : new Uint8Array(0)
    const aligned = trimToCharacterBoundaries(bytes, startByte === 0, !hasMoreAfter)

    return { text: textDecoder.decode(aligned), contentByteLength, hasMoreAfter }
  }

  private recordRow(first: number | undefined, startRelative: number): void {
    const row = this.recordedRows
    const isHunkHeader = this.nextHunk < this.hunkFirstRow.length && this.hunkFirstRow[this.nextHunk] === row

    if (row % CHECKPOINT_INTERVAL === 0) {
      this.checkpointOldLine[row / CHECKPOINT_INTERVAL] = this.oldLine
      this.checkpointNewLine[row / CHECKPOINT_INTERVAL] = this.newLine
    }

    this.lineStart[row] = startRelative

    if (isHunkHeader) {
      this.rowKind[row] = RowKind.HunkHeader
      this.oldLine = this.hunks.oldStart[this.nextHunk]!
      this.newLine = this.hunks.newStart[this.nextHunk]!
      this.nextHunk++
    } else {
      const kind = kindOfFirstByte(first)
      this.rowKind[row] = kind

      if (kind === RowKind.Addition) this.newLine++
      else if (kind === RowKind.Deletion) this.oldLine++
      else if (kind === RowKind.Context) {
        this.oldLine++
        this.newLine++
      }
    }

    this.recordedRows = row + 1
  }

  private indexChunk(): void {
    const bytesRead = readSync(this.reader.descriptor, scratchBuffer, 0, scratchBuffer.length, this.baseOffset + this.position)

    if (bytesRead === 0) {
      this.hasEnded = true
      return
    }

    const view = scratchBuffer.subarray(0, bytesRead)
    let cursor = 0

    while (this.recordedRows < this.rowCount && cursor < bytesRead) {
      const probeEnd = cursor + PROBE_BYTES < bytesRead ? cursor + PROBE_BYTES : bytesRead
      let newline = cursor

      while (newline < probeEnd && view[newline] !== NEWLINE) newline++

      if (newline === probeEnd) newline = probeEnd < bytesRead ? view.indexOf(NEWLINE, probeEnd) : -1

      if (newline === -1) break

      this.recordRow(newline > cursor ? view[cursor] : undefined, this.position + cursor)
      this.completedRows = this.recordedRows
      this.lineStart[this.completedRows] = this.position + newline + 1
      cursor = newline + 1
    }

    if (this.recordedRows >= this.rowCount) {
      this.completedRows = this.rowCount
      return
    }

    if (cursor === 0 && bytesRead === scratchBuffer.length) {
      this.recordRow(view[0], this.position)
      this.position += bytesRead
      this.isSkippingOversizedLine = true
      return
    }

    if (cursor === 0 && bytesRead < scratchBuffer.length) {
      this.recordRow(view[0], this.position)
      this.completedRows = this.recordedRows
      this.lineStart[this.completedRows] = this.position + bytesRead
      this.position += bytesRead
      return
    }

    this.position += cursor
  }

  private skipOversizedLine(): void {
    const bytesRead = readSync(this.reader.descriptor, scratchBuffer, 0, scratchBuffer.length, this.baseOffset + this.position)

    if (bytesRead === 0) {
      this.lineStart[this.recordedRows] = this.position
      this.completedRows = this.recordedRows
      this.isSkippingOversizedLine = false
      this.hasEnded = true
      return
    }

    const newline = scratchBuffer.subarray(0, bytesRead).indexOf(NEWLINE)

    if (newline === -1) {
      this.position += bytesRead
      return
    }

    this.position += newline + 1
    this.isSkippingOversizedLine = false
    this.completedRows = this.recordedRows
    this.lineStart[this.completedRows] = this.position
  }
}

export class LineIndexCache {
  private readonly indexes = new Map<number, LineIndex>()
  private cachedRows = 0

  constructor(
    private readonly table: FileTable,
    private readonly reader: PatchReader,
    private readonly maximumRows: number = MAXIMUM_CACHED_ROWS,
  ) {}

  get(fileIndex: number): LineIndex {
    const cached = this.indexes.get(fileIndex)

    if (cached !== undefined) {
      this.indexes.delete(fileIndex)
      this.indexes.set(fileIndex, cached)

      return cached
    }

    const created = new LineIndex(this.table, this.reader, fileIndex)
    this.indexes.set(fileIndex, created)
    this.cachedRows += created.rowCount

    for (const [key, candidate] of this.indexes) {
      if (this.cachedRows <= this.maximumRows) break
      if (key === fileIndex) continue

      this.indexes.delete(key)
      this.cachedRows -= candidate.rowCount
    }

    return created
  }
}
