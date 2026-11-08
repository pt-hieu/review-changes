import { readSync } from 'node:fs'
import { FileFlag, FileStatusCode } from '../types.ts'
import { FileTableBuilder, type FileTable, type HunkTable } from './fileTable.ts'

const SCAN_BUFFER_BYTES = 1024 * 1024
const PROBE_BYTES = 24
const CAPTURED_LINE_BYTES = 4096
const KEY_HEADER_BYTES = 16 * 1024
const FULL_HASH_HEX_LENGTH = 40
const RETAIN_MINIMUM_FILE_BYTES = 4 * 1024 * 1024
const RETAIN_MINIMUM_BYTES_PER_HUNK = 4096
const RETAIN_MAXIMUM_HUNKS = 4096
const NEWLINE = 10
const SPACE = 32
const PLUS = 43
const MINUS = 45
const AT = 64
const BACKSLASH = 92
const QUOTE = 34
const LETTER_D = 100
const LETTER_B = 66
const LETTER_G = 71
const LETTER_I = 105
const LETTER_N = 110
const LETTER_O = 111
const LETTER_R = 114
const LETTER_C = 99

const encoder = new TextEncoder()
const bytesOf = (text: string): Uint8Array => encoder.encode(text)

const DIFF_PREFIX = bytesOf('diff --git ')
const HUNK_PREFIX = bytesOf('@@ ')
const NEW_FILE_PREFIX = bytesOf('new file mode')
const DELETED_FILE_PREFIX = bytesOf('deleted file mode')
const OLD_MODE_PREFIX = bytesOf('old mode')
const NEW_MODE_PREFIX = bytesOf('new mode')
const INDEX_PREFIX = bytesOf('index ')
const RENAME_FROM_PREFIX = bytesOf('rename from ')
const RENAME_TO_PREFIX = bytesOf('rename to ')
const COPY_FROM_PREFIX = bytesOf('copy from ')
const COPY_TO_PREFIX = bytesOf('copy to ')
const MINUS_PREFIX = bytesOf('--- ')
const PLUS_PREFIX = bytesOf('+++ ')
const BINARY_FILES_PREFIX = bytesOf('Binary files ')
const BINARY_PATCH_LINE = bytesOf('GIT binary patch')
const DEV_NULL = bytesOf('/dev/null')
const OLD_SIDE_PREFIX = bytesOf('a/')
const NEW_SIDE_PREFIX = bytesOf('b/')
const SPACE_QUOTED_NEW_SIDE = bytesOf(' "b/')
const SPACE_NEW_SIDE = bytesOf(' b/')

const C_ESCAPES: Record<number, number> = { 97: 7, 98: 8, 116: 9, 110: 10, 118: 11, 102: 12, 114: 13, 34: 34, 92: 92 }

export type ScanOptions = { seed: number }

type ScanRange = { startOffset: number; endOffset: number; isRecordingHunks: boolean }

function startsWith(bytes: Uint8Array, start: number, end: number, prefix: Uint8Array): boolean {
  if (end - start < prefix.length) return false

  for (let index = 0; index < prefix.length; index++) {
    if (bytes[start + index] !== prefix[index]) return false
  }

  return true
}

function equalsBytes(bytes: Uint8Array, expected: Uint8Array): boolean {
  if (bytes.length !== expected.length) return false

  return startsWith(bytes, 0, bytes.length, expected)
}

function lastIndexOfBytes(bytes: Uint8Array, needle: Uint8Array): number {
  for (let start = bytes.length - needle.length; start >= 0; start--) {
    if (startsWith(bytes, start, bytes.length, needle)) return start
  }

  return -1
}

export function unquoteGitPathBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 2 || bytes[0] !== QUOTE || bytes[bytes.length - 1] !== QUOTE) return bytes

  const output: number[] = []

  for (let index = 1; index < bytes.length - 1; index++) {
    const byte = bytes[index]!

    if (byte !== BACKSLASH) {
      output.push(byte)
      continue
    }

    const next = bytes[index + 1] ?? BACKSLASH
    const isOctal = next >= 48 && next <= 55 && index + 3 < bytes.length - 1
    const second = bytes[index + 2]
    const third = bytes[index + 3]

    if (isOctal && second !== undefined && third !== undefined && second >= 48 && second <= 55 && third >= 48 && third <= 55) {
      output.push(((next - 48) << 6) | ((second - 48) << 3) | (third - 48))
      index += 3
    } else {
      output.push(C_ESCAPES[next] ?? next)
      index++
    }
  }

  return Uint8Array.from(output)
}

