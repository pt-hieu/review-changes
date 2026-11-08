import { statSync } from 'node:fs'
import { join } from 'node:path'
import { analysisModifiedTime, ANALYSIS_FILE_NAME, ANALYSIS_TIMEOUT_MILLISECONDS, loadAnalysis, type LoadedAnalysis } from '../analysis/sessionAnalysis.ts'
import { NoteIndex, type JumpTarget } from '../analysis/noteIndex.ts'
import type { IndexedGroup, ReviewSession } from '../contract.ts'
import { DiffRows } from '../main-view/diffRows.ts'
import { FileSearch } from '../main-view/search.ts'
import { buildGroupDetail, buildGroupOverview, buildHelp, buildOverview, TextRows } from '../main-view/textRows.ts'
import { allDirectoryKeys, buildFileList, type FileList } from '../panels/fileTree.ts'
import { PathFilter } from '../panels/filter.ts'
import { keyBarRow } from '../panels/keyBar.ts'
import { filesPanelRows } from '../panels/filesPanel.ts'
import { groupsPanelRows } from '../panels/groupsPanel.ts'
import { clampList, type ListState } from '../panels/listPanel.ts'
import { reviewPanelRows } from '../panels/reviewPanel.ts'
import type { FileTable } from '../patch/fileTable.ts'
import type { LoadedReview } from '../session/loadReview.ts'
import type { ReviewedStore } from '../store/reviewedStore.ts'
import { applyStyle, fitToWidth, joinDisplayText, paddingOf, sanitizeLine, sliceColumns, trustedLiteral, type DisplayText } from '../text/sanitize.ts'
import type { Theme } from '../terminal/styles.ts'
import { Action, AnalysisStatus, FileStatusCode, InputMode, KeyOutcome, MainViewKind, PanelId, ScreenMode, StyleRole } from '../types.ts'
import { renderBox, renderCollapsed, titleText, clippedTail, type ScrollThumb } from './box.ts'
import type { FrameRow } from './frame.ts'
import { computeLayout, type Layout, type Rect } from './layout.ts'
import { resolveAction } from './keymap.ts'
import type { RunsSource } from '../main-view/diffRows.ts'

export type HighlightService = RunsSource & {
  request(fileIndex: number, firstRow: number, lastRow: number): void
  poll(): boolean
}

export type AppDependencies = {
  review: LoadedReview
  reviewDirectory: string
  store: ReviewedStore
  theme: Theme
  highlight: HighlightService | undefined
  nowMilliseconds: () => number
  canZoomPane: boolean
}

const MESSAGE_MILLISECONDS = 3000
const CONFIRM_MILLISECONDS = 2000
const ANALYSIS_POLL_MILLISECONDS = 500
const INDEX_QUANTUM_MILLISECONDS = 8
const SEARCH_QUANTUM_MILLISECONDS = 8
const HIGHLIGHT_QUIET_MILLISECONDS = 40
const FILTER_WARM_UP_DELAY_MILLISECONDS = 150
const FILTER_WARM_UP_QUIET_MILLISECONDS = 100
const HORIZONTAL_STEP = 8
const MAXIMUM_INPUT_CHARACTERS = 4096
const FIRST_SCREEN_INDEX_MILLISECONDS = 8
const JUMP_INDEX_MILLISECONDS = 100

const STATUS_LETTER: Record<FileStatusCode, string> = {
  [FileStatusCode.Modified]: 'M',
  [FileStatusCode.Added]: 'A',
  [FileStatusCode.Removed]: 'D',
  [FileStatusCode.Renamed]: 'R',
  [FileStatusCode.Copied]: 'C',
}

