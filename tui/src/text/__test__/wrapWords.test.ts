import { describe, expect, test } from 'bun:test'
import { wrapWords } from '../wrapWords.ts'

describe('wrapWords', () => {
  test('breaks between words so that no line is longer than the width', () => {
    expect(wrapWords('the quick brown fox jumps', 10)).toEqual(['the quick', 'brown fox', 'jumps'])
  })

  test('keeps a line that is exactly the width', () => {
    expect(wrapWords('abcd efgh', 9)).toEqual(['abcd efgh'])
    expect(wrapWords('abcd efgh', 8)).toEqual(['abcd', 'efgh'])
  })

  test('leaves a word longer than the width whole on its own line', () => {
    expect(wrapWords('see https://example.com/a/very/long/path now', 10)).toEqual(['see', 'https://example.com/a/very/long/path', 'now'])
  })

  test('keeps paragraph breaks, including blank lines, and accepts CRLF', () => {
    expect(wrapWords('one\r\n\r\ntwo three', 20)).toEqual(['one', '', 'two three'])
  })

  test('gives one empty line for empty input', () => {
    expect(wrapWords('', 10)).toEqual([''])
  })

  test('does not loop or drop text at a width of zero or less', () => {
    expect(wrapWords('a b', 0)).toEqual(['a', 'b'])
    expect(wrapWords('a b', -5)).toEqual(['a', 'b'])
  })

  test('does not interpret control characters in hostile text; it only moves it', () => {
    const hostile = '\u001b]52;c;QUJD\u0007 payload'

    expect(wrapWords(hostile, 80).join(' ')).toBe(hostile)
  })
})
