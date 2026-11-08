import type { ReviewApp } from '../view/appState.ts'
import { applyStyle, joinDisplayText, sanitizeLine, trustedLiteral, type DisplayText } from '../text/sanitize.ts'
import { StyleRole } from '../types.ts'
import { compactCount } from './listPanel.ts'

export function reviewPanelRows(app: ReviewApp, isFocused: boolean): DisplayText[] {
  const { session, table, theme } = app
  const first = sanitizeLine(session.title).text
  const counts = trustedLiteral(`${compactCount(table.fileCount)} files `)
  const additions = applyStyle(theme.role[StyleRole.Addition], trustedLiteral(`+${compactCount(table.totalAdditions())}`))
  const deletions = applyStyle(theme.role[StyleRole.Deletion], trustedLiteral(`-${compactCount(table.totalDeletions())}`))
  const firstLine = isFocused ? applyStyle(theme.role[StyleRole.Selected], first) : first

  return [firstLine, joinDisplayText([counts, additions, trustedLiteral(' '), deletions])]
}
