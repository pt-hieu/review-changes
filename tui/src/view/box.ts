import { applyStyle, fitToWidth, joinDisplayText, paddingOf, sanitizeLine, sliceColumns, displayWidth, trustedLiteral, type DisplayText } from '../text/sanitize.ts'
import type { Theme } from '../terminal/styles.ts'
import { StyleRole } from '../types.ts'

const HORIZONTAL = '─'
const VERTICAL = '│'
const THUMB = '┃'

export function clippedTail(text: DisplayText, width: number): DisplayText {
  const full = displayWidth(text)

  if (full <= width) return text
  if (width <= 1) return sliceColumns(text, 0, width)

  return joinDisplayText([trustedLiteral('…'), sliceColumns(text, full - (width - 1), width - 1)])
}

export function titleText(raw: string): DisplayText {
  return sanitizeLine(raw).text
}

export type ScrollThumb = { start: number; length: number }

export function renderBox(
  title: DisplayText,
  trailer: DisplayText,
  innerRows: readonly DisplayText[],
  width: number,
  height: number,
  isFocused: boolean,
  theme: Theme,
  thumb?: ScrollThumb,
): DisplayText[] {
  const borderStyle = theme.role[isFocused ? StyleRole.Accent : StyleRole.Muted]
  const border = (character: string): DisplayText => applyStyle(borderStyle, trustedLiteral(character))
  const innerWidth = width - 2
  const trailerWidth = displayWidth(trailer)
  const titleBudget = Math.max(0, innerWidth - trailerWidth - 2)
  const clippedTitle = sliceColumns(title, 0, titleBudget)
  const titleWidth = displayWidth(clippedTitle)
  const fill = Math.max(0, innerWidth - titleWidth - trailerWidth)
  const styledTitle = titleWidth === 0 ? paddingOf(0) : applyStyle(theme.role[isFocused ? StyleRole.Accent : StyleRole.Title], clippedTitle)
  const top = joinDisplayText([
    border('┌'),
    styledTitle,
    border(HORIZONTAL.repeat(fill)),
    trailerWidth === 0 ? paddingOf(0) : applyStyle(borderStyle, trailer),
    border('┐'),
  ])
  const rows: DisplayText[] = [top]

  for (let index = 0; index < height - 2; index++) {
    const inner = innerRows[index]
    const isThumb = thumb !== undefined && index >= thumb.start && index < thumb.start + thumb.length
    const right = border(isThumb ? THUMB : VERTICAL)

    rows.push(joinDisplayText([border(VERTICAL), inner === undefined ? paddingOf(innerWidth) : fitToWidth(inner, innerWidth), right]))
  }

  rows.push(joinDisplayText([border('└'), border(HORIZONTAL.repeat(innerWidth)), border('┘')]))

  return rows
}

export function renderCollapsed(title: DisplayText, width: number, isFocused: boolean, theme: Theme): DisplayText[] {
  return [fitToWidth(applyStyle(theme.role[isFocused ? StyleRole.Accent : StyleRole.Muted], title), width)]
}