function stripTrailingTab(bytes: Uint8Array): Uint8Array {
  return bytes.length > 0 && bytes[bytes.length - 1] === 9 ? bytes.subarray(0, bytes.length - 1) : bytes
}

function sidePathOf(value: Uint8Array, prefix: Uint8Array): Uint8Array | undefined {
  const path = unquoteGitPathBytes(stripTrailingTab(value))

  if (equalsBytes(path, DEV_NULL)) return undefined

  return startsWith(path, 0, path.length, prefix) ? path.subarray(prefix.length) : path
}

function splitDiffLinePaths(rest: Uint8Array): { oldPath: Uint8Array; newPath: Uint8Array } {
  if (rest[0] === QUOTE) {
    let closing = 1
    while (closing < rest.length && rest[closing] !== QUOTE) closing += rest[closing] === BACKSLASH ? 2 : 1

    const oldToken = rest.subarray(0, closing + 1)
    const newToken = rest.subarray(closing + 2)

    return { oldPath: stripSide(oldToken, OLD_SIDE_PREFIX), newPath: stripSide(newToken, NEW_SIDE_PREFIX) }
  }

  if (rest[rest.length - 1] === QUOTE) {
    const separator = lastIndexOfBytes(rest, SPACE_QUOTED_NEW_SIDE)

    if (separator !== -1) {
      return {
        oldPath: stripSide(rest.subarray(0, separator), OLD_SIDE_PREFIX),
        newPath: stripSide(rest.subarray(separator + 1), NEW_SIDE_PREFIX),
      }
    }
  }

  const half = (rest.length - 1) / 2

  if (Number.isInteger(half) && rest[half] === SPACE) {
    const left = rest.subarray(0, half)
    const right = rest.subarray(half + 1)
    const isSamePath =
      startsWith(left, 0, left.length, OLD_SIDE_PREFIX) &&
      startsWith(right, 0, right.length, NEW_SIDE_PREFIX) &&
      equalsBytes(left.subarray(2), right.subarray(2))

    if (isSamePath) return { oldPath: left.subarray(2), newPath: right.subarray(2) }
  }

  const separator = lastIndexOfBytes(rest, SPACE_NEW_SIDE)

  if (separator === -1) return { oldPath: rest, newPath: rest }

  return {
    oldPath: stripSide(rest.subarray(0, separator), OLD_SIDE_PREFIX),
    newPath: rest.subarray(separator + 3),
  }
}

function stripSide(token: Uint8Array, prefix: Uint8Array): Uint8Array {
  const path = unquoteGitPathBytes(token)

  return startsWith(path, 0, path.length, prefix) ? path.subarray(prefix.length) : path
}

function parseUnsigned(bytes: Uint8Array, start: number, end: number): { value: number; next: number } {
  let value = 0
  let next = start

  while (next < end) {
    const digit = bytes[next]! - 48
    if (digit < 0 || digit > 9) break
    value = value * 10 + digit
    next++
  }

  return { value, next }
}

class PatchScanner {
  private readonly builder: FileTableBuilder
  private readonly retainer: FileTableBuilder | undefined
  private readonly keyBuffer = Buffer.allocUnsafe(KEY_HEADER_BYTES)
  private keyLength = 0
  private lineNumber = 0

  private isFileOpen = false
  private fileOffset = 0
  private fileLine = 0
  private fileFirstHunk = 0
  private fileStatus = FileStatusCode.Modified
  private fileFlags = 0
  private fileAdditions = 0
  private fileDeletions = 0
  private fileRows = 0
  private fileHunks = 0
  private sawMode = false
  private sawIndex = false
  private diffLine: Uint8Array | undefined
  private minusValue: Uint8Array | undefined
  private plusValue: Uint8Array | undefined
  private renameFrom: Uint8Array | undefined
  private renameTo: Uint8Array | undefined
  private copyFrom: Uint8Array | undefined
  private copyTo: Uint8Array | undefined

  private isInsideHunk = false
  private oldRemaining = 0
  private newRemaining = 0
  private hunkIndex = 0
  private hunkRows = 0

  private isInsideOversizedLine = false

