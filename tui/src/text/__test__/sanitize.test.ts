import { describe, expect, test } from 'bun:test'
import { displayWidth, sanitizeBlock, sanitizeLine, sliceColumns, trustedLiteral } from '../sanitize.ts'

const ESCAPE = String.fromCharCode(27)

function visibleCharacters(text: string): string {
  return text.replace(new RegExp(`${ESCAPE}\\[[0-9;]*m`, 'g'), '')
}

function hasOnlyOurStyleSequences(text: string): boolean {
  const withoutStyles = text.replace(new RegExp(`${ESCAPE}\\[[0-9;]*m`, 'g'), '')

  return !withoutStyles.includes(ESCAPE)
}

describe('sanitizeLine', () => {
  test('returns plain printable ASCII unchanged with its length as width', () => {
    expect<string>(sanitizeLine('const a = 1;').text).toBe('const a = 1;')
    expect(sanitizeLine('const a = 1;').width).toBe(12)
  })

  test('shows the escape character as a visible picture, defusing OSC 52, CSI and DCS', () => {
    const hostile = `${ESCAPE}]52;c;ZXZpbA==\u0007${ESCAPE}[2J${ESCAPE}Pq${ESCAPE}\\${ESCAPE}_Gx${ESCAPE}\\`
    const { text } = sanitizeLine(hostile)

    expect(hasOnlyOurStyleSequences(text)).toBe(true)
    expect(visibleCharacters(text)).toBe('␛]52;c;ZXZpbA==␇␛[2J␛Pq␛\\␛_Gx␛\\')
  })

  test('replaces C1 controls with an ASCII code point marker', () => {
    expect(visibleCharacters(sanitizeLine('a\u009bb\u0090c').text)).toBe('a<U+009B>b<U+0090>c')
  })

  test('shows DEL and other C0 controls as control pictures', () => {
    expect(visibleCharacters(sanitizeLine('a\u007fb\u0000c\rd').text)).toBe('a␡b␀c␍d')
  })

  test('marks bidirectional overrides and isolates visibly', () => {
    expect(visibleCharacters(sanitizeLine('a‮b⁦c؜d‏e').text)).toBe('a<U+202E>b<U+2066>c<U+061C>d<U+200F>e')
  })

  test('marks invisible characters that a hand list would miss', () => {
    const invisible = ['͏', 'ㅤ', '︀', '\u{e0100}', '\u{e0001}', '⁥', '­', '​', '﻿', '⠀', 'ﾠ', '᠋', '⁪']
    const expected = ['<U+034F>', '<U+3164>', '<U+FE00>', '<U+E0100>', '<U+E0001>', '<U+2065>', '<U+00AD>', '<U+200B>', '<U+FEFF>', '<U+2800>', '<U+FFA0>', '<U+180B>', '<U+206A>']

    invisible.forEach((character, index) => {
      expect(visibleCharacters(sanitizeLine(`a${character}b`).text)).toBe(`a${expected[index]!}b`)
    })
  })

  test('marks a lone surrogate and unassigned code points', () => {
    expect(visibleCharacters(sanitizeLine('a\ud800b').text)).toBe('a<U+D800>b')
    expect(visibleCharacters(sanitizeLine('a͸b').text)).toBe('a<U+0378>b')
  })

  test('drops variation selector 15 and 16 so width stays consistent', () => {
    expect<string>(sanitizeLine('❤️').text).toBe('❤')
    expect<string>(sanitizeLine('x︎y').text).toBe('xy')
  })

  test('drops a joiner between pictographs and marks it elsewhere', () => {
    expect<string>(sanitizeLine('\u{1f468}‍\u{1f469}').text).toBe('\u{1f468}\u{1f469}')
    expect(visibleCharacters(sanitizeLine('a‍b').text)).toBe('a<U+200D>b')
  })

  test('expands tabs to the next multiple of four from the start column', () => {
    expect<string>(sanitizeLine('a\tb').text).toBe('a   b')
    expect<string>(sanitizeLine('\tb').text).toBe('    b')
    expect<string>(sanitizeLine('a\tb', 2).text).toBe('a b')
    expect(sanitizeLine('a\tb').width).toBe(5)
  })

  test('keeps at most three combining marks per base and drops a leading mark', () => {
    const accents = '́̂̃̄̅'

    expect<string>(sanitizeLine(`e${accents}`).text).toBe('é̂̃')
    expect<string>(sanitizeLine(`́e`).text).toBe('e')
    expect(sanitizeLine(`e${accents}`).width).toBe(1)
  })

  test('measures wide characters as two columns', () => {
    expect(sanitizeLine('漢字a').width).toBe(5)
  })

  test('decoding invalid UTF-8 yields only replacement characters that stay visible', () => {
    const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
    const decoded = decoder.decode(Uint8Array.of(0x61, 0xc0, 0x9b, 0x62, 0xe0, 0x80, 0x9b, 0x9b, 0xf8, 0x88, 0x80, 0x80, 0x9b))

    expect(decoded.includes('\u009b')).toBe(false)
    expect(sanitizeLine(decoded).text.includes('\u009b')).toBe(false)
  })

  test('never emits an escape that is not one of its own style sequences, for any control byte', () => {
    let everyCodePoint = ''
    for (let codePoint = 0; codePoint < 0x3000; codePoint++) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue
      everyCodePoint += String.fromCodePoint(codePoint)
    }
    const { text } = sanitizeLine(everyCodePoint)
    const stripped = visibleCharacters(text)

    expect(hasOnlyOurStyleSequences(text)).toBe(true)
    expect(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/.test(stripped)).toBe(false)
  })
})

