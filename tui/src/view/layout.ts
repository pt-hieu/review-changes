import { PanelId, ScreenMode } from '../types.ts'

export type Rect = { column: number; row: number; width: number; height: number }

export type SidePanelHeights = { review: number; groups: number; files: number }

export type Layout = {
  isTooSmall: boolean
  side: { review: Rect; groups: Rect; files: Rect } | undefined
  main: Rect | undefined
  keyBar: Rect
  columns: number
  rows: number
}

const MINIMUM_COLUMNS = 40
const MINIMUM_ROWS = 10
const ACCORDION_ROWS = 30
const REVIEW_PANEL_HEIGHT = 4
const WIDE_SIDE_COLUMNS = 40
const WIDE_THRESHOLD = 120
const NARROW_THRESHOLD = 80
const COLLAPSED_PANEL_HEIGHT = 1
const MINIMUM_GROUPS_HEIGHT = 4

export type LayoutInput = {
  columns: number
  rows: number
  screenMode: ScreenMode
  focus: PanelId
  lastSidePanel: PanelId
  groupRowCount: number
}

function sideWidthOf(columns: number, screenMode: ScreenMode): number {
  const normalWidth = columns >= WIDE_THRESHOLD ? WIDE_SIDE_COLUMNS : Math.max(28, Math.floor(columns * 0.3))

  if (screenMode === ScreenMode.Compact) return Math.max(20, Math.floor(normalWidth * 0.6))

  return normalWidth
}

function sideHeights(input: LayoutInput, bodyRows: number): SidePanelHeights {
  if (input.rows >= ACCORDION_ROWS) {
    const groups = Math.max(MINIMUM_GROUPS_HEIGHT, Math.min(input.groupRowCount + 2, Math.floor(bodyRows * 0.3)))

    return { review: REVIEW_PANEL_HEIGHT, groups, files: bodyRows - REVIEW_PANEL_HEIGHT - groups }
  }

  const expanded = input.focus === PanelId.Main ? input.lastSidePanel : input.focus
  const collapsedTotal = COLLAPSED_PANEL_HEIGHT * 2
  const expandedHeight = bodyRows - collapsedTotal

  return {
    review: expanded === PanelId.Review ? expandedHeight : COLLAPSED_PANEL_HEIGHT,
    groups: expanded === PanelId.Groups ? expandedHeight : COLLAPSED_PANEL_HEIGHT,
    files: expanded === PanelId.Files ? expandedHeight : COLLAPSED_PANEL_HEIGHT,
  }
}

export function computeLayout(input: LayoutInput): Layout {
  const { columns, rows } = input
  const keyBar: Rect = { column: 0, row: rows - 1, width: columns, height: 1 }
  const bodyRows = rows - 1

  if (columns < MINIMUM_COLUMNS || rows < MINIMUM_ROWS) {
    return { isTooSmall: true, side: undefined, main: undefined, keyBar, columns, rows }
  }

  const effectiveMode = columns < NARROW_THRESHOLD && input.screenMode === ScreenMode.Normal ? ScreenMode.Full : input.screenMode
  const isFullSide = effectiveMode === ScreenMode.Full && input.focus !== PanelId.Main
  const sideWidth = isFullSide ? columns : sideWidthOf(columns, effectiveMode)
  const heights = sideHeights(input, bodyRows)
  const side = {
    review: { column: 0, row: 0, width: sideWidth, height: heights.review },
    groups: { column: 0, row: heights.review, width: sideWidth, height: heights.groups },
    files: { column: 0, row: heights.review + heights.groups, width: sideWidth, height: heights.files },
  }

  if (isFullSide) return { isTooSmall: false, side, main: undefined, keyBar, columns, rows }

  if (effectiveMode === ScreenMode.Full) {
    return { isTooSmall: false, side: undefined, main: { column: 0, row: 0, width: columns, height: bodyRows }, keyBar, columns, rows }
  }

  return {
    isTooSmall: false,
    side,
    main: { column: sideWidth, row: 0, width: columns - sideWidth, height: bodyRows },
    keyBar,
    columns,
    rows,
  }
}
