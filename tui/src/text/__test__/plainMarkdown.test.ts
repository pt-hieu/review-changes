import { describe, expect, test } from 'bun:test'
import { plainMarkdown } from '../plainMarkdown.ts'

describe('plainMarkdown', () => {
  test('drops bold markers and code ticks but keeps their text', () => {
    expect(plainMarkdown('a **bold** and `code` word')).toBe('a bold and code word')
  })

  test('shows the target of a link next to its text, so a link cannot hide where it goes', () => {
    expect(plainMarkdown('[docs](https://evil.example/phish)')).toBe('docs (https://evil.example/phish)')
  })

  test('shows a link with no text by its target alone', () => {
    expect(plainMarkdown('[](https://a.example)')).toBe(' (https://a.example)')
  })

  test('keeps several links on one line apart', () => {
    expect(plainMarkdown('[a](x) then [b](y)')).toBe('a (x) then b (y)')
  })

  test('leaves unfinished link syntax as written', () => {
    expect(plainMarkdown('[a](b and [c')).toBe('[a](b and [c')
  })

  test('returns empty input unchanged', () => {
    expect(plainMarkdown('')).toBe('')
  })
})
