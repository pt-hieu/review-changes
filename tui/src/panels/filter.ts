import type { FileTable } from '../patch/fileTable.ts'

const UPPERCASE_START = 0x41
const UPPERCASE_END = 0x5a
const CASE_OFFSET = 0x20

const WARM_UP_ROUNDS = 3
const WARM_UP_FILES = 4000

type Term = { bytes: Uint8Array; isCaseSensitive: boolean }

const encoder = new TextEncoder()

function parseTerms(query: string): Term[] {
  return query
    .split(' ')
    .filter(term => term.length > 0)
    .map(term => {
      const isCaseSensitive = /[A-Z]/.test(term)
      const bytes = encoder.encode(isCaseSensitive ? term : term.toLowerCase())

      return { bytes, isCaseSensitive }
    })
}

function foldedCopy(bytes: Uint8Array): Uint8Array {
  const folded = new Uint8Array(bytes.length)

  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index]!
    folded[index] = byte >= UPPERCASE_START && byte <= UPPERCASE_END ? byte + CASE_OFFSET : byte
  }

  return folded
}

export class PathFilter {
  private readonly table: FileTable
  private readonly resultMask: Uint8Array
  private foldedPaths: Uint8Array | undefined

  constructor(table: FileTable) {
    this.table = table
    this.resultMask = new Uint8Array(table.fileCount)
  }

  warmUp(): void {
    this.folded()

    const unmatchable = parseTerms('\u0001')

    for (let round = 0; round < WARM_UP_ROUNDS; round++) {
      for (let fileIndex = 0; fileIndex < Math.min(this.table.fileCount, WARM_UP_FILES); fileIndex++) this.matchesAll(fileIndex, unmatchable)
    }
  }

  matchMask(query: string): Uint8Array | undefined {
    const terms = parseTerms(query)

    if (terms.length === 0) return undefined

    for (let fileIndex = 0; fileIndex < this.resultMask.length; fileIndex++) {
      this.resultMask[fileIndex] = this.matchesAll(fileIndex, terms) ? 1 : 0
    }

    return this.resultMask
  }

  private matchesAll(fileIndex: number, terms: Term[]): boolean {
    const { pathOffset, previousPathLength } = this.table
    const start = pathOffset[fileIndex]!
    const end = pathOffset[fileIndex + 1]! - previousPathLength[fileIndex]!

    for (const term of terms) {
      if (!containsTerm(term.isCaseSensitive ? this.table.pathBytes : this.folded(), start, end, term.bytes)) return false
    }

    return true
  }

  private folded(): Uint8Array {
    this.foldedPaths ??= foldedCopy(this.table.pathBytes)

    return this.foldedPaths
  }

  select(scope: Int32Array | Uint32Array, scopeLength: number, query: string, output: Int32Array): number {
    const mask = this.matchMask(query)
    let count = 0

    for (let index = 0; index < scopeLength; index++) {
      const fileIndex = scope[index]!

      if (mask === undefined || mask[fileIndex] === 1) output[count++] = fileIndex
    }

    return count
  }
}

function containsTerm(bytes: Uint8Array, start: number, end: number, needle: Uint8Array): boolean {
  const length = needle.length
  const first = needle[0]!

  for (let position = start; position + length <= end; position++) {
    if (bytes[position] !== first) continue

    let offset = 1

    while (offset < length && bytes[position + offset] === needle[offset]) offset++

    if (offset === length) return true
  }

  return false
}
