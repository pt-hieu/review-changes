import {
  STYLE_CONTROL_OFF,
  STYLE_CONTROL_ON,
  STYLE_RESET,
  STYLE_WARNING_OFF,
  STYLE_WARNING_ON,
} from '../terminal/styles.ts'
import { codePointWidth, isCombiningCodePoint } from './width.ts'

export type DisplayText = string & { readonly displayTextBrand: unique symbol }

const TAB_WIDTH = 4
const MAXIMUM_COMBINING_MARKS_PER_BASE = 3
const ESCAPE_CODE = 27
const CONTROL_PICTURES_BASE = 0x2400
const DELETE_PICTURE = '␡'
const ZERO_WIDTH_JOINER = 0x200d
const VARIATION_SELECTOR_TEXT = 0xfe0e
const VARIATION_SELECTOR_EMOJI = 0xfe0f

const PLAIN_PRINTABLE_ASCII = /^[\x20-\x7e]*$/
const FORBIDDEN_CLASS = /[\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{Noncharacter_Code_Point}\u2800]/u
const BIDIRECTIONAL_CONTROL = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u
const FORBIDDEN_OR_CONTROL_ANYWHERE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{Noncharacter_Code_Point}\u2800]/u

const STYLE_CLOSERS = new Map<string, string>([
  [STYLE_CONTROL_ON, STYLE_CONTROL_OFF],
  [STYLE_WARNING_ON, STYLE_WARNING_OFF],
])
const STYLE_CLOSING_SEQUENCES = new Set<string>([STYLE_CONTROL_OFF, STYLE_WARNING_OFF])

function asDisplayText(text: string): DisplayText {
  return text as DisplayText
}

function markerOf(codePoint: number): string {
  return `<U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}>`
}

export const EMPTY_DISPLAY_TEXT = asDisplayText('')

export function trustedLiteral(text: string): DisplayText {
  if (FORBIDDEN_OR_CONTROL_ANYWHERE.test(text)) throw new Error('literal contains a control or invisible character')

  return asDisplayText(text)
}

