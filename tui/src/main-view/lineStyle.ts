import { applyStyle, joinDisplayText, sanitizeLine, type DisplayText, EMPTY_DISPLAY_TEXT } from '../text/sanitize.ts'
import { STYLE_REVERSE, joinStyles, type Theme } from '../terminal/styles.ts'
import { RowKind, StyleRole, SyntaxSlot } from '../types.ts'

export const RUN_STRIDE = 3

function baseStyleOf(kind: RowKind, theme: Theme): string | undefined {
  if (kind === RowKind.Addition) return theme.role[StyleRole.Addition]
  if (kind === RowKind.Deletion) return theme.role[StyleRole.Deletion]

  return undefined
}

function slotAt(runs: Uint32Array, position: number): { slot: SyntaxSlot; isEmphasized: boolean } {
  let slot = SyntaxSlot.Plain
  let isEmphasized = false

  for (let index = 0; index < runs.length; index += RUN_STRIDE) {
    if (runs[index]! > position) break

    slot = runs[index + 1]! as SyntaxSlot
    isEmphasized = runs[index + 2]! === 1
  }

  return { slot, isEmphasized }
}

function isInsideRanges(ranges: readonly number[], position: number): boolean {
  for (let index = 0; index < ranges.length; index += 2) {
    if (position >= ranges[index]! && position < ranges[index + 1]!) return true
  }

  return false
}

export function styledContent(
  raw: string,
  kind: RowKind,
  runs: Uint32Array | undefined,
  emphasis: readonly number[] | undefined,
  theme: Theme,
): { text: DisplayText; width: number } {
  const baseStyle = baseStyleOf(kind, theme)
  const hasRuns = runs !== undefined && runs.length > 0
  const hasEmphasis = emphasis !== undefined && emphasis.length > 0

  if (!hasRuns && !hasEmphasis) {
    const plain = sanitizeLine(raw)

    return baseStyle === undefined || plain.width === 0 ? plain : { text: applyStyle(baseStyle, plain.text), width: plain.width }
  }

  const boundaries = new Set<number>([0, raw.length])

  if (hasRuns) for (let index = 0; index < runs.length; index += RUN_STRIDE) boundaries.add(Math.min(runs[index]!, raw.length))

  if (hasEmphasis) for (const position of emphasis) boundaries.add(Math.min(position, raw.length))

  const sorted = [...boundaries].sort((left, right) => left - right)
  const pieces: DisplayText[] = []
  let column = 0

  for (let index = 0; index + 1 < sorted.length; index++) {
    const start = sorted[index]!
    const end = sorted[index + 1]!
    const piece = sanitizeLine(raw.slice(start, end), column)
    const { slot, isEmphasized } = hasRuns ? slotAt(runs, start) : { slot: SyntaxSlot.Plain, isEmphasized: false }
    const isChanged = isEmphasized || (hasEmphasis && isInsideRanges(emphasis, start))
    let style = slot === SyntaxSlot.Plain && baseStyle !== undefined ? baseStyle : theme.syntax[slot]

    if (isChanged) style = joinStyles(style, STYLE_REVERSE)

    pieces.push(applyStyle(style, piece.text))
    column += piece.width
  }

  return { text: pieces.length === 0 ? EMPTY_DISPLAY_TEXT : joinDisplayText(pieces), width: column }
}
