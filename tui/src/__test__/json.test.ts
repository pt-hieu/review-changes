import { describe, expect, test } from 'bun:test'
import { errorCodeOf, isNonNegativeInteger, isRecord, memberOf, optionalString, stringOr } from '../json.ts'
import { ReviewLineSide } from '../review/types.ts'

describe('isRecord', () => {
  test('accepts a plain object and rejects null, arrays and primitives', () => {
    expect(isRecord({ key: 1 })).toBe(true)
    expect(isRecord(null)).toBe(false)
    expect(isRecord([1])).toBe(false)
    expect(isRecord('text')).toBe(false)
  })
})

describe('memberOf', () => {
  test('returns the enum member a wire string names', () => {
    expect(memberOf(Object.values(ReviewLineSide), 'additions')).toBe(ReviewLineSide.Additions)
  })

  test('returns undefined for a string outside the set or a value of another type', () => {
    expect(memberOf(Object.values(ReviewLineSide), 'sideways')).toBeUndefined()
    expect(memberOf(Object.values(ReviewLineSide), 1)).toBeUndefined()
  })
})

describe('stringOr and optionalString', () => {
  test('keep a string and replace anything else', () => {
    expect(stringOr('kept', 'fallback')).toBe('kept')
    expect(stringOr(7, 'fallback')).toBe('fallback')
    expect(optionalString('kept')).toBe('kept')
    expect(optionalString(null)).toBeUndefined()
  })
})

describe('isNonNegativeInteger', () => {
  test('accepts zero and whole positive numbers only', () => {
    expect(isNonNegativeInteger(0)).toBe(true)
    expect(isNonNegativeInteger(12)).toBe(true)
    expect(isNonNegativeInteger(-1)).toBe(false)
    expect(isNonNegativeInteger(1.5)).toBe(false)
    expect(isNonNegativeInteger('3')).toBe(false)
  })
})

describe('errorCodeOf', () => {
  test('reads the code of a system error', () => {
    expect(errorCodeOf(Object.assign(new Error('missing'), { code: 'ENOENT' }))).toBe('ENOENT')
  })

  test('gives undefined for an error without a code or a thrown non-error', () => {
    expect(errorCodeOf(new Error('plain'))).toBeUndefined()
    expect(errorCodeOf('ENOENT')).toBeUndefined()
  })
})