const SGR_SEQUENCE = /^\x1b\[[0-9;]*m$/

export function applyStyle(styleSequence: string, text: DisplayText): DisplayText {
  if (!SGR_SEQUENCE.test(styleSequence)) throw new Error('style must be a single SGR sequence')

  return asDisplayText(styleSequence + text + STYLE_RESET)
}

export function paddingOf(columnCount: number): DisplayText {
  return asDisplayText(' '.repeat(Math.max(0, columnCount)))
}

export function joinDisplayText(parts: readonly DisplayText[]): DisplayText {
  return asDisplayText(parts.join(''))
}

export function sanitizeLine(raw: string, startColumn: number = 0): { text: DisplayText; width: number } {
  if (PLAIN_PRINTABLE_ASCII.test(raw)) return { text: asDisplayText(raw), width: raw.length }

  let output = ''
  let column = startColumn
  let combiningMarks = 0
  let hasBase = false
  let previousWasPictographic = false

  const appendStyled = (styledOn: string, styledOff: string, text: string): void => {
    output += styledOn + text + styledOff
    column += text.length
    hasBase = false
    previousWasPictographic = false
  }

  for (let index = 0; index < raw.length; ) {
    const codePoint = raw.codePointAt(index)!
    const step = codePoint > 0xffff ? 2 : 1
    const character = raw.slice(index, index + step)
    index += step

    if (codePoint >= 0x20 && codePoint < 0x7f) {
      output += character
      column++
      hasBase = true
      combiningMarks = 0
      previousWasPictographic = false
    } else if (codePoint === 9) {
      const spaces = TAB_WIDTH - (column % TAB_WIDTH)
      output += ' '.repeat(spaces)
      column += spaces
      hasBase = true
      combiningMarks = 0
      previousWasPictographic = false
    } else if (codePoint < 0x20) {
      appendStyled(STYLE_CONTROL_ON, STYLE_CONTROL_OFF, String.fromCodePoint(CONTROL_PICTURES_BASE + codePoint))
    } else if (codePoint === 0x7f) {
      appendStyled(STYLE_CONTROL_ON, STYLE_CONTROL_OFF, DELETE_PICTURE)
    } else if (codePoint === VARIATION_SELECTOR_TEXT || codePoint === VARIATION_SELECTOR_EMOJI) {
      continue
    } else if (codePoint === ZERO_WIDTH_JOINER) {
      const next = raw.codePointAt(index)
      const isBetweenPictographs = previousWasPictographic && next !== undefined && PICTOGRAPHIC.test(String.fromCodePoint(next))

      if (!isBetweenPictographs) appendStyled(STYLE_CONTROL_ON, STYLE_CONTROL_OFF, markerOf(codePoint))
    } else if (BIDIRECTIONAL_CONTROL.test(character)) {
      appendStyled(STYLE_WARNING_ON, STYLE_WARNING_OFF, markerOf(codePoint))
    } else if (codePoint < 0xa0 || FORBIDDEN_CLASS.test(character)) {
      appendStyled(STYLE_CONTROL_ON, STYLE_CONTROL_OFF, markerOf(codePoint))
    } else if (isCombiningCodePoint(codePoint)) {
      if (hasBase && combiningMarks < MAXIMUM_COMBINING_MARKS_PER_BASE) {
        output += character
        combiningMarks++
      }
    } else {
      output += character
      column += codePointWidth(codePoint)
      hasBase = true
      combiningMarks = 0
      previousWasPictographic = PICTOGRAPHIC.test(character)
    }
  }

  return { text: asDisplayText(output), width: column - startColumn }
}

type Unit = { end: number; width: number; isStyle: boolean }

function unitAt(text: string, index: number): Unit {
  if (text.charCodeAt(index) === ESCAPE_CODE) {
    const close = text.indexOf('m', index)

    return { end: close === -1 ? text.length : close + 1, width: 0, isStyle: true }
  }

  const codePoint = text.codePointAt(index)!
  let end = index + (codePoint > 0xffff ? 2 : 1)
  let width = codePointWidth(codePoint)

  while (end < text.length) {
    const next = text.codePointAt(end)!

    if (next < 0x300 || !isCombiningCodePoint(next)) break

    end += next > 0xffff ? 2 : 1
  }

  if (width === 0) width = 1

  return { end, width, isStyle: false }
}

export function sliceColumns(text: DisplayText, startColumn: number, columnCount: number): DisplayText {
  if (columnCount <= 0) return EMPTY_DISPLAY_TEXT

  const endColumn = startColumn + columnCount
  let output = ''
  let column = 0
  let activeStyle = ''
  let carriedStyle = ''
  let hasEmittedWindowStyle = false

  for (let index = 0; index < text.length && column < endColumn; ) {
    const unit = unitAt(text, index)
    const piece = text.slice(index, unit.end)
    index = unit.end

    if (unit.isStyle) {
      if (STYLE_CLOSERS.has(piece)) activeStyle = piece
      else if (STYLE_CLOSING_SEQUENCES.has(piece)) activeStyle = ''
      else if (piece === STYLE_RESET) carriedStyle = ''
      else carriedStyle += piece

      if (hasEmittedWindowStyle) output += piece
      continue
    }

    const unitEnd = column + unit.width
    const isInside = column >= startColumn && unitEnd <= endColumn

    if (!hasEmittedWindowStyle && unitEnd > startColumn) {
      hasEmittedWindowStyle = true
      output += carriedStyle + activeStyle
    }

    if (isInside) output += piece
    else if (unitEnd > startColumn && column < endColumn) output += ' '.repeat(Math.min(unitEnd, endColumn) - Math.max(column, startColumn))

    column = unitEnd
  }

  const closer = STYLE_CLOSERS.get(activeStyle)
  if (closer !== undefined && hasEmittedWindowStyle) output += closer
  if (carriedStyle !== '' && hasEmittedWindowStyle) output += STYLE_RESET

  return asDisplayText(output)
}

export function fitToWidth(text: DisplayText, width: number): DisplayText {
  const clipped = sliceColumns(text, 0, width)
  const missing = width - displayWidth(clipped)

  return missing > 0 ? asDisplayText(clipped + ' '.repeat(missing)) : clipped
}

export function displayWidth(text: DisplayText): number {
  let width = 0

  for (let index = 0; index < text.length; ) {
    const unit = unitAt(text, index)
    width += unit.width
    index = unit.end
  }

  return width
}

export function sanitizeBlock(raw: string, width: number): DisplayText[] {
  const lineWidth = Math.max(1, width)
  const lines: DisplayText[] = []

  for (const rawLine of raw.replace(/\r\n/g, '\n').split('\n')) {
    const { text } = sanitizeLine(rawLine)
    let current = ''
    let currentWidth = 0
    let activeStyle = ''

    for (let index = 0; index < text.length; ) {
      const unit = unitAt(text, index)
      const piece = text.slice(index, unit.end)
      index = unit.end

      if (unit.isStyle) {
        if (STYLE_CLOSERS.has(piece)) activeStyle = piece
        else activeStyle = ''
        current += piece
        continue
      }

      if (currentWidth + unit.width > lineWidth && currentWidth > 0) {
        const closer = STYLE_CLOSERS.get(activeStyle)
        lines.push(asDisplayText(current + (closer ?? '')))
        current = activeStyle
        currentWidth = 0
      }

      current += piece
      currentWidth += unit.width
    }

    lines.push(asDisplayText(current))
  }

  return lines
}
