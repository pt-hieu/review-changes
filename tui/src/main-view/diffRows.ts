import { ReviewLineSide } from '../review/types.ts'
import type { FileNoteEntry, LineNoteEntry } from '../analysis/noteIndex.ts'
import type { FileTable } from '../patch/fileTable.ts'
import type { LineIndex, LineIndexCache } from '../patch/lineIndex.ts'
import { applyStyle, fitToWidth, joinDisplayText, paddingOf, sanitizeBlock, sanitizeLine, sliceColumns, trustedLiteral, EMPTY_DISPLAY_TEXT, type DisplayText } from '../text/sanitize.ts'
import { plainMarkdown } from '../text/plainMarkdown.ts'
import { wrapWords } from '../text/wrapWords.ts'
import type { Theme } from '../terminal/styles.ts'
import { FileFlag, RowKind, StyleRole, VirtualRowKind } from '../types.ts'
import { styledContent } from './lineStyle.ts'
import type { RowSource } from './rowSource.ts'
import { wordDiff } from './wordDiff.ts'

export type RunsSource = { runsFor(fileIndex: number, row: number): Uint32Array | undefined }

const WHOLE_LINE_BYTE_LIMIT = 4096
const WINDOW_BYTES_PER_COLUMN = 4
const MAXIMUM_PAIR_WALK = 200
const MAXIMUM_PAIRS = 128
const EMPHASIS_CACHE_LIMIT = 4000
const NOTE_INDENT = 4

const MORE_RIGHT = trustedLiteral('›')
const MORE_LEFT = trustedLiteral('‹')
const ELLIPSIS = trustedLiteral('…')

type PlacedNote = { afterRow: number; lines: DisplayText[]; isCritical: boolean }

function digitsOf(value: number): number {
  return String(Math.max(1, value)).length
}

function numberCell(value: number, width: number): string {
  return value === 0 ? ' '.repeat(width) : String(value).padStart(width)
}

export class DiffRows implements RowSource {
  private fileIndex = -1
  private lineIndex: LineIndex | undefined
  private headerRows: DisplayText[] = []
  private placedNotes: PlacedNote[] = []
  private noteStarts: number[] = []
  private noteLengths: number[] = []
  private notePrefix: number[] = []
  private totalNoteRows = 0
  private unresolvedLineNotes: LineNoteEntry[] = []
  private resolvedLineNotes: { entry: LineNoteEntry; row: number }[] = []
  private fileNotes: FileNoteEntry[] = []
  private lineNotes: LineNoteEntry[] = []
  private lastRenderedWidth = 0
  private lastResolvedRows = -1
  private numberWidth = 4
  private emphasisCache = new Map<number, number[] | undefined>()
  private horizontalColumn = 0
  private isBinaryFile = false
  private hasNoRows = false
  private areNotesVisible = true
  private widestVisibleContent = 0
  private lastAvailableColumns = 0

  constructor(
    private readonly table: FileTable,
    private readonly lineIndexes: LineIndexCache,
    private readonly theme: Theme,
    private readonly runs: RunsSource | undefined,
  ) {}

  get currentFile(): number {
    return this.fileIndex
  }

  get currentLineIndex(): LineIndex | undefined {
    return this.lineIndex
  }

  setHorizontalColumn(column: number): void {
    this.horizontalColumn = Math.max(0, column)
  }

  endColumn(): number {
    return Math.max(0, this.widestVisibleContent - this.lastAvailableColumns + 2)
  }

  get horizontal(): number {
    return this.horizontalColumn
  }

