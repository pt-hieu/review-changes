import type { ReviewCategory, ReviewFileStatus, ReviewLineSide, ReviewTargetKind, ReviewVisualChange } from './types.ts'

export const REVIEW_PAYLOAD_ELEMENT_ID = 'review-payload'

export const REVIEW_PAYLOAD_SCHEMA_VERSION = 1

export type ReviewPayload = {
  schemaVersion: typeof REVIEW_PAYLOAD_SCHEMA_VERSION
  generatedAt: string
  repository: ReviewRepository
  target: ReviewTarget
  title: string
  description?: string
  commits: ReviewCommit[]
  files: ReviewFile[]
  analysis: ReviewAnalysis
  analysisModel?: string
  analysisError?: string
}

export type ReviewRepository = {
  root: string
  name: string
}

export type ReviewTarget =
  | {
      kind: ReviewTargetKind.Worktree
      key: string
      label: string
      branch: string | null
      base: string
    }
  | {
      kind: ReviewTargetKind.Range
      key: string
      label: string
      base: string
      head: string
      isMergeBase: boolean
    }
  | {
      kind: ReviewTargetKind.Commit
      key: string
      label: string
      revision: string
      sha: string
    }
  | {
      kind: ReviewTargetKind.PullRequest
      key: string
      label: string
      number: number
      url: string
      baseRef: string
      headRef: string
      author: string | null
      state: string
    }

export type ReviewCommit = {
  sha: string
  subject: string
  author: string
}

export type ReviewHunk = {
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
}

export type ReviewFile = {
  path: string
  previousPath?: string
  status: ReviewFileStatus
  additions: number
  deletions: number
  isBinary: boolean
  hunks: ReviewHunk[]
  patch: string
  patchHash: string
  isPatchOmitted: boolean
}

export type ReviewFileNote = {
  path: string
  text: string
  critical?: boolean
}

export type ReviewLineNote = {
  path: string
  side: ReviewLineSide
  line: number
  text: string
  critical?: boolean
}

export type ReviewAnchor = {
  path: string
  side?: ReviewLineSide
  line?: number
}

export type ReviewVisualLine = {
  text: string
  depth: number
  change: ReviewVisualChange
  anchor?: ReviewAnchor
}

export type ReviewVisual = {
  caption: string
  lines: ReviewVisualLine[]
}

export type ReviewGroup = {
  key: string
  label: string
  category: ReviewCategory
  summary: string
  filePaths: string[]
  fileNotes: ReviewFileNote[]
  lineNotes: ReviewLineNote[]
  visual?: ReviewVisual
  critical?: boolean
}

export type ReviewAnalysis = {
  overallSummary: string
  groups: ReviewGroup[]
}
