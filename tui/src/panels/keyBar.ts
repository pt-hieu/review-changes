import type { ReviewApp } from '../view/appState.ts'
import { barBindings } from '../view/keymap.ts'
import { applyStyle, displayWidth, fitToWidth, joinDisplayText, paddingOf, sanitizeLine, sliceColumns, trustedLiteral, type DisplayText } from '../text/sanitize.ts'
import { InputMode, StyleRole } from '../types.ts'

export function keyBarRow(app: ReviewApp, width: number, statusText: string): DisplayText {
  const { theme } = app
  const status = sliceColumns(sanitizeLine(statusText).text, 0, Math.max(0, Math.floor(width / 2)))
  const statusWidth = displayWidth(status)
  const available = width - statusWidth - 2
  const parts: DisplayText[] = []
  let used = 0

  if (app.inputMode !== InputMode.None) {
    const prompt = app.inputMode === InputMode.Filter ? '/' : 'search/'
    const query = sanitizeLine(app.inputMode === InputMode.Filter ? app.filterQuery : app.searchQuery).text
    const hint = '  enter keep  esc cancel'

    parts.push(
      applyStyle(theme.role[StyleRole.Accent], trustedLiteral(` ${prompt}`)),
      sliceColumns(query, 0, Math.max(1, available - prompt.length - hint.length - 3)),
      applyStyle(theme.role[StyleRole.Selected], trustedLiteral(' ')),
      applyStyle(theme.role[StyleRole.Muted], trustedLiteral(hint)),
    )
  } else {
    for (const entry of barBindings(app.focus)) {
      const key = ` ${entry.keyLabel}`
      const label = ` ${entry.label}`
      const cost = key.length + label.length + 1

      if (used + cost > available) continue

      parts.push(applyStyle(theme.role[StyleRole.Accent], trustedLiteral(key)), trustedLiteral(label))
      used += cost
    }
  }

  const left = joinDisplayText(parts)
  const gap = Math.max(1, width - displayWidth(left) - statusWidth - 1)

  return fitToWidth(joinDisplayText([left, paddingOf(gap), applyStyle(theme.role[StyleRole.Muted], status), trustedLiteral(' ')]), width)
}
