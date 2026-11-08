import { afterAll, describe, expect, test } from 'bun:test'
import { modifiedFilePatch } from '../../__test__/reviewDirectory.ts'
import { closeScannedPatches, scanText } from '../../__test__/scannedPatch.ts'
import { LineIndex } from '../../patch/lineIndex.ts'
import { FileSearch } from '../search.ts'

const CHUNK_BYTES = 1024 * 1024

afterAll(closeScannedPatches)

function searchFor(patch: string, query: string): FileSearch {
  const { reader, table } = scanText(patch)
  const lineIndex = new LineIndex(table, reader, 0)
  lineIndex.advance(10_000)

  const search = new FileSearch(reader, lineIndex, query)
  search.advance(10_000)

  return search
}

const PATCH = modifiedFilePatch('notes.txt', ['Alpha beta', 'gamma ALPHA', 'delta', 'alpha alpha', 'héllo wörld'])

describe('FileSearch', () => {
  test('a lowercase query ignores case and finds each matching row once', () => {
    const search = searchFor(PATCH, 'alpha')

    expect(search.matchRows).toEqual([1, 2, 4])
    expect(search.isComplete).toBe(true)
  })

  test('a query with an uppercase letter matches case exactly', () => {
    expect(searchFor(PATCH, 'ALPHA').matchRows).toEqual([2])
    expect(searchFor(PATCH, 'Alpha').matchRows).toEqual([1])
  })

  test('finds non-ASCII text', () => {
    expect(searchFor(PATCH, 'wörld').matchRows).toEqual([5])
  })

  test('finds nothing, and completes, when the text is absent', () => {
    const search = searchFor(PATCH, 'zeta')

    expect(search.matchRows).toEqual([])
    expect(search.isComplete).toBe(true)
  })

  test('an empty query has no matches and is complete at once', () => {
    const { reader, table } = scanText(PATCH)
    const search = new FileSearch(reader, new LineIndex(table, reader, 0), '')

    expect(search.isComplete).toBe(true)
    expect(search.advance(10)).toBe(false)
    expect(search.matchRows).toEqual([])
  })

  test('finds a match that straddles the internal read boundary', () => {
    const needle = 'straddling-needle'
    const header = '@@ -0,0 +1,2 @@\n'
    const needleStart = CHUNK_BYTES - 6
    const fillerLength = needleStart - header.length - '+'.length - 2
    const patch = `${modifiedFilePatch('big.txt', []).split('@@')[0]}${header}+${'f'.repeat(fillerLength)}\n+${needle}\n`

    const search = searchFor(patch, needle)

    expect(search.matchRows).toEqual([2])
  })
})