  setFile(fileIndex: number, fileNotes: FileNoteEntry[], lineNotes: LineNoteEntry[], areNotesVisible: boolean): void {
    this.fileIndex = fileIndex
    this.lineIndex = this.lineIndexes.get(fileIndex)
    this.fileNotes = fileNotes
    this.lineNotes = lineNotes
    this.areNotesVisible = areNotesVisible
    this.emphasisCache = new Map()
    this.horizontalColumn = 0
    this.lastRenderedWidth = 0
    this.lastResolvedRows = -1
    this.isBinaryFile = this.table.isBinary(fileIndex)
    this.hasNoRows = this.lineIndex.rowCount === 0
    this.unresolvedLineNotes = [...lineNotes]
    this.resolvedLineNotes = []
    this.placedNotes = []
    this.headerRows = []
    this.rebuildNoteTable()

    const hunks = this.lineIndex.hunks
    const lastHunk = hunks.count - 1
    const highestLine =
      hunks.count > 0
        ? Math.max(hunks.oldStart[lastHunk]! + hunks.oldLines[lastHunk]!, hunks.newStart[lastHunk]! + hunks.newLines[lastHunk]!)
        : 0
    this.numberWidth = Math.max(3, digitsOf(highestLine))
  }

  setNotesVisible(areNotesVisible: boolean): void {
    this.areNotesVisible = areNotesVisible
    this.lastRenderedWidth = 0
  }

  prepare(width: number): void {
    const lineIndex = this.lineIndex

    if (lineIndex === undefined) return

    const needsLayout = width !== this.lastRenderedWidth
    const hasNewRows = lineIndex.indexedRowCount !== this.lastResolvedRows

    if (!needsLayout && !hasNewRows) return

    this.lastRenderedWidth = width
    this.lastResolvedRows = lineIndex.indexedRowCount
    this.resolveLineNotes(lineIndex)
    this.layoutNotes(width)
  }

  private rebuildNoteTable(): void {
    const sorted = [...this.placedNotes].sort((left, right) => left.afterRow - right.afterRow)

    this.placedNotes = sorted
    this.noteStarts = []
    this.noteLengths = []
    this.notePrefix = []

    let prefix = 0

    for (const note of sorted) {
      const length = this.areNotesVisible ? note.lines.length : 0
      this.notePrefix.push(prefix)
      this.noteStarts.push(note.afterRow + 1 + prefix)
      this.noteLengths.push(length)
      prefix += length
    }

    this.totalNoteRows = prefix
  }

  private resolveLineNotes(lineIndex: LineIndex): void {
    const stillUnresolved: LineNoteEntry[] = []

    for (const entry of this.unresolvedLineNotes) {
      const row = this.findRowForLine(lineIndex, entry.side, entry.line)

      if (row === undefined) stillUnresolved.push(entry)
      else this.resolvedLineNotes.push({ entry, row })
    }

    this.unresolvedLineNotes = stillUnresolved
  }

  private layoutNotes(width: number): void {
    const bodyWidth = Math.max(10, width - NOTE_INDENT - 2)

    this.headerRows = []

    for (const note of this.areNotesVisible ? this.fileNotes : []) {
      this.headerRows.push(...this.noteLines(note.text, note.isCritical, bodyWidth, width))
    }

    if (this.isBinaryFile) this.headerRows.push(this.dimLine('Binary file; no text diff', width))
    else if (this.hasNoRows) this.headerRows.push(this.dimLine('No content changes (mode change or pure rename)', width))

    if (this.lineIndex?.isTruncated === true) {
      this.headerRows.push(this.dimLine(`Showing the first ${this.lineIndex.rowCount} of ${this.lineIndex.totalRowCount} rows; the rest is not loaded`, width))
    }

    const previous = this.table.previousPathOf(this.fileIndex)

    if (previous !== undefined) this.headerRows.unshift(this.dimLine(`renamed from ${previous}`, width))

    this.placedNotes = this.resolvedLineNotes.map(({ entry, row }) => ({
      afterRow: row,
      lines: this.noteLines(entry.text, entry.isCritical, bodyWidth, width),
      isCritical: entry.isCritical,
    }))
    this.rebuildNoteTable()
  }

  private dimLine(text: string, width: number): DisplayText {
    return fitToWidth(applyStyle(this.theme.role[StyleRole.Muted], sanitizeLine(text).text), width)
  }

