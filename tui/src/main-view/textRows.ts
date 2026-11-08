import { ReviewVisualChange } from '../review/types.ts'
import type { IndexedAnchor, IndexedGroup, ReviewSession } from '../contract.ts'
import type { FileTable } from '../patch/fileTable.ts'
import { BINDINGS } from '../view/keymap.ts'
import { applyStyle, fitToWidth, joinDisplayText, paddingOf, sanitizeBlock, sanitizeLine, trustedLiteral, EMPTY_DISPLAY_TEXT, type DisplayText } from '../text/sanitize.ts'
import { plainMarkdown } from '../text/plainMarkdown.ts'
import { wrapWords } from '../text/wrapWords.ts'
import type { Theme } from '../terminal/styles.ts'
import { PanelId, StyleRole } from '../types.ts'
import type { RowSource } from './rowSource.ts'

const MAXIMUM_DESCRIPTION_CHARACTERS = 20_000
const MAXIMUM_COMMITS_SHOWN = 100
const MAXIMUM_NOTES_SHOWN = 500

export type BuiltRows = { lines: DisplayText[]; anchors: (IndexedAnchor | undefined)[] }

export class TextRows implements RowSource {
  private built: BuiltRows = { lines: [], anchors: [] }
  private builtWidth = -1

  constructor(private readonly build: (width: number) => BuiltRows) {}

  invalidate(): void {
    this.builtWidth = -1
  }

  prepare(width: number): void {
    if (width === this.builtWidth) return

    this.built = this.build(width)
    this.builtWidth = width
  }

  rowCount(): number {
    return this.built.lines.length
  }

  anchorAt(row: number): IndexedAnchor | undefined {
    return this.built.anchors[row]
  }

  materialize(firstRow: number, count: number, width: number): DisplayText[] {
    this.prepare(width)

    const rows: DisplayText[] = []

    for (let offset = 0; offset < count; offset++) {
      const line = this.built.lines[firstRow + offset]
      rows.push(line === undefined ? paddingOf(width) : fitToWidth(line, width))
    }

    return rows
  }
}

class LineBuilder {
  readonly lines: DisplayText[] = []
  readonly anchors: (IndexedAnchor | undefined)[] = []

  constructor(
    private readonly theme: Theme,
    private readonly width: number,
  ) {}

  blank(): void {
    this.push(EMPTY_DISPLAY_TEXT)
  }

  push(text: DisplayText, anchor?: IndexedAnchor): void {
    this.lines.push(text)
    this.anchors.push(anchor)
  }

  heading(text: string, role: StyleRole = StyleRole.Title): void {
    this.push(applyStyle(this.theme.role[role], sanitizeLine(text).text))
  }

  wrapped(text: string, indent: number = 0, role?: StyleRole): void {
    const lineWidth = Math.max(8, this.width - indent)

    for (const block of wrapWords(plainMarkdown(text), lineWidth).flatMap(line => sanitizeBlock(line, lineWidth))) {
      const body = role === undefined ? block : applyStyle(this.theme.role[role], block)
      this.push(joinDisplayText([paddingOf(indent), body]))
    }
  }

  text(text: string, role?: StyleRole): void {
    const sanitized = sanitizeLine(text).text

    this.push(role === undefined ? sanitized : applyStyle(this.theme.role[role], sanitized))
  }
}

export function buildOverview(
  session: ReviewSession,
  table: FileTable,
  overallSummary: string,
  analysisStatus: string,
  theme: Theme,
  width: number,
): BuiltRows {
  const builder = new LineBuilder(theme, width)

  builder.heading(session.title)
  builder.text(`${session.target.label}  -  ${session.repository.name}`, StyleRole.Muted)
  builder.text(`${table.fileCount} files  +${table.totalAdditions()}  -${table.totalDeletions()}  ${analysisStatus}`, StyleRole.Muted)

  if (overallSummary !== '') {
    builder.blank()
    builder.heading('Summary', StyleRole.Accent)
    builder.wrapped(overallSummary)
  }

  if (session.description !== undefined && session.description !== '') {
    builder.blank()
    builder.heading('Description', StyleRole.Accent)
    builder.wrapped(session.description.slice(0, MAXIMUM_DESCRIPTION_CHARACTERS))
  }

  if (session.commits.length > 0) {
    builder.blank()
    builder.heading(`Commits (${session.commits.length})`, StyleRole.Accent)

    for (const commit of session.commits.slice(0, MAXIMUM_COMMITS_SHOWN)) {
      builder.text(`${commit.sha.slice(0, 7)} ${commit.subject}  (${commit.author})`)
    }
  }

  return { lines: builder.lines, anchors: builder.anchors }
}