function ensureCapacity(buffer: Int32Array, length: number): Int32Array {
  return buffer.length >= length ? buffer : new Int32Array(Math.max(length, buffer.length * 2))
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))

  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export class ReviewApp {
  readonly theme: Theme
  readonly session: ReviewSession
  readonly table: FileTable
  readonly collapsedDirectories = new Set<string>()
  readonly groupsList: ListState = { cursor: 0, scroll: 0 }
  readonly filesList: ListState = { cursor: 0, scroll: 0 }

  groups: IndexedGroup[] = []
  groupReviewedCounts = new Int32Array(0)
  reviewedTotal = 0
  fileList: FileList
  isFlatList = false

  get isShowingFlatList(): boolean {
    return this.isFlatList || this.filterQuery.trim() !== ''
  }
  focus = PanelId.Files
  inputMode = InputMode.None
  filterQuery = ''
  searchQuery = ''

  private readonly review: LoadedReview
  private readonly reviewDirectory: string
  private readonly store: ReviewedStore
  private readonly highlight: HighlightService | undefined
  private readonly nowMilliseconds: () => number
  private readonly canZoomPane: boolean
  private readonly pathFilter: PathFilter
  private readonly diffRows: DiffRows
  private readonly rank: Uint32Array
  private readonly allFiles: Int32Array
  private readonly rowCapacityFiles: number
  private analysis: LoadedAnalysis
  private noteIndex: NoteIndex
  private criticalFiles: Uint8Array
  private groupOfFile: Int32Array
  private scopeFiles: Int32Array
  private scopeCount = 0
  private visibleFiles: Int32Array
  private visibleCount = 0
  private isHidingReviewed = false
  private lastSidePanel = PanelId.Files
  private screenMode = ScreenMode.Normal
  private mainView = MainViewKind.Diff
  private viewBeforeHelp = MainViewKind.Diff
  private readonly scrolls: Record<MainViewKind, number> = {
    [MainViewKind.Overview]: 0,
    [MainViewKind.Group]: 0,
    [MainViewKind.Diff]: 0,
    [MainViewKind.Help]: 0,
  }
  private groupViewCursor = 0
  private overviewRows: TextRows
  private groupRows: TextRows
  private helpRows: TextRows
  private mainInnerHeight = 20
  private mainInnerWidth = 60
  private sideListHeights = { groups: 5, files: 10 }
  private message: { text: string; until: number } | undefined
  private pendingAllToggleUntil = 0
  private jumpCursor = -1
  private nextAnalysisPollAt = 0
  private lastAnalysisModified = 0
  private lastKeyAt = 0
  private highlightRequested = true
  private search: FileSearch | undefined
  private searchMatchCursor = -1
  private layout: Layout | undefined
  private startedAt: number
  private needsRepaint = true
  private isFilterWarm = false

  constructor(dependencies: AppDependencies) {
    this.review = dependencies.review
    this.reviewDirectory = dependencies.reviewDirectory
    this.store = dependencies.store
    this.theme = dependencies.theme
    this.highlight = dependencies.highlight
    this.nowMilliseconds = dependencies.nowMilliseconds
    this.canZoomPane = dependencies.canZoomPane
    this.session = this.review.session
    this.table = this.review.table
    this.startedAt = this.nowMilliseconds()
    this.rowCapacityFiles = this.table.fileCount
    this.pathFilter = new PathFilter(this.table)
    this.diffRows = new DiffRows(this.table, this.review.lineIndexes, this.theme, this.highlight)

    const order = this.table.sortedOrder()
    this.rank = new Uint32Array(this.table.fileCount)
    this.allFiles = new Int32Array(this.table.fileCount)

    for (let position = 0; position < order.length; position++) {
      this.rank[order[position]!] = position
      this.allFiles[position] = order[position]!
    }

    this.scopeFiles = this.allFiles
    this.visibleFiles = new Int32Array(this.table.fileCount)
    this.analysis = loadAnalysis(this.reviewDirectory, this.session, this.table)
    this.lastAnalysisModified = analysisModifiedTime(this.reviewDirectory)
    this.groupOfFile = new Int32Array(0)
    this.criticalFiles = new Uint8Array(0)
    this.noteIndex = new NoteIndex([])
    this.fileList = buildFileList(this.table, this.visibleFiles, 0, this.collapsedDirectories, false)
    this.overviewRows = new TextRows(() => ({ lines: [], anchors: [] }))
    this.groupRows = this.overviewRows
    this.helpRows = new TextRows(width => buildHelp(this.theme, width))
    this.installAnalysis(this.analysis)
    this.recomputeReviewedCounts()
    this.rebuildScope()
    this.rebuildVisible()

    const firstFile = this.firstFilePosition()

    if (firstFile >= 0) {
      this.filesList.cursor = firstFile
      this.openFile(this.fileList.fileAt(firstFile))
    } else {
      this.mainView = MainViewKind.Overview
    }
  }

  get isTooSmall(): boolean {
    return this.layout?.isTooSmall === true
  }

  get currentFile(): number {
    return this.diffRows.currentFile
  }

  get currentMainView(): MainViewKind {
    return this.mainView
  }

  get mainScroll(): number {
    return this.scrolls[this.mainView]
  }

  get hasPendingRepaint(): boolean {
    return this.needsRepaint
  }

  markRepainted(): void {
    this.needsRepaint = false
  }

  requestRepaint(): void {
    this.needsRepaint = true
  }

  isFileReviewed(fileIndex: number): boolean {
    return this.store.isReviewed(this.table.reviewKey[fileIndex]!)
  }

  isFileCritical(fileIndex: number): boolean {
    return this.criticalFiles[fileIndex] === 1
  }

  statusText(): string {
    const now = this.nowMilliseconds()

    if (this.message !== undefined && now < this.message.until) return this.message.text

    return this.analysisStatusText()
  }

  analysisStatusText(): string {
    const now = this.nowMilliseconds()

    if (this.analysis.status === AnalysisStatus.Pending) {
      const started = this.analysis.analysisStartedAt ?? this.startedAt

      if (now - started > ANALYSIS_TIMEOUT_MILLISECONDS) return 'no analysis; default grouping'

      return `analysing ${formatDuration(now - started)}`
    }

    if (this.analysis.status === AnalysisStatus.Failed && this.analysis.error !== undefined) return `analysis failed: ${this.analysis.error}`
    if (this.analysis.isFallbackGrouping) return 'default grouping'

    return ''
  }

  private installAnalysis(analysis: LoadedAnalysis): void {
    this.analysis = analysis
    this.groups = analysis.groups
    this.noteIndex = new NoteIndex(this.groups)
    this.groupOfFile = new Int32Array(this.table.fileCount).fill(-1)
    this.criticalFiles = new Uint8Array(this.table.fileCount)

    this.groups.forEach((group, groupIndex) => {
      for (const fileIndex of group.fileIndexes) this.groupOfFile[fileIndex] = groupIndex
    })

    for (const [fileIndex, notes] of this.noteIndex.fileNotes) if (notes.some(note => note.isCritical)) this.criticalFiles[fileIndex] = 1
    for (const [fileIndex, notes] of this.noteIndex.lineNotes) if (notes.some(note => note.isCritical)) this.criticalFiles[fileIndex] = 1

    this.groupReviewedCounts = new Int32Array(this.groups.length)
    this.jumpCursor = -1

    const analysisStatus = (): string => this.analysisStatusText()

    this.overviewRows = new TextRows(width =>
      buildOverview(this.session, this.table, this.analysis.overallSummary, analysisStatus(), this.theme, width),
    )
    this.groupRows = new TextRows(width => {
      const groupIndex = this.groupsList.cursor - 1

      if (groupIndex < 0 || groupIndex >= this.groups.length) {
        return buildGroupOverview(this.groups, this.analysis.overallSummary, this.groupReviewedCounts, this.theme, width)
      }

      return buildGroupDetail(this.groups[groupIndex]!, this.table, this.theme, width)
    })
  }

  private recomputeReviewedCounts(): void {
    this.groupReviewedCounts.fill(0)
    this.reviewedTotal = 0

    for (let fileIndex = 0; fileIndex < this.table.fileCount; fileIndex++) {
      if (!this.isFileReviewed(fileIndex)) continue

      this.reviewedTotal++

      const groupIndex = this.groupOfFile[fileIndex]!
      if (groupIndex >= 0) this.groupReviewedCounts[groupIndex]!++
    }
  }

  private rebuildScope(): void {
    const groupIndex = this.groupsList.cursor - 1

    if (groupIndex < 0 || groupIndex >= this.groups.length) {
      this.scopeFiles = this.allFiles
      this.scopeCount = this.allFiles.length

      return
    }

    const members = Int32Array.from(this.groups[groupIndex]!.fileIndexes)
    members.sort((left, right) => this.rank[left]! - this.rank[right]!)
    this.scopeFiles = members
    this.scopeCount = members.length
  }

  private rebuildVisible(): void {
    const previousFile = this.fileList.count > 0 ? this.fileList.fileAt(Math.min(this.filesList.cursor, this.fileList.count - 1)) : -1
    const focusFile = previousFile >= 0 ? previousFile : this.currentFile

    this.visibleFiles = ensureCapacity(this.visibleFiles, this.scopeCount)

    const hasQuery = this.filterQuery.trim() !== ''
    let count = this.pathFilter.select(this.scopeFiles, this.scopeCount, hasQuery ? this.filterQuery : '', this.visibleFiles)

    if (this.isHidingReviewed) {
      let kept = 0

      for (let index = 0; index < count; index++) {
        const fileIndex = this.visibleFiles[index]!
        if (!this.isFileReviewed(fileIndex)) this.visibleFiles[kept++] = fileIndex
      }

      count = kept
    }

    this.visibleCount = count
    this.rebuildFileList(focusFile)
  }

  private rebuildFileList(focusFile: number): void {
    const hasQuery = this.filterQuery.trim() !== ''

    this.fileList = buildFileList(this.table, this.visibleFiles, this.visibleCount, this.collapsedDirectories, this.isFlatList || hasQuery)

    const position = focusFile >= 0 ? this.fileList.positionOfFile(focusFile) : -1

    if (position >= 0) this.filesList.cursor = position
    else if (focusFile >= 0) this.filesList.cursor = 0
    else this.filesList.cursor = Math.min(this.filesList.cursor, Math.max(0, this.fileList.count - 1))

    clampList(this.filesList, this.fileList.count, this.sideListHeights.files)
  }

  private firstFilePosition(): number {
    for (let position = 0; position < this.fileList.count; position++) if (this.fileList.fileAt(position) >= 0) return position

    return -1
  }

  private openFile(fileIndex: number): void {
    if (this.diffRows.currentFile !== fileIndex) {
      this.diffRows.setFile(fileIndex, this.noteIndex.fileNotes.get(fileIndex) ?? [], this.noteIndex.lineNotes.get(fileIndex) ?? [], !this.notesHidden)
      this.diffRows.currentLineIndex!.advance(FIRST_SCREEN_INDEX_MILLISECONDS)
      this.scrolls[MainViewKind.Diff] = 0
      this.search = undefined
      this.searchMatchCursor = -1
      this.highlightRequested = true
    }

    this.mainView = MainViewKind.Diff
  }

  private notesHidden = false

  private setMessage(text: string): void {
    this.message = { text, until: this.nowMilliseconds() + MESSAGE_MILLISECONDS }
    this.needsRepaint = true
  }

  tick(): boolean {
    const now = this.nowMilliseconds()
    let changed = this.needsRepaint

    if (this.message !== undefined && now >= this.message.until) {
      this.message = undefined
      changed = true
    }

    const lineIndex = this.diffRows.currentLineIndex

    if (lineIndex !== undefined && !lineIndex.isComplete) {
      const before = lineIndex.indexedRowCount
      lineIndex.advance(INDEX_QUANTUM_MILLISECONDS)
      if (lineIndex.indexedRowCount !== before) changed = true
    }

    if (this.search !== undefined && !this.search.isComplete) {
      if (this.search.advance(SEARCH_QUANTUM_MILLISECONDS)) changed = true
    }

    if (this.analysis.status === AnalysisStatus.Pending && now >= this.nextAnalysisPollAt) {
      this.nextAnalysisPollAt = now + ANALYSIS_POLL_MILLISECONDS
      this.pollAnalysis()
      changed = true
    }

    if (!this.isFilterWarm && now - this.startedAt >= FILTER_WARM_UP_DELAY_MILLISECONDS && now - this.lastKeyAt >= FILTER_WARM_UP_QUIET_MILLISECONDS) {
      this.isFilterWarm = true
      this.pathFilter.warmUp()
    }

    if (this.highlight !== undefined) {
      if (this.highlight.poll()) changed = true

      if (this.highlightRequested && now - this.lastKeyAt >= HIGHLIGHT_QUIET_MILLISECONDS && this.currentFile >= 0 && this.mainView === MainViewKind.Diff) {
        this.highlightRequested = false
        const first = this.diffRows.patchRowOfVirtualRow(this.scrolls[MainViewKind.Diff]) ?? 0
        this.highlight.request(this.currentFile, Math.max(0, first - this.mainInnerHeight), first + this.mainInnerHeight * 2)
      }
    }

    return changed
  }

  get hasFastBackgroundWork(): boolean {
    const lineIndex = this.diffRows.currentLineIndex

    return (lineIndex !== undefined && !lineIndex.isComplete) || (this.search !== undefined && !this.search.isComplete) || this.needsRepaint
  }

  get hasBackgroundWork(): boolean {
    const lineIndex = this.diffRows.currentLineIndex

    return (
      this.highlightRequested ||
      this.analysis.status === AnalysisStatus.Pending ||
      (lineIndex !== undefined && !lineIndex.isComplete) ||
      (this.search !== undefined && !this.search.isComplete)
    )
  }

  private pollAnalysis(): boolean {
    const modified = analysisModifiedTime(this.reviewDirectory)

    if (modified === 0 || modified === this.lastAnalysisModified) return false

    this.lastAnalysisModified = modified

    const loaded = loadAnalysis(this.reviewDirectory, this.session, this.table)

    if (loaded.status === AnalysisStatus.Pending && loaded.groups === this.analysis.groups) return false

    const selectedKey = this.groupsList.cursor > 0 ? this.groups[this.groupsList.cursor - 1]?.key : undefined
    const currentFile = this.currentFile
    const savedScroll = this.scrolls[MainViewKind.Diff]

    this.installAnalysis(loaded)
    this.recomputeReviewedCounts()

    const restored = selectedKey === undefined ? -1 : this.groups.findIndex(group => group.key === selectedKey)
    this.groupsList.cursor = restored + 1
    this.rebuildScope()
    this.rebuildVisible()

    if (currentFile >= 0) {
      this.diffRows.setFile(currentFile, this.noteIndex.fileNotes.get(currentFile) ?? [], this.noteIndex.lineNotes.get(currentFile) ?? [], !this.notesHidden)
      this.scrolls[MainViewKind.Diff] = savedScroll
    }

    return true
  }

  handlePaste(text: string): void {
    if (this.inputMode === InputMode.None) return

    const cleaned = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, MAXIMUM_INPUT_CHARACTERS)

    this.appendInput(cleaned)
  }

  private appendInput(text: string): void {
    if (this.inputMode === InputMode.Filter) {
      this.filterQuery = (this.filterQuery + text).slice(0, MAXIMUM_INPUT_CHARACTERS)
      this.afterFilterChange()
    } else {
      this.searchQuery = (this.searchQuery + text).slice(0, MAXIMUM_INPUT_CHARACTERS)
      this.startSearch()
    }
  }

  private afterFilterChange(): void {
    this.rebuildVisible()
    this.selectFileAtCursor()
  }

  private startSearch(): void {
    const lineIndex = this.diffRows.currentLineIndex

    this.searchMatchCursor = -1

    if (lineIndex === undefined || this.searchQuery === '') {
      this.search = undefined

      return
    }

    this.search = new FileSearch(this.review.reader, lineIndex, this.searchQuery)
    this.search.advance(SEARCH_QUANTUM_MILLISECONDS)
    this.jumpToMatch(1)
  }

  private handleInputKey(name: string): KeyOutcome {
    const isFilter = this.inputMode === InputMode.Filter

    if (name === 'esc') {
      if (isFilter) {
        this.filterQuery = ''
        this.afterFilterChange()
      } else {
        this.searchQuery = ''
        this.search = undefined
      }

      this.inputMode = InputMode.None
    } else if (name === 'enter') {
      this.inputMode = InputMode.None
      if (isFilter && this.fileList.count > 0) this.focus = PanelId.Files
    } else if (name === 'backspace') {
      if (isFilter) {
        this.filterQuery = this.filterQuery.slice(0, -1)
        this.afterFilterChange()
      } else {
        this.searchQuery = this.searchQuery.slice(0, -1)
        this.startSearch()
      }
    } else if (name === 'ctrl+u') {
      if (isFilter) {
        this.filterQuery = ''
        this.afterFilterChange()
      } else {
        this.searchQuery = ''
        this.startSearch()
      }
    } else if (name === 'space') this.appendInput(' ')
    else if (name === 'ctrl+c') return KeyOutcome.Quit
    else if ([...name].length === 1) this.appendInput(name)
    else if (isFilter && (name === 'down' || name === 'up')) this.moveFilesCursor(name === 'down' ? 1 : -1)

    this.needsRepaint = true

    return KeyOutcome.Continue
  }

  handleKey(name: string): KeyOutcome {
    this.lastKeyAt = this.nowMilliseconds()
    this.needsRepaint = true
    this.highlightRequested = true

    if (this.inputMode !== InputMode.None) return this.handleInputKey(name)

    if (name !== 'a') this.pendingAllToggleUntil = 0

    const action = resolveAction(name, this.focus)

    if (action === undefined) return KeyOutcome.Continue

    return this.perform(action, name)
  }

  private perform(action: Action, key: string): KeyOutcome {
    switch (action) {
      case Action.Quit:
        return KeyOutcome.Quit
      case Action.Help:
        this.openHelp()
        break
      case Action.FocusReview:
        this.focusPanel(PanelId.Review)
        break
      case Action.FocusGroups:
        this.focusPanel(PanelId.Groups)
        break
      case Action.FocusFiles:
        this.focusPanel(PanelId.Files)
        break
      case Action.FocusMain:
        this.focusPanel(PanelId.Main)
        break
      case Action.PreviousPanel:
        this.focusPanel(Math.max(PanelId.Review, this.focus - 1))
        break
      case Action.NextPanel:
        this.focusPanel(Math.min(PanelId.Main, this.focus + 1))
        break
      case Action.TogglePanelSide:
        this.focusPanel(this.focus === PanelId.Main ? this.lastSidePanel : PanelId.Main)
        break
      case Action.PreviousGroup:
        this.stepGroup(-1)
        break
      case Action.NextGroup:
        this.stepGroup(1)
        break
      case Action.GrowMain:
        this.screenMode = Math.min(ScreenMode.Full, this.screenMode + 1)
        break
      case Action.ShrinkMain:
        this.screenMode = Math.max(ScreenMode.Normal, this.screenMode - 1)
        break
      case Action.ToggleFull:
        this.screenMode = this.screenMode === ScreenMode.Full ? ScreenMode.Normal : ScreenMode.Full
        break
      case Action.ZoomPane:
        if (this.canZoomPane) return KeyOutcome.ZoomPane

        this.setMessage('not running inside a Rex pane')
        break
      case Action.NextCritical:
        this.jumpToNote(1, true)
        break
      case Action.PreviousCritical:
        this.jumpToNote(-1, true)
        break
      case Action.NextNote:
        this.jumpToNote(1, false)
        break
      case Action.PreviousNote:
        this.jumpToNote(-1, false)
        break
      case Action.NextUnreviewed:
        this.jumpToUnreviewed()
        break
      case Action.Redraw:
        return KeyOutcome.Redraw
      case Action.Escape:
        this.escape()
        break
      case Action.MoveDown:
        this.move(1)
        break
      case Action.MoveUp:
        this.move(-1)
        break
      case Action.MoveFirst:
        this.moveTo(false)
        break
      case Action.MoveLast:
        this.moveTo(true)
        break
      case Action.HalfPageDown:
        this.move(Math.max(1, Math.floor(this.pageHeight() / 2)))
        break
      case Action.HalfPageUp:
        this.move(-Math.max(1, Math.floor(this.pageHeight() / 2)))
        break
      case Action.PageDown:
        this.move(Math.max(1, this.pageHeight() - 1))
        break
      case Action.PageUp:
        this.move(-Math.max(1, this.pageHeight() - 1))
        break
      case Action.Enter:
        this.enter()
        break
      case Action.ToggleReviewed:
        this.toggleReviewedCurrent()
        break
      case Action.ToggleAllReviewed:
        this.toggleAllReviewed(key)
        break
      case Action.HideReviewed:
        this.isHidingReviewed = !this.isHidingReviewed
        this.rebuildVisible()
        this.selectFileAtCursor()
        this.setMessage(this.isHidingReviewed ? 'hiding reviewed files' : 'showing reviewed files')
        break
      case Action.OpenFilter:
        this.inputMode = InputMode.Filter
        break
      case Action.ToggleTree:
        this.isFlatList = !this.isFlatList
        this.rebuildFileList(this.currentFile)
        break
      case Action.CollapseAll:
        for (const directoryKey of allDirectoryKeys(this.table, this.visibleFiles, this.visibleCount)) this.collapsedDirectories.add(directoryKey)

        this.rebuildFileList(-1)
        this.filesList.cursor = 0
        break
      case Action.ExpandAll:
        this.collapsedDirectories.clear()
        this.rebuildFileList(this.currentFile)
        break
      case Action.PreviousHunk:
        this.stepHunk(-1)
        break
      case Action.NextHunk:
        this.stepHunk(1)
        break
      case Action.NextFile:
        this.stepFile(1)
        break
      case Action.PreviousFile:
        this.stepFile(-1)
        break
      case Action.ScrollLeft:
        this.diffRows.setHorizontalColumn(this.diffRows.horizontal - HORIZONTAL_STEP)
        break
      case Action.ScrollRight:
        this.diffRows.setHorizontalColumn(this.diffRows.horizontal + HORIZONTAL_STEP)
        break
      case Action.LineStart:
        this.diffRows.setHorizontalColumn(0)
        break
      case Action.LineEnd:
        this.diffRows.setHorizontalColumn(this.diffRows.endColumn())
        break
      case Action.ToggleNotes:
        this.notesHidden = !this.notesHidden
        this.diffRows.setNotesVisible(!this.notesHidden)
        this.setMessage(this.notesHidden ? 'notes hidden' : 'notes shown')
        break
      case Action.OpenSearch:
        this.inputMode = InputMode.Search
        this.searchQuery = ''
        this.search = undefined
        break
      case Action.NextMatch:
        this.jumpToMatch(1)
        break
      case Action.PreviousMatch:
        this.jumpToMatch(-1)
        break
    }

    return KeyOutcome.Continue
  }

  private pageHeight(): number {
    if (this.focus === PanelId.Main) return this.mainInnerHeight
    if (this.focus === PanelId.Groups) return this.sideListHeights.groups

    return this.sideListHeights.files
  }

  private openHelp(): void {
    if (this.mainView !== MainViewKind.Help) this.viewBeforeHelp = this.mainView

    this.mainView = MainViewKind.Help
    this.scrolls[MainViewKind.Help] = 0
    this.focus = PanelId.Main
  }

  private escape(): void {
    if (this.mainView === MainViewKind.Help) {
      this.mainView = this.viewBeforeHelp

      return
    }

    if (this.filterQuery !== '') {
      this.filterQuery = ''
      this.afterFilterChange()

      return
    }

    if (this.focus === PanelId.Main) this.focusPanel(this.lastSidePanel)
  }

  private focusPanel(panel: PanelId): void {
    this.focus = panel

    if (panel !== PanelId.Main) this.lastSidePanel = panel

    if (this.mainView === MainViewKind.Help && panel !== PanelId.Main) this.mainView = this.viewBeforeHelp

    if (panel === PanelId.Review) this.mainView = MainViewKind.Overview
    else if (panel === PanelId.Groups) this.showGroupView()
    else if (panel === PanelId.Files) this.selectFileAtCursor()
  }

  private showGroupView(): void {
    this.mainView = MainViewKind.Group
    this.scrolls[MainViewKind.Group] = 0
    this.groupViewCursor = 0
    this.groupRows.invalidate()
  }

  private stepGroup(delta: number): void {
    const count = this.groups.length + 1
    this.groupsList.cursor = (this.groupsList.cursor + delta + count) % count
    this.applyGroupSelection()

    if (this.focus === PanelId.Files || this.focus === PanelId.Main) this.selectFileAtCursor()
  }

  private applyGroupSelection(): void {
    this.rebuildScope()
    this.rebuildVisible()
    this.filesList.cursor = Math.max(0, this.firstFilePosition())
    clampList(this.filesList, this.fileList.count, this.sideListHeights.files)

    if (this.focus === PanelId.Groups) this.showGroupView()
  }

  private move(delta: number): void {
    if (this.focus === PanelId.Groups) {
      this.groupsList.cursor = Math.max(0, Math.min(this.groups.length, this.groupsList.cursor + delta))
      this.applyGroupSelection()
    } else if (this.focus === PanelId.Files) this.moveFilesCursor(delta)
    else if (this.focus === PanelId.Main) this.scrollMain(delta)
  }

  private moveTo(isLast: boolean): void {
    if (this.focus === PanelId.Groups) {
      this.groupsList.cursor = isLast ? this.groups.length : 0
      this.applyGroupSelection()
    } else if (this.focus === PanelId.Files) {
      this.filesList.cursor = isLast ? Math.max(0, this.fileList.count - 1) : 0
      this.selectFileAtCursor()
    } else if (this.focus === PanelId.Main) {
      if (this.mainView === MainViewKind.Group) this.groupViewCursor = isLast ? Math.max(0, this.groupRows.rowCount() - 1) : 0

      if (isLast) this.scrolls[this.mainView] = Number.MAX_SAFE_INTEGER
      else this.scrolls[this.mainView] = 0
    }
  }

  private moveFilesCursor(delta: number): void {
    this.filesList.cursor = Math.max(0, Math.min(Math.max(0, this.fileList.count - 1), this.filesList.cursor + delta))
    this.selectFileAtCursor()
  }

  private selectFileAtCursor(): void {
    if (this.fileList.count === 0) return

    const fileIndex = this.fileList.fileAt(Math.min(this.filesList.cursor, this.fileList.count - 1))

    if (fileIndex >= 0) this.openFile(fileIndex)
    else if (this.currentFile >= 0 && this.mainView !== MainViewKind.Help) this.mainView = MainViewKind.Diff
  }

  private scrollMain(delta: number): void {
    if (this.mainView === MainViewKind.Group) {
      const last = Math.max(0, this.groupRows.rowCount() - 1)
      this.groupViewCursor = Math.max(0, Math.min(last, this.groupViewCursor + delta))
      const scroll = this.scrolls[MainViewKind.Group]

      if (this.groupViewCursor < scroll) this.scrolls[MainViewKind.Group] = this.groupViewCursor
      else if (this.groupViewCursor >= scroll + this.mainInnerHeight) this.scrolls[MainViewKind.Group] = this.groupViewCursor - this.mainInnerHeight + 1

      return
    }

    this.scrolls[this.mainView] = Math.max(0, this.scrolls[this.mainView] + delta)
  }

  private enter(): void {
    if (this.focus === PanelId.Main) {
      if (this.mainView === MainViewKind.Group) this.jumpToAnchor()

      return
    }

    if (this.focus === PanelId.Files) {
      const fileIndex = this.fileList.fileAt(this.filesList.cursor)

      if (fileIndex < 0) {
        const key = this.fileList.directoryKeyAt(this.filesList.cursor)!

        if (this.collapsedDirectories.has(key)) this.collapsedDirectories.delete(key)
        else this.collapsedDirectories.add(key)

        this.rebuildFileList(-1)

        return
      }
    }

    this.focusPanel(PanelId.Main)
  }

  private jumpToAnchor(): void {
    const anchor = this.groupRows.anchorAt(this.groupViewCursor)

    if (anchor === undefined) return

    this.jumpTo({ groupIndex: this.groupsList.cursor - 1, fileIndex: anchor.fileIndex, side: anchor.side, line: anchor.line, isCritical: false })
  }

  private toggleReviewedCurrent(): void {
    const fileIndex = this.currentFile

    if (fileIndex < 0) return

    const isNowReviewed = this.store.toggle(this.table.reviewKey[fileIndex]!)
    const groupIndex = this.groupOfFile[fileIndex]!
    const delta = isNowReviewed ? 1 : -1

    this.reviewedTotal += delta
    if (groupIndex >= 0) this.groupReviewedCounts[groupIndex]! += delta

    if (this.store.hasSaveFailed) this.setMessage('marks not saved: review folder is unavailable')

    if (this.isHidingReviewed) this.rebuildVisible()
  }

  private toggleAllReviewed(key: string): void {
    const now = this.nowMilliseconds()

    if (key === 'a' && now > this.pendingAllToggleUntil) {
      this.pendingAllToggleUntil = now + CONFIRM_MILLISECONDS
      this.setMessage(`a again: toggle all ${this.scopeCount}`)

      return
    }

    this.pendingAllToggleUntil = 0

    let allReviewed = true

    for (let index = 0; index < this.scopeCount; index++) {
      if (!this.isFileReviewed(this.scopeFiles[index]!)) {
        allReviewed = false
        break
      }
    }

    const keys: number[] = []
    for (let index = 0; index < this.scopeCount; index++) keys.push(this.table.reviewKey[this.scopeFiles[index]!]!)

    this.store.setMany(keys, !allReviewed)
    this.recomputeReviewedCounts()
    this.rebuildVisible()
    this.setMessage(this.store.hasSaveFailed ? 'marks not saved: review folder is unavailable' : allReviewed ? 'marked all unreviewed' : 'marked all reviewed')
  }

  private jumpToUnreviewed(): void {
    const count = this.fileList.count
    const start = this.filesList.cursor

    for (let step = 1; step <= count; step++) {
      const position = (start + step) % count
      const fileIndex = this.fileList.fileAt(position)

      if (fileIndex >= 0 && !this.isFileReviewed(fileIndex)) {
        this.filesList.cursor = position
        clampList(this.filesList, count, this.sideListHeights.files)
        this.openFile(fileIndex)

        if (this.focus !== PanelId.Main) this.focus = PanelId.Files

        return
      }
    }

    this.setMessage('everything in view is reviewed')
  }

  private stepFile(delta: number): void {
    let position = this.filesList.cursor

    for (let step = 0; step < this.fileList.count; step++) {
      position += delta

      if (position < 0 || position >= this.fileList.count) return

      if (this.fileList.fileAt(position) >= 0) {
        this.filesList.cursor = position
        clampList(this.filesList, this.fileList.count, this.sideListHeights.files)
        this.openFile(this.fileList.fileAt(position))

        return
      }
    }
  }

  private stepHunk(delta: number): void {
    const lineIndex = this.diffRows.currentLineIndex

    if (lineIndex === undefined || this.mainView !== MainViewKind.Diff) return

    const scroll = this.scrolls[MainViewKind.Diff]
    const hunkRows = Array.from(lineIndex.hunkFirstRow, row => this.diffRows.virtualRowOfPatchRow(row))
    const target = delta > 0 ? hunkRows.find(row => row > scroll) : [...hunkRows].reverse().find(row => row < scroll)

    if (target !== undefined) this.scrolls[MainViewKind.Diff] = target
  }

  private jumpToNote(direction: number, onlyCritical: boolean): void {
    const targets = this.noteIndex.jumpTargets.filter(target => !onlyCritical || target.isCritical)

    if (targets.length === 0) {
      this.setMessage(onlyCritical ? 'no look-closely markers' : 'no notes')

      return
    }

    const previous = this.jumpCursor >= 0 ? this.noteIndex.jumpTargets[this.jumpCursor] : undefined
    const base = previous === undefined ? -1 : targets.indexOf(previous)
    let next = base + direction
    let wrapped = false

    if (next >= targets.length) {
      next = 0
      wrapped = true
    } else if (next < 0) {
      next = targets.length - 1
      wrapped = base !== -1 || direction < 0
    }

    const target = targets[next]!

    this.jumpCursor = this.noteIndex.jumpTargets.indexOf(target)
    this.jumpTo(target)

    if (wrapped) this.setMessage('wrapped around')
  }

  private jumpTo(target: JumpTarget): void {
    if (target.groupIndex >= 0 && this.groupsList.cursor !== target.groupIndex + 1) {
      this.groupsList.cursor = target.groupIndex + 1
      this.rebuildScope()
      this.rebuildVisible()
    }

    if (target.fileIndex === undefined) {
      this.focus = PanelId.Groups
      this.lastSidePanel = PanelId.Groups
      this.showGroupView()
      clampList(this.groupsList, this.groups.length + 1, this.sideListHeights.groups)

      return
    }

    if (this.fileList.positionOfFile(target.fileIndex) < 0) {
      this.filterQuery = ''
      this.isHidingReviewed = false
      this.rebuildVisible()
    }

    const position = this.fileList.positionOfFile(target.fileIndex)

    if (position >= 0) {
      this.filesList.cursor = position
      clampList(this.filesList, this.fileList.count, this.sideListHeights.files)
    }

    this.openFile(target.fileIndex)
    this.focus = PanelId.Main

    if (target.line === undefined || target.side === undefined) return

    const lineIndex = this.diffRows.currentLineIndex!

    lineIndex.advance(JUMP_INDEX_MILLISECONDS)
    this.diffRows.prepare(this.mainInnerWidth)

    const row = this.diffRows.findRowForLine(lineIndex, target.side, target.line)

    if (row === undefined) return

    const virtual = this.diffRows.virtualRowOfPatchRow(row)
    this.scrolls[MainViewKind.Diff] = Math.max(0, virtual - Math.floor(this.mainInnerHeight / 3))
  }

  private jumpToMatch(direction: number): void {
    const search = this.search

    if (search === undefined) {
      if (this.searchQuery === '') this.setMessage('no search; press / to search this file')

      return
    }

    search.advance(SEARCH_QUANTUM_MILLISECONDS)

    if (search.matchRows.length === 0) {
      this.setMessage(search.isComplete ? 'no matches' : 'searching...')

      return
    }

    const count = search.matchRows.length
    this.searchMatchCursor = (this.searchMatchCursor + direction + count) % count

    const virtual = this.diffRows.virtualRowOfPatchRow(search.matchRows[this.searchMatchCursor]!)
    this.scrolls[MainViewKind.Diff] = Math.max(0, virtual - Math.floor(this.mainInnerHeight / 3))
    this.setMessage(`match ${this.searchMatchCursor + 1}/${count}${search.isComplete ? '' : '+'}`)
  }

  private activeRows(): TextRows | DiffRows {
    if (this.mainView === MainViewKind.Diff) return this.diffRows
    if (this.mainView === MainViewKind.Group) return this.groupRows
    if (this.mainView === MainViewKind.Help) return this.helpRows

    return this.overviewRows
  }

  render(columns: number, rows: number): FrameRow[] {
    const layout = computeLayout({
      columns,
      rows,
      screenMode: this.screenMode,
      focus: this.focus,
      lastSidePanel: this.lastSidePanel,
      groupRowCount: this.groups.length + 1,
    })

    this.layout = layout

    if (layout.isTooSmall) {
      const notice = fitToWidth(sliceColumns(sanitizeLine('pane too small').text, 0, columns), columns)

      return Array.from({ length: rows }, (_unusedValue, row) => [{ column: 0, text: row === 0 ? notice : paddingOf(columns) }])
    }

    const sideLines = layout.side === undefined ? undefined : this.renderSide(layout)
    const mainLines = layout.main === undefined ? undefined : this.renderMain(layout.main)
    const frame: FrameRow[] = []

    for (let row = 0; row < rows - 1; row++) {
      const segments: FrameRow = []

      if (sideLines !== undefined) segments.push({ column: 0, text: sideLines[row] ?? paddingOf(layout.side!.review.width) })
      if (mainLines !== undefined && layout.main !== undefined) segments.push({ column: layout.main.column, text: mainLines[row] ?? paddingOf(layout.main.width) })

      frame.push(segments)
    }

    frame.push([{ column: 0, text: keyBarRow(this, columns, this.statusText()) }])

    return frame
  }

  private renderSide(layout: Layout): DisplayText[] {
    const { review, groups, files } = layout.side!
    const lines: DisplayText[] = []
    const width = review.width

    this.sideListHeights = { groups: Math.max(1, groups.height - 2), files: Math.max(1, files.height - 2) }
    clampList(this.groupsList, this.groups.length + 1, this.sideListHeights.groups)
    clampList(this.filesList, this.fileList.count, this.sideListHeights.files)

    lines.push(...this.panelBox('[1] Summary', '', review, PanelId.Review, () => reviewPanelRows(this, this.focus === PanelId.Review)))
    lines.push(
      ...this.panelBox(`[2] Groups ${this.groups.length}`, '', groups, PanelId.Groups, () => groupsPanelRows(this, width - 2, groups.height - 2, this.focus === PanelId.Groups)),
    )

    const filterTrailer = this.filterQuery === '' ? '' : ` /${this.filterQuery} `
    const counts = this.visibleCount === this.scopeCount ? `${this.scopeCount}` : `${this.visibleCount}/${this.scopeCount}`
    lines.push(
      ...this.panelBox(`[3] Files ${counts}`, filterTrailer, files, PanelId.Files, () => filesPanelRows(this, width - 2, files.height - 2, this.focus === PanelId.Files)),
    )

    return lines
  }

  private panelBox(title: string, trailer: string, rect: Rect, panel: PanelId, content: () => DisplayText[]): DisplayText[] {
    const isFocused = this.focus === panel

    if (rect.height <= 1) return renderCollapsed(titleText(title), rect.width, isFocused, this.theme)

    return renderBox(titleText(title), titleText(trailer), content(), rect.width, rect.height, isFocused, this.theme)
  }

  private mainTitle(): { title: DisplayText; trailer: DisplayText } {
    if (this.mainView === MainViewKind.Help) return { title: titleText(' Help'), trailer: titleText('') }
    if (this.mainView === MainViewKind.Overview) return { title: titleText(' Summary'), trailer: titleText('') }

    if (this.mainView === MainViewKind.Group) {
      const group = this.groups[this.groupsList.cursor - 1]

      return { title: titleText(` ${group === undefined ? 'All files' : group.label}`), trailer: titleText('') }
    }

    const fileIndex = this.currentFile

    if (fileIndex < 0) return { title: titleText(' No files'), trailer: titleText('') }

    let position = -1

    for (let candidate = 0; candidate < this.visibleCount; candidate++) {
      if (this.visibleFiles[candidate] === fileIndex) {
        position = candidate
        break
      }
    }

    const status = STATUS_LETTER[this.table.status[fileIndex] as FileStatusCode] ?? '?'
    const stats = ` ${status} +${this.table.additions[fileIndex]} -${this.table.deletions[fileIndex]} `
    const counter = position >= 0 ? ` ${position + 1}/${this.visibleCount} ` : ''

    return { title: joinTitle(this.table.pathOf(fileIndex), stats, this.mainInnerWidth), trailer: titleText(counter) }
  }

  private renderMain(rect: Rect): DisplayText[] {
    this.mainInnerHeight = Math.max(1, rect.height - 2)
    this.mainInnerWidth = Math.max(1, rect.width - 2)

    const source = this.activeRows()
    source.prepare(this.mainInnerWidth)

    const total = source.rowCount()
    const maximumScroll = Math.max(0, total - this.mainInnerHeight)

    this.scrolls[this.mainView] = Math.max(0, Math.min(this.scrolls[this.mainView], maximumScroll))

    const scroll = this.scrolls[this.mainView]
    const innerRows = source.materialize(scroll, this.mainInnerHeight, this.mainInnerWidth)

    if (this.mainView === MainViewKind.Group && this.focus === PanelId.Main) {
      const index = this.groupViewCursor - scroll

      if (index >= 0 && index < innerRows.length) innerRows[index] = applyStyle(this.theme.role[StyleRole.Selected], fitToWidth(innerRows[index]!, this.mainInnerWidth))
    }

    let thumb: ScrollThumb | undefined

    if (total > this.mainInnerHeight) {
      const length = Math.max(1, Math.floor((this.mainInnerHeight * this.mainInnerHeight) / total))
      const start = Math.floor((scroll / maximumScroll) * (this.mainInnerHeight - length))
      thumb = { start, length }
    }

    const { title, trailer } = this.mainTitle()

    return renderBox(title, trailer, innerRows, rect.width, rect.height, this.focus === PanelId.Main, this.theme, thumb)
  }
}

function joinTitle(path: string, stats: string, width: number): DisplayText {
  const statsText = trustedLiteral(stats)
  const budget = Math.max(8, width - stats.length - 6)
  const pathText = clippedTail(sanitizeLine(path).text, budget)

  return joinDisplayText([trustedLiteral(' '), pathText, statsText])
}
