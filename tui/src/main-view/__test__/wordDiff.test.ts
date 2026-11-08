import { describe, expect, test } from 'bun:test'
import { wordDiff } from '../wordDiff.ts'

describe('wordDiff', () => {
  test('marks only the changed word on both sides', () => {
    const result = wordDiff('const hit = find(query)', 'const words = split(query)')!

    expect(result.oldRanges).toEqual([6, 9, 12, 16])
    expect(result.newRanges).toEqual([6, 11, 14, 19])
  })

  test('identical lines have no changed ranges', () => {
    expect(wordDiff('same line', 'same line')).toEqual({ oldRanges: [], newRanges: [] })
  })

  test('an insertion marks only the inserted text', () => {
    const result = wordDiff('call(a)', 'call(a, b)')!

    expect(result.oldRanges).toEqual([])
    expect(result.newRanges).toEqual([6, 9])
  })

  test('lines over 1000 characters are skipped', () => {
    expect(wordDiff('x'.repeat(1001), 'y')).toBeUndefined()
  })

  test('never splits a surrogate pair at a boundary', () => {
    const result = wordDiff('a\u{1f600}b', 'a\u{1f601}b')!

    expect(result.oldRanges).toEqual([1, 3])
    expect(result.newRanges).toEqual([1, 3])
  })
})