describe('sliceColumns', () => {
  test('cuts by display columns', () => {
    const { text } = sanitizeLine('abcdef')

    expect<string>(sliceColumns(text, 2, 3)).toBe('cde')
    expect<string>(sliceColumns(text, 4, 10)).toBe('ef')
    expect<string>(sliceColumns(text, 0, 0)).toBe('')
  })

  test('turns a wide character cut by either edge into a space', () => {
    const { text } = sanitizeLine('a漢b')

    expect<string>(sliceColumns(text, 0, 2)).toBe('a ')
    expect<string>(sliceColumns(text, 2, 3)).toBe(' b')
    expect<string>(sliceColumns(text, 1, 2)).toBe('漢')
  })

  test('keeps a control marker styled when the slice starts inside it', () => {
    const { text } = sanitizeLine('a\u202ebcd')
    const slice = sliceColumns(text, 3, 3)

    expect(visibleCharacters(slice)).toBe('+20')
    expect(hasOnlyOurStyleSequences(slice)).toBe(true)
    expect(slice.startsWith(`${ESCAPE}[1;33m`)).toBe(true)
    expect(slice.endsWith(`${ESCAPE}[22;39m`)).toBe(true)
  })

  test('slices are measured by displayWidth', () => {
    const { text, width } = sanitizeLine('x‮y漢')

    expect(displayWidth(text)).toBe(width)
  })
})

describe('sanitizeBlock', () => {
  test('wraps to the width and neutralizes every line', () => {
    const lines = sanitizeBlock(`abcdefgh\n${ESCAPE}[2Jxy`, 4)

    expect(lines.map(visibleCharacters)).toEqual(['abcd', 'efgh', '␛[2J', 'xy'])
    expect(lines.every(hasOnlyOurStyleSequences)).toBe(true)
  })

  test('treats CRLF as a single line break and keeps empty lines', () => {
    expect<string[]>(sanitizeBlock('a\r\n\r\nb', 10)).toEqual(['a', '', 'b'])
  })

  test('never exceeds the width, even with wide characters', () => {
    const lines = sanitizeBlock('漢字漢字漢字', 5)

    expect(lines.every(line => displayWidth(line) <= 5)).toBe(true)
    expect(lines.map(visibleCharacters).join('')).toBe('漢字漢字漢字')
  })
})

describe('trustedLiteral', () => {
  test('accepts box drawing text and rejects control characters', () => {
    expect<string>(trustedLiteral('┌──┐')).toBe('┌──┐')
    expect(() => trustedLiteral(`${ESCAPE}[2J`)).toThrow()
    expect(() => trustedLiteral('a‮b')).toThrow()
  })
})
