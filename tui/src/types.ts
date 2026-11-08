export enum AnalysisStatus {
  Pending = 'pending',
  Ready = 'ready',
  Failed = 'failed',
}

export enum RowKind {
  HunkHeader = 0,
  Context = 1,
  Addition = 2,
  Deletion = 3,
  NoNewline = 4,
}

export enum FileStatusCode {
  Modified = 0,
  Added = 1,
  Removed = 2,
  Renamed = 3,
  Copied = 4,
}

export enum FileFlag {
  Binary = 1,
  Generated = 2,
  ModeOnly = 4,
  AbbreviatedIndex = 8,
  PathTruncated = 16,
}

export enum LaunchExitCode {
  Usage = 64,
  UnsupportedSchema = 2,
  Unreadable = 66,
}

export enum PanelId {
  Review = 0,
  Groups = 1,
  Files = 2,
  Main = 3,
}

export enum ScreenMode {
  Normal = 0,
  Compact = 1,
  Full = 2,
}

export enum MainViewKind {
  Overview = 'overview',
  Group = 'group',
  Diff = 'diff',
  Help = 'help',
}

export enum StyleRole {
  Accent = 'accent',
  Muted = 'muted',
  Addition = 'addition',
  Deletion = 'deletion',
  Critical = 'critical',
  Reviewed = 'reviewed',
  Selected = 'selected',
  Title = 'title',
  Emphasis = 'emphasis',
  Hunk = 'hunk',
  Note = 'note',
}

export enum SyntaxSlot {
  Plain = 0,
  Comment = 1,
  String = 2,
  Constant = 3,
  Keyword = 4,
  Function = 5,
  Type = 6,
  Parameter = 7,
}

export enum Action {
  Quit = 'quit',
  Help = 'help',
  FocusReview = 'focus-review',
  FocusGroups = 'focus-groups',
  FocusFiles = 'focus-files',
  FocusMain = 'focus-main',
  PreviousPanel = 'previous-panel',
  NextPanel = 'next-panel',
  TogglePanelSide = 'toggle-panel-side',
  PreviousGroup = 'previous-group',
  NextGroup = 'next-group',
  GrowMain = 'grow-main',
  ShrinkMain = 'shrink-main',
  ToggleFull = 'toggle-full',
  ZoomPane = 'zoom-pane',
  NextCritical = 'next-critical',
  PreviousCritical = 'previous-critical',
  NextNote = 'next-note',
  PreviousNote = 'previous-note',
  NextUnreviewed = 'next-unreviewed',
  Redraw = 'redraw',
  Escape = 'escape',
  MoveDown = 'move-down',
  MoveUp = 'move-up',
  MoveFirst = 'move-first',
  MoveLast = 'move-last',
  HalfPageDown = 'half-page-down',
  HalfPageUp = 'half-page-up',
  PageDown = 'page-down',
  PageUp = 'page-up',
  Enter = 'enter',
  ToggleReviewed = 'toggle-reviewed',
  ToggleAllReviewed = 'toggle-all-reviewed',
  HideReviewed = 'hide-reviewed',
  OpenFilter = 'open-filter',
  ToggleTree = 'toggle-tree',
  CollapseAll = 'collapse-all',
  ExpandAll = 'expand-all',
  PreviousHunk = 'previous-hunk',
  NextHunk = 'next-hunk',
  NextFile = 'next-file',
  PreviousFile = 'previous-file',
  ScrollLeft = 'scroll-left',
  ScrollRight = 'scroll-right',
  LineStart = 'line-start',
  LineEnd = 'line-end',
  ToggleNotes = 'toggle-notes',
  OpenSearch = 'open-search',
  NextMatch = 'next-match',
  PreviousMatch = 'previous-match',
}

export enum InputMode {
  None = 'none',
  Filter = 'filter',
  Search = 'search',
}

export enum KeyOutcome {
  Continue = 'continue',
  Quit = 'quit',
  ZoomPane = 'zoom-pane',
  Redraw = 'redraw',
}

export enum InputEventKind {
  Key = 'key',
  Paste = 'paste',
}

export enum WorkerMessageType {
  Init = 'init',
  Highlight = 'highlight',
  Highlighted = 'highlighted',
  Failed = 'failed',
}

export enum VirtualRowKind {
  Header = 'header',
  Note = 'note',
  Patch = 'patch',
}