export function buildGroupOverview(
  groups: readonly IndexedGroup[],
  overallSummary: string,
  reviewedCounts: Int32Array,
  theme: Theme,
  width: number,
): BuiltRows {
  const builder = new LineBuilder(theme, width)

  builder.heading('All files')

  if (overallSummary !== '') {
    builder.blank()
    builder.wrapped(overallSummary)
  }

  builder.blank()
  builder.heading(`Groups (${groups.length})`, StyleRole.Accent)

  groups.forEach((group, index) => {
    const critical = group.critical === true ? '! ' : '  '
    builder.text(`${critical}[${group.category}] ${group.label}  ${reviewedCounts[index]}/${group.fileIndexes.length}`)
  })

  return { lines: builder.lines, anchors: builder.anchors }
}

export function buildGroupDetail(group: IndexedGroup, table: FileTable, theme: Theme, width: number): BuiltRows {
  const builder = new LineBuilder(theme, width)
  const title = group.critical === true ? `! ${group.label}` : group.label

  builder.heading(title, group.critical === true ? StyleRole.Critical : StyleRole.Title)
  builder.text(`[${group.category}]  ${group.fileIndexes.length} files`, StyleRole.Muted)
  builder.blank()
  builder.wrapped(group.summary)

  if (group.fileNotes.length > 0) {
    builder.blank()
    builder.heading('File notes', StyleRole.Accent)

    for (const note of group.fileNotes.slice(0, MAXIMUM_NOTES_SHOWN)) {
      const prefix = note.critical === true ? '! ' : '- '
      builder.text(`${prefix}${table.pathOf(note.fileIndex)}`, note.critical === true ? StyleRole.Critical : StyleRole.Muted)
      builder.wrapped(note.text, 4)
    }
  }

  if (group.lineNotes.length > 0) {
    builder.blank()
    builder.heading('Line notes', StyleRole.Accent)

    for (const note of group.lineNotes.slice(0, MAXIMUM_NOTES_SHOWN)) {
      const prefix = note.critical === true ? '! ' : '- '
      builder.text(`${prefix}${table.pathOf(note.fileIndex)}:${note.line}`, note.critical === true ? StyleRole.Critical : StyleRole.Muted)
      builder.wrapped(note.text, 4)
    }
  }

  if (group.visual !== undefined) {
    builder.blank()
    builder.heading(group.visual.caption, StyleRole.Accent)

    for (const line of group.visual.lines) {
      const marker = line.change === ReviewVisualChange.Added ? '+' : line.change === ReviewVisualChange.Removed ? '-' : ' '
      const role =
        line.change === ReviewVisualChange.Added ? StyleRole.Addition : line.change === ReviewVisualChange.Removed ? StyleRole.Deletion : undefined
      const indent = paddingOf(Math.min(line.depth, 12) * 2)
      const body = sanitizeLine(line.text).text
      const markerText = role === undefined ? trustedLiteral(marker) : applyStyle(theme.role[role], trustedLiteral(marker))
      const anchorMark = line.anchor === undefined ? EMPTY_DISPLAY_TEXT : applyStyle(theme.role[StyleRole.Muted], trustedLiteral(' ->'))

      builder.push(joinDisplayText([markerText, trustedLiteral(' '), indent, body, anchorMark]), line.anchor)
    }
  }

  return { lines: builder.lines, anchors: builder.anchors }
}

const SCOPE_TITLES: [string, (panels: PanelId[] | undefined) => boolean][] = [
  ['Anywhere', panels => panels === undefined],
  ['Review, Groups and Files panels', panels => panels?.includes(PanelId.Groups) === true],
  ['Files panel', panels => panels?.includes(PanelId.Files) === true && !panels.includes(PanelId.Groups)],
  ['Main panel', panels => panels?.includes(PanelId.Main) === true],
]

export function buildHelp(theme: Theme, width: number): BuiltRows {
  const builder = new LineBuilder(theme, width)

  builder.heading('Keys')
  builder.wrapped('Diff viewing only. Nothing here writes to the repository.', 0, StyleRole.Muted)

  for (const [title, matches] of SCOPE_TITLES) {
    builder.blank()
    builder.heading(title, StyleRole.Accent)

    for (const entry of BINDINGS.filter(candidate => matches(candidate.panels))) {
      builder.text(`${entry.keys.join(' ').padEnd(18)} ${entry.label}`)
    }
  }

  builder.blank()
  builder.text('esc closes this help', StyleRole.Muted)

  return { lines: builder.lines, anchors: builder.anchors }
}