  private noteLines(text: string, isCritical: boolean, bodyWidth: number, width: number): DisplayText[] {
    const label = isCritical ? 'look closely: ' : 'note: '
    const style = this.theme.role[isCritical ? StyleRole.Critical : StyleRole.Note]
    const marker = isCritical ? '! ' : '- '
    const prefix = applyStyle(style, trustedLiteral(' '.repeat(NOTE_INDENT - 2) + marker))
    const labelText = applyStyle(style, trustedLiteral(label))
    const lineWidth = Math.max(8, bodyWidth - label.length)
    const blocks = wrapWords(plainMarkdown(text), lineWidth).flatMap(line => sanitizeBlock(line, lineWidth))

    return blocks.map((block, index) =>
      fitToWidth(
        joinDisplayText([index === 0 ? prefix : paddingOf(NOTE_INDENT), index === 0 ? labelText : paddingOf(label.length), block]),
        width,
      ),
    )
  }

  findRowForLine(lineIndex: LineIndex, side: ReviewLineSide, line: number): number | undefined {
    const hunks = lineIndex.hunks

    for (let hunk = 0; hunk < hunks.count; hunk++) {
      const start = side === ReviewLineSide.Additions ? hunks.newStart[hunk]! : hunks.oldStart[hunk]!
      const count = side === ReviewLineSide.Additions ? hunks.newLines[hunk]! : hunks.oldLines[hunk]!

      if (line < start || line >= start + count) continue

      const firstRow = lineIndex.rowOfHunk(hunk)
      const endRow = Math.min(firstRow + hunks.rowCount[hunk]!, lineIndex.indexedRowCount)
      let oldLine = hunks.oldStart[hunk]!
      let newLine = hunks.newStart[hunk]!

      for (let row = firstRow + 1; row < endRow; row++) {
        const kind = lineIndex.kindAt(row)

        if (kind === RowKind.Context) {
          if ((side === ReviewLineSide.Additions ? newLine : oldLine) === line) return row

          oldLine++
          newLine++
        } else if (kind === RowKind.Addition) {
          if (side === ReviewLineSide.Additions && newLine === line) return row

          newLine++
        } else if (kind === RowKind.Deletion) {
          if (side === ReviewLineSide.Deletions && oldLine === line) return row

          oldLine++
        }
      }

      return undefined
    }

    return undefined
  }

  rowCount(): number {
    const patchRows = this.lineIndex?.rowCount ?? 0

    return this.headerRows.length + patchRows + (this.areNotesVisible ? this.totalNoteRows : 0)
  }

  virtualRowOfPatchRow(patchRow: number): number {
    let low = 0
    let high = this.placedNotes.length

    while (low < high) {
      const middle = (low + high) >> 1
      if (this.placedNotes[middle]!.afterRow < patchRow) low = middle + 1
      else high = middle
    }

    const noteRows = low === 0 ? 0 : this.notePrefix[low - 1]! + this.noteLengths[low - 1]!

    return this.headerRows.length + patchRow + noteRows
  }

  private locate(virtualRow: number): { kind: VirtualRowKind; index: number; noteIndex: number } {
    if (virtualRow < this.headerRows.length) return { kind: VirtualRowKind.Header, index: virtualRow, noteIndex: -1 }

    const position = virtualRow - this.headerRows.length
    let low = 0
    let high = this.noteStarts.length - 1
    let found = -1

    while (low <= high) {
      const middle = (low + high) >> 1
      if (this.noteStarts[middle]! <= position) {
        found = middle
        low = middle + 1
      } else high = middle - 1
    }

    if (found >= 0 && this.noteLengths[found]! > 0 && position < this.noteStarts[found]! + this.noteLengths[found]!) {
      return { kind: VirtualRowKind.Note, index: position - this.noteStarts[found]!, noteIndex: found }
    }

    const skipped = found >= 0 ? this.notePrefix[found]! + this.noteLengths[found]! : 0

    return { kind: VirtualRowKind.Patch, index: position - skipped, noteIndex: -1 }
  }