  constructor(
    private readonly fileDescriptor: number,
    private readonly range: ScanRange,
    private readonly seed: number,
  ) {
    this.builder = new FileTableBuilder(range.endOffset - range.startOffset, range.isRecordingHunks)
    this.retainer = range.isRecordingHunks ? undefined : new FileTableBuilder(0, true)
  }

  runHunks(): HunkTable {
    this.run()

    return this.builder.buildHunks()
  }

  run(): FileTable {
    const buffer = Buffer.allocUnsafe(SCAN_BUFFER_BYTES)
    let filled = 0
    let base = this.range.startOffset

    for (;;) {
      const wanted = Math.min(buffer.length - filled, this.range.endOffset - base - filled)
      const bytesRead = wanted <= 0 ? 0 : readSync(this.fileDescriptor, buffer, filled, wanted, base + filled)

      if (bytesRead === 0) break

      filled += bytesRead
      const view = buffer.subarray(0, filled)
      let lineStart = 0

      if (this.isInsideOversizedLine) {
        const newline = view.indexOf(NEWLINE)

        if (newline === -1) {
          base += filled
          filled = 0
          continue
        }

        this.isInsideOversizedLine = false
        lineStart = newline + 1
      }

      while (lineStart < filled) {
        const probeEnd = lineStart + PROBE_BYTES < filled ? lineStart + PROBE_BYTES : filled
        let newline = lineStart

        while (newline < probeEnd && view[newline] !== NEWLINE) newline++

        if (newline === probeEnd) newline = probeEnd < filled ? view.indexOf(NEWLINE, probeEnd) : -1

        if (newline === -1) break

        this.handleLine(view, lineStart, newline, base + lineStart, false)
        lineStart = newline + 1
      }

      if (lineStart === 0 && filled === buffer.length) {
        this.handleLine(view, 0, filled, base, true)
        this.isInsideOversizedLine = true
        base += filled
        filled = 0
        continue
      }

      if (lineStart > 0) buffer.copy(buffer, 0, lineStart, filled)

      base += lineStart
      filled -= lineStart
    }

    if (filled > 0 && !this.isInsideOversizedLine) this.handleLine(buffer, 0, filled, base, false)

    this.finishFile(this.range.endOffset)

    return this.builder.build(this.range.endOffset, this.lineNumber)
  }

  private handleLine(bytes: Uint8Array, start: number, end: number, offset: number, isTruncated: boolean): void {
    const lineNumber = this.lineNumber++

    if (this.isInsideHunk) {
      const first = start < end ? bytes[start]! : SPACE

      if (this.oldRemaining > 0 || this.newRemaining > 0) {
        if (first === PLUS) {
          this.fileAdditions++
          this.hunkRows++
          if (this.newRemaining > 0) this.newRemaining--
          return
        }

        if (first === SPACE) {
          this.hunkRows++
          if (this.oldRemaining > 0) this.oldRemaining--
          if (this.newRemaining > 0) this.newRemaining--
          return
        }

        if (first === MINUS) {
          this.fileDeletions++
          this.hunkRows++
          if (this.oldRemaining > 0) this.oldRemaining--
          return
        }
      }

      if (first === BACKSLASH) {
        this.hunkRows++
        return
      }

      this.closeHunk()
    }

    if (start === end) return

    const first = bytes[start]!

    if (first === LETTER_D && startsWith(bytes, start, end, DIFF_PREFIX)) {
      this.finishFile(offset)
      this.beginFile(bytes, start, end, offset, lineNumber, isTruncated)
      return
    }

    if (!this.isFileOpen) return

    if (first === AT && startsWith(bytes, start, end, HUNK_PREFIX)) {
      this.openHunk(bytes, start, end, offset)
      return
    }

    if (this.fileHunks === 0 && (this.fileFlags & FileFlag.Binary) === 0) this.handleHeaderLine(bytes, start, end, first)
  }

  private beginFile(bytes: Uint8Array, start: number, end: number, offset: number, lineNumber: number, isTruncated: boolean): void {
    const capturedEnd = Math.min(end, start + CAPTURED_LINE_BYTES)

    this.isFileOpen = true
    this.fileOffset = offset
    this.fileLine = lineNumber
    this.fileFirstHunk = this.builder.hunkCount
    this.retainer?.resetHunks()
    this.fileStatus = FileStatusCode.Modified
    this.fileFlags = isTruncated || capturedEnd < end ? FileFlag.PathTruncated : 0
    this.fileAdditions = 0
    this.fileDeletions = 0
    this.fileRows = 0
    this.fileHunks = 0
    this.sawMode = false
    this.sawIndex = false
    this.diffLine = Uint8Array.prototype.slice.call(bytes, start + DIFF_PREFIX.length, capturedEnd)
    this.minusValue = undefined
    this.plusValue = undefined
    this.renameFrom = undefined
    this.renameTo = undefined
    this.copyFrom = undefined
    this.copyTo = undefined
    this.keyLength = 0
    this.appendKeyBytes(bytes, start, end)
  }

