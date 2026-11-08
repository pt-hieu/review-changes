import type {
  ReviewAnchor,
  ReviewCommit,
  ReviewFileNote,
  ReviewGroup,
  ReviewLineNote,
  ReviewRepository,
  ReviewTarget,
  ReviewVisualLine,
} from './review/payload.ts'
import type { AnalysisStatus } from './types.ts'

export const REVIEW_SESSION_SCHEMA_VERSION = 1

export type ReviewSession = {
  schemaVersion: typeof REVIEW_SESSION_SCHEMA_VERSION
  reviewId: string
  patchDigest: string
  generatedAt: string
  repository: ReviewRepository
  target: ReviewTarget
  title: string
  description?: string
  commits: ReviewCommit[]
  patchFileName: string
  patchByteLength: number
}

export type IndexedLineNote = Omit<ReviewLineNote, 'path'> & { fileIndex: number }
export type IndexedFileNote = Omit<ReviewFileNote, 'path'> & { fileIndex: number }
export type IndexedAnchor = Omit<ReviewAnchor, 'path'> & { fileIndex: number }
export type IndexedVisualLine = Omit<ReviewVisualLine, 'anchor'> & { anchor?: IndexedAnchor }
export type IndexedVisual = { caption: string; lines: IndexedVisualLine[] }

export type IndexedGroup = Omit<ReviewGroup, 'filePaths' | 'fileNotes' | 'lineNotes' | 'visual'> & {
  fileIndexes: number[]
  fileNotes: IndexedFileNote[]
  lineNotes: IndexedLineNote[]
  visual?: IndexedVisual
}

export type SessionAnalysis = {
  schemaVersion: typeof REVIEW_SESSION_SCHEMA_VERSION
  reviewId: string
  status: AnalysisStatus
  analysisStartedAt: string
  model?: string
  error?: string
  overallSummary: string
  groups: IndexedGroup[]
}

export type CollectResult =
  | {
      isCollected: true
      reviewId: string
      reviewDirectory: string
      repositoryRoot: string
      label: string
      modelLabel: string
      fileCount: number
      additions: number
      deletions: number
      isAnalysisCurrent: boolean
      analyzerPrompt: string
    }
  | { isCollected: false; message: string; modelMessage: string }
