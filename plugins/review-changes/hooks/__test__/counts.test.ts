import { describe, expect, test } from 'claude-code/testing'

import { countOf, plural, totalLineCounts } from '../counts.ts'

describe('plural', () => {
  test('keeps the noun for exactly one', () => {
    expect(plural(1, 'file')).toBe('file')
  })

  test('adds an s for zero and for many', () => {
    expect(plural(0, 'file')).toBe('files')
    expect(plural(2, 'file')).toBe('files')
    expect(plural(1000, 'commit')).toBe('commits')
  })
})

describe('countOf', () => {
  test('joins the number and the noun in agreement', () => {
    expect(countOf(1, 'group')).toBe('1 group')
    expect(countOf(0, 'group')).toBe('0 groups')
    expect(countOf(12, 'group')).toBe('12 groups')
  })
})

describe('totalLineCounts', () => {
  test('sums additions and deletions across files', () => {
    const files = [
      { additions: 3, deletions: 1 },
      { additions: 8, deletions: 0 },
      { additions: 0, deletions: 20 },
    ]

    expect(totalLineCounts(files)).toEqual({ additions: 11, deletions: 21 })
  })

  test('is zero for no files', () => {
    expect(totalLineCounts([])).toEqual({ additions: 0, deletions: 0 })
  })
})