  private appendKeyBytes(bytes: Uint8Array, start: number, end: number): void {
    const available = KEY_HEADER_BYTES - this.keyLength

    if (available <= 0) return

    const length = Math.min(end - start, available - 1)
    this.keyBuffer.set(bytes.subarray(start, start + length), this.keyLength)
    this.keyBuffer[this.keyLength + length] = NEWLINE
    this.keyLength += length + 1
  }

  private captureValue(bytes: Uint8Array, valueStart: number, end: number): Uint8Array {
    return Uint8Array.prototype.slice.call(bytes, valueStart, Math.min(end, valueStart + CAPTURED_LINE_BYTES))
  }

  private handleHeaderLine(bytes: Uint8Array, start: number, end: number, first: number): void {
    this.appendKeyBytes(bytes, start, end)

    if (first === LETTER_N) {
      if (startsWith(bytes, start, end, NEW_FILE_PREFIX)) this.fileStatus = FileStatusCode.Added
      else if (startsWith(bytes, start, end, NEW_MODE_PREFIX)) this.sawMode = true
    } else if (first === LETTER_D) {
      if (startsWith(bytes, start, end, DELETED_FILE_PREFIX)) this.fileStatus = FileStatusCode.Removed
    } else if (first === LETTER_O) {
      if (startsWith(bytes, start, end, OLD_MODE_PREFIX)) this.sawMode = true
    } else if (first === LETTER_I) {
      if (startsWith(bytes, start, end, INDEX_PREFIX)) this.readIndexLine(bytes, start, end)
    } else if (first === LETTER_R) {
      if (startsWith(bytes, start, end, RENAME_FROM_PREFIX)) {
        this.renameFrom = this.captureValue(bytes, start + RENAME_FROM_PREFIX.length, end)
        this.fileStatus = FileStatusCode.Renamed
      } else if (startsWith(bytes, start, end, RENAME_TO_PREFIX)) {
        this.renameTo = this.captureValue(bytes, start + RENAME_TO_PREFIX.length, end)
      }
    } else if (first === LETTER_C) {
      if (startsWith(bytes, start, end, COPY_FROM_PREFIX)) {
        this.copyFrom = this.captureValue(bytes, start + COPY_FROM_PREFIX.length, end)
        this.fileStatus = FileStatusCode.Copied
      } else if (startsWith(bytes, start, end, COPY_TO_PREFIX)) {
        this.copyTo = this.captureValue(bytes, start + COPY_TO_PREFIX.length, end)
      }
    } else if (first === MINUS) {
      if (startsWith(bytes, start, end, MINUS_PREFIX)) this.minusValue = this.captureValue(bytes, start + MINUS_PREFIX.length, end)
    } else if (first === PLUS) {
      if (startsWith(bytes, start, end, PLUS_PREFIX)) this.plusValue = this.captureValue(bytes, start + PLUS_PREFIX.length, end)
    } else if (first === LETTER_B) {
      if (startsWith(bytes, start, end, BINARY_FILES_PREFIX)) this.fileFlags |= FileFlag.Binary
    } else if (first === LETTER_G) {
      if (startsWith(bytes, start, end, BINARY_PATCH_LINE)) this.fileFlags |= FileFlag.Binary
    }
  }

  private readIndexLine(bytes: Uint8Array, start: number, end: number): void {
    const hashStart = start + INDEX_PREFIX.length
    let cursor = hashStart

    while (cursor < end && bytes[cursor] !== 46) cursor++

    this.sawIndex = true

    if (cursor - hashStart < FULL_HASH_HEX_LENGTH) this.fileFlags |= FileFlag.AbbreviatedIndex
  }

