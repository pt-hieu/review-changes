import type { ReviewApp } from '../view/appState.ts'
import { applyStyle, displayWidth, fitToWidth, joinDisplayText, paddingOf, sanitizeLine, sliceColumns, trustedLiteral, type DisplayText } from '../text/sanitize.ts'
import { StyleRole } from '../types.ts'

export function groupsPanelRows(app: ReviewApp, width: number, height: number, isFocused: boolean): DisplayText[] {
  const { theme } = app
  const rows: DisplayText[] = []
  const entryCount = app.groups.length + 1

  for (let offset = 0; offset < height && app.groupsList.scroll + offset < entryCount; offset++) {
    const position = app.groupsList.scroll + offset
    const isCursor = position === app.groupsList.cursor
    const group = position === 0 ? undefined : app.groups[position - 1]!
    const reviewed = position === 0 ? app.reviewedTotal : app.groupReviewedCounts[position - 1]!
    const total = group === undefined ? app.table.fileCount : group.fileIndexes.length
    const marker = isCursor ? '▸' : ' '
    const critical = group?.critical === true ? '!' : ' '
    const counter = `${reviewed}/${total}`
    const label = sanitizeLine(group === undefined ? 'All files' : group.label).text
    const labelBudget = Math.max(1, width - counter.length - 4)
    const clipped = sliceColumns(label, 0, labelBudget)
    const gap = Math.max(1, width - 3 - displayWidth(clipped) - counter.length)
    const isComplete = reviewed === total && total > 0
    const counterText = applyStyle(theme.role[isComplete ? StyleRole.Reviewed : StyleRole.Muted], trustedLiteral(counter))
    const markers = joinDisplayText([
      trustedLiteral(marker),
      critical === '!' ? applyStyle(theme.role[StyleRole.Critical], trustedLiteral('!')) : trustedLiteral(' '),
      trustedLiteral(' '),
    ])
    const line = joinDisplayText([markers, clipped, paddingOf(gap), counterText])
    const style = isCursor ? theme.role[isFocused ? StyleRole.Selected : StyleRole.Title] : undefined

    rows.push(fitToWidth(style === undefined ? line : applyStyle(style, line), width))
  }

  return rows
}