  patchRowOfVirtualRow(virtualRow: number): number | undefined {
    const located = this.locate(virtualRow)

    return located.kind === VirtualRowKind.Patch ? located.index : undefined
  }

  materialize(firstRow: number, count: number, width: number): DisplayText[] {
    this.prepare(width)

    const rows: DisplayText[] = []
    const total = this.rowCount()

    this.widestVisibleContent = 0

    for (let offset = 0; offset < count; offset++) {
      const virtualRow = firstRow + offset

      if (virtualRow >= total) {
        rows.push(paddingOf(width))
        continue
      }

      const located = this.locate(virtualRow)

      if (located.kind === VirtualRowKind.Header) rows.push(fitToWidth(this.headerRows[located.index]!, width))
      else if (located.kind === VirtualRowKind.Note) rows.push(fitToWidth(this.placedNotes[located.noteIndex]!.lines[located.index] ?? EMPTY_DISPLAY_TEXT, width))
      else rows.push(this.patchRowText(located.index, width))
    }

    return rows
  }

  private emphasisFor(lineIndex: LineIndex, row: number): number[] | undefined {
    if (this.emphasisCache.has(row)) return this.emphasisCache.get(row)

    const ranges = this.computeEmphasis(lineIndex, row)

    if (this.emphasisCache.size > EMPHASIS_CACHE_LIMIT) this.emphasisCache.clear()

    this.emphasisCache.set(row, ranges)

    return ranges
  }

  private partnerRow(lineIndex: LineIndex, row: number): { deletionRow: number; additionRow: number } | undefined {
    const indexed = lineIndex.indexedRowCount
    const kind = lineIndex.kindAt(row)
    const kindAt = (candidate: number): RowKind | undefined => (candidate >= 0 && candidate < indexed ? lineIndex.kindAt(candidate) : undefined)
    let runStart = row

    while (kindAt(runStart - 1) === kind && row - runStart < MAXIMUM_PAIR_WALK) runStart--

    if (kindAt(runStart - 1) === kind) return undefined

    const offsetInRun = row - runStart

    if (offsetInRun >= MAXIMUM_PAIRS) return undefined

    if (kind === RowKind.Deletion) {
      let runEnd = row

      while (kindAt(runEnd + 1) === RowKind.Deletion && runEnd - runStart < MAXIMUM_PAIR_WALK) runEnd++

      const additionStart = runEnd + 1
      let additionEnd = additionStart

      if (kindAt(additionStart) !== RowKind.Addition) return undefined

      while (kindAt(additionEnd + 1) === RowKind.Addition && additionEnd - additionStart < MAXIMUM_PAIR_WALK) additionEnd++

      return additionStart + offsetInRun <= additionEnd ? { deletionRow: row, additionRow: additionStart + offsetInRun } : undefined
    }

    if (kindAt(runStart - 1) !== RowKind.Deletion) return undefined

    let deletionStart = runStart - 1

    while (kindAt(deletionStart - 1) === RowKind.Deletion && runStart - deletionStart < MAXIMUM_PAIR_WALK) deletionStart--

    return deletionStart + offsetInRun < runStart ? { deletionRow: deletionStart + offsetInRun, additionRow: row } : undefined
  }

  private computeEmphasis(lineIndex: LineIndex, row: number): number[] | undefined {
    const pair = this.partnerRow(lineIndex, row)

    if (pair === undefined) return undefined

    const oldRow = lineIndex.readRow(pair.deletionRow, 0, WHOLE_LINE_BYTE_LIMIT)
    const newRow = lineIndex.readRow(pair.additionRow, 0, WHOLE_LINE_BYTE_LIMIT)

    if (oldRow.hasMoreAfter || newRow.hasMoreAfter) return undefined

    const result = wordDiff(oldRow.text, newRow.text)

    if (result === undefined) return undefined

    return row === pair.deletionRow ? result.oldRanges : result.newRanges
  }

