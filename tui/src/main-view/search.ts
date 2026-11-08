import type { LineIndex } from '../patch/lineIndex.ts'
import type { PatchReader } from '../patch/patchReader.ts'

const CHUNK_BYTES = 1024 * 1024
const UPPERCASE_START = 0x41
const UPPERCASE_END = 0x5a
const CASE_OFFSET = 0x20

const encoder = new TextEncoder()

export class FileSearch {
  readonly matchRows: number[] = []
  private readonly needle: Uint8Array
  private readonly isCaseSensitive: boolean
  private readonly chunk = Buffer.allocUnsafe(CHUNK_BYTES)
  private position = 0
  private lastMatchRow = -1

  constructor(
    private readonly reader: PatchReader,
    private readonly lineIndex: LineIndex,
    query: string,
  ) {
    this.isCaseSensitive = /[A-Z]/.test(query)
    this.needle = encoder.encode(this.isCaseSensitive ? query : query.toLowerCase())
  }

  get isComplete(): boolean {
    return this.needle.length === 0 || (this.lineIndex.isComplete && this.position >= this.lineIndex.indexedByteLimit)
  }

  advance(budgetMilliseconds: number): boolean {
    const deadline = performance.now() + budgetMilliseconds
    let hasNewMatches = false

    while (!this.isComplete && performance.now() < deadline) {
      const limit = this.lineIndex.indexedByteLimit
      const length = Math.min(CHUNK_BYTES, limit - this.position)

      if (length <= 0) break

      const read = this.reader.readInto(this.chunk, this.lineIndex.regionStart + this.position, length)

      if (read === 0) break

      if (!this.isCaseSensitive) this.fold(read)

      const view = this.chunk.subarray(0, read)
      let found = view.indexOf(this.needle)

      while (found !== -1) {
        const row = this.lineIndex.rowAtOffset(this.position + found)

        if (row > this.lastMatchRow) {
          this.matchRows.push(row)
          this.lastMatchRow = row
          hasNewMatches = true
        }

        found = view.indexOf(this.needle, found + 1)
      }

      const overlap = Math.min(read, this.needle.length - 1)
      const isFinalChunk = this.position + read >= limit

      this.position += isFinalChunk || read <= overlap ? read : read - overlap
    }

    return hasNewMatches
  }

  private fold(length: number): void {
    for (let index = 0; index < length; index++) {
      const byte = this.chunk[index]!
      if (byte >= UPPERCASE_START && byte <= UPPERCASE_END) this.chunk[index] = byte + CASE_OFFSET
    }
  }
}