  private openHunk(bytes: Uint8Array, start: number, end: number, offset: number): void {
    let cursor = start + HUNK_PREFIX.length + 1
    const oldStart = parseUnsigned(bytes, cursor, end)
    cursor = oldStart.next
    let oldLines = 1

    if (bytes[cursor] === 44) {
      const parsed = parseUnsigned(bytes, cursor + 1, end)
      oldLines = parsed.value
      cursor = parsed.next
    }

    cursor += 2
    const newStart = parseUnsigned(bytes, cursor, end)
    cursor = newStart.next
    let newLines = 1

    if (bytes[cursor] === 44) {
      const parsed = parseUnsigned(bytes, cursor + 1, end)
      newLines = parsed.value
    }

    this.hunkIndex = this.builder.addHunk(offset, oldStart.value, oldLines, newStart.value, newLines)
    if (this.fileHunks < RETAIN_MAXIMUM_HUNKS) this.retainer?.addHunk(offset, oldStart.value, oldLines, newStart.value, newLines)
    this.hunkRows = 1
    this.oldRemaining = oldLines
    this.newRemaining = newLines
    this.isInsideHunk = true
    this.fileHunks++
  }

  private closeHunk(): void {
    this.builder.setHunkRowCount(this.hunkIndex, this.hunkRows)
    if (this.fileHunks <= RETAIN_MAXIMUM_HUNKS) this.retainer?.setHunkRowCount(this.fileHunks - 1, this.hunkRows)
    this.fileRows += this.hunkRows
    this.isInsideHunk = false
  }

  private finishFile(endOffset: number): void {
    if (this.isInsideHunk) this.closeHunk()

    if (!this.isFileOpen) return

    this.isFileOpen = false

    const fileBytes = endOffset - this.fileOffset
    const isCostlyToRescan = fileBytes >= RETAIN_MINIMUM_FILE_BYTES && this.fileHunks <= RETAIN_MAXIMUM_HUNKS && this.fileHunks * RETAIN_MINIMUM_BYTES_PER_HUNK <= fileBytes
    if (isCostlyToRescan && this.retainer !== undefined) this.builder.retainedHunks.set(this.builder.fileCount, this.retainer.copyOfHunks())

    const diffPaths = splitDiffLinePaths(this.diffLine!)
    const isRemoved = this.fileStatus === FileStatusCode.Removed
    const sidePath = isRemoved
      ? this.minusValue === undefined ? undefined : sidePathOf(this.minusValue, OLD_SIDE_PREFIX)
      : this.plusValue === undefined ? undefined : sidePathOf(this.plusValue, NEW_SIDE_PREFIX)
    const renamedTo = this.renameTo === undefined ? undefined : unquoteGitPathBytes(this.renameTo)
    const copiedTo = this.copyTo === undefined ? undefined : unquoteGitPathBytes(this.copyTo)
    const path = sidePath ?? (isRemoved ? diffPaths.oldPath : renamedTo ?? copiedTo ?? diffPaths.newPath)

    let previousPath: Uint8Array | undefined
    if (this.fileStatus === FileStatusCode.Renamed && this.renameFrom !== undefined) previousPath = unquoteGitPathBytes(this.renameFrom)
    else if (this.fileStatus === FileStatusCode.Copied && this.copyFrom !== undefined) previousPath = unquoteGitPathBytes(this.copyFrom)

    let flags = this.fileFlags
    const isBinary = (flags & FileFlag.Binary) !== 0
    if (this.sawMode && !this.sawIndex && this.fileHunks === 0 && !isBinary && this.fileStatus === FileStatusCode.Modified) flags |= FileFlag.ModeOnly

    const keyHash = Bun.hash(this.keyBuffer.subarray(0, this.keyLength), this.seed)

    this.builder.addFile({
      patchOffset: this.fileOffset,
      patchStartLine: this.fileLine,
      firstHunk: this.fileFirstHunk,
      path,
      previousPath,
      status: this.fileStatus,
      flags,
      additions: this.fileAdditions,
      deletions: this.fileDeletions,
      rowCount: this.fileRows,
      reviewKey: Number(BigInt(keyHash) & 0xfffffffffffffn),
    })
  }
}

export function scanPatch(fileDescriptor: number, byteLength: number, options: ScanOptions): FileTable {
  return new PatchScanner(fileDescriptor, { startOffset: 0, endOffset: byteLength, isRecordingHunks: false }, options.seed).run()
}

export function scanFileHunks(fileDescriptor: number, startOffset: number, endOffset: number): HunkTable {
  return new PatchScanner(fileDescriptor, { startOffset, endOffset, isRecordingHunks: true }, 0).runHunks()
}