  private patchRowText(row: number, width: number): DisplayText {
    const lineIndex = this.lineIndex!

    if (row >= lineIndex.indexedRowCount) {
      return fitToWidth(applyStyle(this.theme.role[StyleRole.Muted], ELLIPSIS), width)
    }

    const kind = lineIndex.kindAt(row)

    if (kind === RowKind.HunkHeader) {
      const header = lineIndex.readRow(row, 0, 600)

      return fitToWidth(applyStyle(this.theme.role[StyleRole.Hunk], sanitizeLine(header.text).text), width)
    }

    const numbers = lineIndex.lineNumbersAt(row)
    const gutterText = `${numberCell(numbers.oldLine, this.numberWidth)} ${numberCell(numbers.newLine, this.numberWidth)} `
    const gutter = applyStyle(this.theme.role[StyleRole.Muted], trustedLiteral(gutterText))
    const sign = kind === RowKind.Addition ? '+' : kind === RowKind.Deletion ? '-' : kind === RowKind.NoNewline ? '\\' : ' '
    const signStyled =
      kind === RowKind.Addition
        ? applyStyle(this.theme.role[StyleRole.Addition], trustedLiteral(sign))
        : kind === RowKind.Deletion
          ? applyStyle(this.theme.role[StyleRole.Deletion], trustedLiteral(sign))
          : trustedLiteral(sign)
    const prefixWidth = gutterText.length + 1
    const available = Math.max(1, width - prefixWidth)
    const content = this.contentFor(lineIndex, row, kind, available)

    return fitToWidth(joinDisplayText([gutter, signStyled, content]), width)
  }

  private contentFor(lineIndex: LineIndex, row: number, kind: RowKind, available: number): DisplayText {
    const horizontal = this.horizontalColumn
    const probe = lineIndex.readRow(row, 0, WHOLE_LINE_BYTE_LIMIT)

    if (probe.contentByteLength <= WHOLE_LINE_BYTE_LIMIT) {
      const runs = this.runs?.runsFor(this.fileIndex, row)
      const emphasis = kind === RowKind.Addition || kind === RowKind.Deletion ? this.emphasisFor(lineIndex, row) : undefined
      const styled = styledContent(probe.text, kind, runs, emphasis, this.theme)
      const hasLeft = horizontal > 0 && styled.width > 0

      this.widestVisibleContent = Math.max(this.widestVisibleContent, styled.width)
      this.lastAvailableColumns = available
      const hasRight = styled.width - horizontal > available
      const innerWidth = available - (hasLeft ? 1 : 0) - (hasRight ? 1 : 0)
      const visible = sliceColumns(styled.text, horizontal + (hasLeft ? 1 : 0), Math.max(0, innerWidth))

      return joinDisplayText([
        hasLeft ? applyStyle(this.theme.role[StyleRole.Muted], MORE_LEFT) : EMPTY_DISPLAY_TEXT,
        visible,
        hasRight ? applyStyle(this.theme.role[StyleRole.Muted], MORE_RIGHT) : EMPTY_DISPLAY_TEXT,
      ])
    }

    this.widestVisibleContent = Math.max(this.widestVisibleContent, probe.contentByteLength)
    this.lastAvailableColumns = available

    const windowRow = lineIndex.readRow(row, horizontal, available * WINDOW_BYTES_PER_COLUMN)
    const styled = styledContent(windowRow.text, kind, undefined, undefined, this.theme)
    const hasLeft = horizontal > 0
    const hasRight = windowRow.hasMoreAfter
    const inner = sliceColumns(styled.text, 0, Math.max(0, available - (hasLeft ? 1 : 0) - (hasRight ? 1 : 0)))

    return joinDisplayText([
      hasLeft ? applyStyle(this.theme.role[StyleRole.Muted], MORE_LEFT) : EMPTY_DISPLAY_TEXT,
      inner,
      hasRight ? applyStyle(this.theme.role[StyleRole.Muted], MORE_RIGHT) : EMPTY_DISPLAY_TEXT,
    ])
  }

  hasFlag(flag: FileFlag): boolean {
    return this.fileIndex >= 0 && (this.table.flags[this.fileIndex]! & flag) !== 0
  }
}
