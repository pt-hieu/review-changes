import { describe, expect, test } from 'bun:test'
import { FileTableBuilder } from '../../patch/fileTable.ts'
import { FileStatusCode } from '../../types.ts'
import { PathFilter } from '../filter.ts'

const encoder = new TextEncoder()

function tableOf(paths: string[], previousPaths: Record<string, string> = {}) {
  const builder = new FileTableBuilder()

  for (const path of paths) {
    const previous = previousPaths[path]

    builder.addFile({
      patchOffset: 0,
      patchStartLine: 0,
      firstHunk: 0,
      path: encoder.encode(path),
      previousPath: previous === undefined ? undefined : encoder.encode(previous),
      status: FileStatusCode.Modified,
      flags: 0,
      additions: 0,
      deletions: 0,
      rowCount: 0,
      reviewKey: 0,
    })
  }

  return builder.build(0, 0)
}

function select(paths: string[], query: string, previousPaths: Record<string, string> = {}): string[] {
  const table = tableOf(paths, previousPaths)
  const filter = new PathFilter(table)
  const scope = Int32Array.from(paths.map((_, index) => index))
  const output = new Int32Array(paths.length)
  const count = filter.select(scope, scope.length, query, output)

  return Array.from(output.subarray(0, count), index => paths[index]!)
}

const PATHS = ['src/api/Routes.ts', 'src/notes/search.ts', 'src/notes/store.ts', 'README.md', 'docs/Search.md']

describe('PathFilter', () => {
  test('an empty query keeps everything in scope order', () => {
    expect(select(PATHS, '')).toEqual(PATHS)
  })

  test('matching is a case-insensitive substring match by default', () => {
    expect(select(PATHS, 'search')).toEqual(['src/notes/search.ts', 'docs/Search.md'])
  })

  test('an uppercase letter in a term makes that term case-sensitive', () => {
    expect(select(PATHS, 'Search')).toEqual(['docs/Search.md'])
  })

  test('every space-separated term must match', () => {
    expect(select(PATHS, 'notes .ts')).toEqual(['src/notes/search.ts', 'src/notes/store.ts'])
    expect(select(PATHS, 'notes api')).toEqual([])
  })

  test('a match cannot span two neighbouring paths', () => {
    expect(select(['ab', 'cd'], 'bc')).toEqual([])
  })

  test('only the new path of a rename is searched', () => {
    expect(select(['new/name.ts'], 'old', { 'new/name.ts': 'old/name.ts' })).toEqual([])
    expect(select(['new/name.ts'], 'new')).toEqual(['new/name.ts'])
  })

  test('a query that matches nothing returns nothing', () => {
    expect(select(PATHS, 'zzz')).toEqual([])
  })
})
