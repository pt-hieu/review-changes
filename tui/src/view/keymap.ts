import { Action, PanelId } from '../types.ts'

export type Binding = {
  keys: string[]
  keyLabel: string
  action: Action
  label: string
  panels: PanelId[] | undefined
  barPriority: number
}

const SIDE_PANELS = [PanelId.Review, PanelId.Groups, PanelId.Files]
const MAIN_ONLY = [PanelId.Main]

function binding(keys: string[], keyLabel: string, action: Action, label: string, panels: PanelId[] | undefined, barPriority: number = 0): Binding {
  return { keys, keyLabel, action, label, panels, barPriority }
}

export const BINDINGS: readonly Binding[] = [
  binding(['q', 'ctrl+c'], 'q', Action.Quit, 'quit', undefined, 9),
  binding(['?'], '?', Action.Help, 'help', undefined, 8),
  binding(['1'], '1', Action.FocusReview, 'summary', undefined, 13),
  binding(['2'], '2', Action.FocusGroups, 'groups', undefined, 12),
  binding(['3'], '3', Action.FocusFiles, 'diff', undefined, 11),
  binding(['0'], '0', Action.FocusMain, 'focus main', undefined),
  binding(['h', 'left'], 'h/l', Action.PreviousPanel, 'previous panel', undefined),
  binding(['l', 'right'], 'l', Action.NextPanel, 'next panel', undefined),
  binding(['tab'], 'tab', Action.TogglePanelSide, 'side/main', undefined, 6),
  binding(['['], '[', Action.PreviousGroup, 'previous group', undefined),
  binding([']'], ']', Action.NextGroup, 'next group', undefined),
  binding(['+'], '+', Action.GrowMain, 'bigger main', undefined),
  binding(['_'], '_', Action.ShrinkMain, 'smaller main', undefined),
  binding(['z'], 'z', Action.ToggleFull, 'zoom main', undefined),
  binding(['Z'], 'Z', Action.ZoomPane, 'rex zoom pane', undefined),
  binding(['c'], 'c', Action.NextCritical, 'next look-closely', undefined, 4),
  binding(['C'], 'C', Action.PreviousCritical, 'previous look-closely', undefined),
  binding(['m'], 'm', Action.NextNote, 'next note', undefined, 3),
  binding(['M'], 'M', Action.PreviousNote, 'previous note', undefined),
  binding(['u'], 'u', Action.NextUnreviewed, 'next unreviewed', undefined, 2),
  binding(['ctrl+l'], 'ctrl+l', Action.Redraw, 'redraw', undefined),
  binding(['esc'], 'esc', Action.Escape, 'back', undefined),

  binding(['j', 'down'], 'j/k', Action.MoveDown, 'move', SIDE_PANELS, 10),
  binding(['k', 'up'], 'k', Action.MoveUp, 'move up', SIDE_PANELS),
  binding(['g', '<', 'home'], 'g/G', Action.MoveFirst, 'first', SIDE_PANELS),
  binding(['G', '>', 'end'], 'G', Action.MoveLast, 'last', SIDE_PANELS),
  binding(['ctrl+d'], 'ctrl+d', Action.HalfPageDown, 'half page down', SIDE_PANELS),
  binding(['ctrl+u'], 'ctrl+u', Action.HalfPageUp, 'half page up', SIDE_PANELS),
  binding(['.', 'pagedown'], '.', Action.PageDown, 'page down', SIDE_PANELS),
  binding([',', 'pageup'], ',', Action.PageUp, 'page up', SIDE_PANELS),
  binding(['enter'], 'enter', Action.Enter, 'open', SIDE_PANELS, 7),

  binding(['space'], 'space', Action.ToggleReviewed, 'reviewed', [PanelId.Files, PanelId.Main], 5),
  binding(['a'], 'a a', Action.ToggleAllReviewed, 'toggle all reviewed', [PanelId.Files]),
  binding(['R'], 'R', Action.HideReviewed, 'hide reviewed', [PanelId.Files]),
  binding(['/'], '/', Action.OpenFilter, 'filter', [PanelId.Files], 5),
  binding(['`'], '`', Action.ToggleTree, 'tree/flat', [PanelId.Files]),
  binding(['-'], '-', Action.CollapseAll, 'collapse all', [PanelId.Files]),
  binding(['='], '=', Action.ExpandAll, 'expand all', [PanelId.Files]),

  binding(['j', 'down'], 'j/k', Action.MoveDown, 'scroll', MAIN_ONLY, 10),
  binding(['k', 'up'], 'k', Action.MoveUp, 'scroll up', MAIN_ONLY),
  binding(['ctrl+d'], 'ctrl+d', Action.HalfPageDown, 'half page down', MAIN_ONLY, 9),
  binding(['ctrl+u'], 'ctrl+u', Action.HalfPageUp, 'half page up', MAIN_ONLY),
  binding(['ctrl+f', 'pagedown'], 'ctrl+f', Action.PageDown, 'page down', MAIN_ONLY),
  binding(['ctrl+b', 'pageup'], 'ctrl+b', Action.PageUp, 'page up', MAIN_ONLY),
  binding(['g', 'home'], 'g/G', Action.MoveFirst, 'top', MAIN_ONLY),
  binding(['G', 'end'], 'G', Action.MoveLast, 'bottom', MAIN_ONLY),
  binding(['{'], '{', Action.PreviousHunk, 'previous hunk', MAIN_ONLY),
  binding(['}'], '}', Action.NextHunk, 'next hunk', MAIN_ONLY, 8),
  binding(['J'], 'J', Action.NextFile, 'next file', MAIN_ONLY, 7),
  binding(['K'], 'K', Action.PreviousFile, 'previous file', MAIN_ONLY),
  binding(['H'], 'H/L', Action.ScrollLeft, 'sideways', MAIN_ONLY),
  binding(['L'], 'L', Action.ScrollRight, 'sideways right', MAIN_ONLY),
  binding(['0'], '0/$', Action.LineStart, 'line start', MAIN_ONLY),
  binding(['$'], '$', Action.LineEnd, 'line end', MAIN_ONLY),
  binding(['i'], 'i', Action.ToggleNotes, 'notes on/off', MAIN_ONLY),
  binding(['/'], '/', Action.OpenSearch, 'search', MAIN_ONLY, 4),
  binding(['n'], 'n/N', Action.NextMatch, 'next match', MAIN_ONLY),
  binding(['N'], 'N', Action.PreviousMatch, 'previous match', MAIN_ONLY),
  binding(['enter'], 'enter', Action.Enter, 'jump to anchor', MAIN_ONLY),
]

