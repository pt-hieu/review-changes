export enum ReviewFileStatus {
  Added = 'added',
  Removed = 'removed',
  Modified = 'modified',
  Renamed = 'renamed',
  Copied = 'copied',
}

export enum ReviewLineSide {
  Additions = 'additions',
  Deletions = 'deletions',
}

export enum ReviewVisualChange {
  Added = 'added',
  Removed = 'removed',
  Unchanged = 'unchanged',
}

export enum ReviewCategory {
  Ui = 'ui',
  Api = 'api',
  Core = 'core',
  Data = 'data',
  Cli = 'cli',
  Security = 'security',
  Tests = 'tests',
  Docs = 'docs',
  Examples = 'examples',
  Deps = 'deps',
  Build = 'build',
  Scripts = 'scripts',
  Config = 'config',
  I18n = 'i18n',
  Assets = 'assets',
  Other = 'other',
}

export enum ReviewTargetKind {
  Worktree = 'worktree',
  Range = 'range',
  Commit = 'commit',
  PullRequest = 'pull-request',
}

export enum TargetRequestKind {
  Auto = 'auto',
  Worktree = 'worktree',
  PullRequest = 'pull-request',
  Range = 'range',
  Revision = 'revision',
}

export enum NoticeType {
  System = 'system',
  User = 'user',
}

export enum GitPathPrefix {
  Old = 'a/',
  New = 'b/',
}
