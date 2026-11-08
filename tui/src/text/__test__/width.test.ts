import { describe, expect, test } from 'bun:test'
import { sanitizeLine } from '../sanitize.ts'
import { codePointWidth, isCombiningCodePoint } from '../width.ts'

describe('codePointWidth', () => {
  test('ASCII and Latin letters take one column', () => {
    expect([codePointWidth(0x41), codePointWidth(0x7e), codePointWidth(0xe9), codePointWidth(0x4e0)]).toEqual([1, 1, 1, 1])
  })

  test('CJK ideographs, kana, hangul and fullwidth forms take two columns', () => {
    const wide = ['世', 'あ', 'カ', '한', 'Ａ', '，'].map(character => codePointWidth(character.codePointAt(0)!))

    expect(wide).toEqual([2, 2, 2, 2, 2, 2])
  })

  test('emoji and supplementary ideographs take two columns', () => {
    const wide = ['😀', '🚀', '🤖', '\u{20000}'].map(character => codePointWidth(character.codePointAt(0)!))

    expect(wide).toEqual([2, 2, 2, 2])
  })

  test('half-width katakana stay narrow', () => {
    expect(codePointWidth('ｱ'.codePointAt(0)!)).toBe(1)
  })

  test('combining marks take no column, in the narrow and the wide parts of the table', () => {
    expect([codePointWidth(0x300), codePointWidth(0x301), codePointWidth(0x20d0), codePointWidth(0xfe0f)]).toEqual([0, 0, 0, 0])
  })

  test('the first code point below and above a wide range stay narrow', () => {
    expect([codePointWidth(0x10ff), codePointWidth(0x1160), codePointWidth(0x40000)]).toEqual([1, 1, 1])
  })
})

describe('column widths of whole strings', () => {
  test('a decomposed kana with its voiced-sound mark is as wide as the precomposed one', () => {
    expect(sanitizeLine('か\u3099').width).toBe(sanitizeLine('が').width)
    expect(sanitizeLine('が').width).toBe(2)
  })

  test('mixed ASCII, CJK and emoji add up column by column', () => {
    expect(sanitizeLine('ab世界😀').width).toBe(2 + 4 + 2)
  })
})

describe('isCombiningCodePoint', () => {
  test('recognises combining marks only', () => {
    expect([isCombiningCodePoint(0x301), isCombiningCodePoint(0x20d0), isCombiningCodePoint(0x41), isCombiningCodePoint(0x4e16)]).toEqual([true, true, false, false])
  })

  test('treats code points below the first combining block as not combining', () => {
    expect(isCombiningCodePoint(0x2ff)).toBe(false)
  })
})