const BINDINGS_BY_KEY = new Map<string, Binding[]>()

for (const entry of BINDINGS) {
  for (const key of entry.keys) {
    const existing = BINDINGS_BY_KEY.get(key)

    if (existing === undefined) BINDINGS_BY_KEY.set(key, [entry])
    else existing.push(entry)
  }
}

export function resolveAction(key: string, focus: PanelId): Action | undefined {
  const candidates = BINDINGS_BY_KEY.get(key)

  if (candidates === undefined) return undefined

  const specific = candidates.find(candidate => candidate.panels?.includes(focus) === true)

  if (specific !== undefined) return specific.action

  return candidates.find(candidate => candidate.panels === undefined)?.action
}

export function bindingsForPanel(focus: PanelId): Binding[] {
  const specific = BINDINGS.filter(candidate => candidate.panels?.includes(focus) === true)
  const overridden = new Set(specific.flatMap(candidate => candidate.keys))
  const global = BINDINGS.filter(candidate => candidate.panels === undefined && !candidate.keys.some(key => overridden.has(key)))

  return [...specific, ...global]
}

export function barBindings(focus: PanelId): Binding[] {
  return bindingsForPanel(focus)
    .filter(candidate => candidate.barPriority > 0)
    .sort((left, right) => right.barPriority - left.barPriority)
}
