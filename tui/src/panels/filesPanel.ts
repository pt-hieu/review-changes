import type { ReviewApp } from '../view/appState.ts'
import { clippedTail } from '../view/box.ts'
import { applyStyle, displayWidth, fitToWidth, joinDisplayText, paddingOf, sanitizeLine, sliceColumns, trustedLiteral, type DisplayText } from '../text/sanitize.ts'
import { FileStatusCode, StyleRole } from '../types.ts'
import { compactCount } from './listPanel.ts'

const STATUS_LETTERS: Record<FileStatusCode, string> = {
  [FileStatusCode.Modified]: 'M',
  [FileStatusCode.Added]: 'A',
  [FileStatusCode.Removed]: 'D',
  [FileStatusCode.Renamed]: 'R',
  [FileStatusCode.Copied]: 'C',
}

function basename(path: string): string {
  const slash = path.lastIndexOf('/')

  return slash === -1 ? path : path.slice(slash + 1)
}

export function filesPanelRows(app: ReviewApp, width: number, height: number, isFocused: boolean): DisplayText[] {
  const { theme, table, fileList } = app
  const rows: DisplayText[] = []
  const isFlat = app.isShowingFlatList

  for (let offset = 0; offset < height && app.filesList.scroll + offset < fileList.count; offset++) {
    const position = app.filesList.scroll + offset
    const isCursor = position === app.filesList.cursor
    const fileIndex = fileList.fileAt(position)
    const indent = paddingOf(fileList.depthAt(position) * 2)
    let line: DisplayText

    if (fileIndex < 0) {
      const key = fileList.directoryKeyAt(position)!
      const arrow = app.collapsedDirectories.has(key) ? '▸' : '▾'
      const name = sanitizeLine(fileList.directoryNameAt(position)!).text
      const count = trustedLiteral(` ${fileList.directoryFileCountAt(position)}`)
      const body = joinDisplayText([indent, trustedLiteral(`${arrow} `), sliceColumns(name, 0, Math.max(1, width - 4 - indent.length)), trustedLiteral('/')])

      line = joinDisplayText([applyStyle(theme.role[StyleRole.Title], body), applyStyle(theme.role[StyleRole.Muted], count)])
    } else {
      const reviewed = app.isFileReviewed(fileIndex)
      const status = STATUS_LETTERS[table.status[fileIndex] as FileStatusCode] ?? '?'
      const statusRole =
        table.status[fileIndex] === FileStatusCode.Added
          ? StyleRole.Addition
          : table.status[fileIndex] === FileStatusCode.Removed
            ? StyleRole.Deletion
            : StyleRole.Muted
      const statsRaw = `+${compactCount(table.additions[fileIndex]!)} -${compactCount(table.deletions[fileIndex]!)}`
      const critical = app.isFileCritical(fileIndex)
      const tail = ` ${statsRaw}${critical ? ' !' : ''}`
      const path = table.pathOf(fileIndex)
      const label = sanitizeLine(isFlat ? path : basename(path)).text
      const fixed = indent.length + 4 + tail.length
      const nameBudget = Math.max(4, width - fixed)
      const name = isFlat ? clippedTail(label, nameBudget) : sliceColumns(label, 0, nameBudget)
      const gap = Math.max(0, width - fixed - displayWidth(name))
      const mark = reviewed ? applyStyle(theme.role[StyleRole.Reviewed], trustedLiteral('✓')) : trustedLiteral(' ')

      line = joinDisplayText([
        indent,
        mark,
        trustedLiteral(' '),
        applyStyle(theme.role[statusRole], trustedLiteral(status)),
        trustedLiteral(' '),
        reviewed ? applyStyle(theme.role[StyleRole.Muted], name) : name,
        paddingOf(gap),
        applyStyle(theme.role[StyleRole.Muted], trustedLiteral(tail.replace(' !', ''))),
        critical ? applyStyle(theme.role[StyleRole.Critical], trustedLiteral(' !')) : trustedLiteral(''),
      ])
    }

    const style = isCursor ? theme.role[isFocused ? StyleRole.Selected : StyleRole.Title] : undefined

    rows.push(fitToWidth(style === undefined ? line : applyStyle(style, line), width))
  }

  return rows
}
