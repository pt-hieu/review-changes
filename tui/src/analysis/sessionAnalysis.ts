import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ReviewCategory } from '../review/types.ts'
import { REVIEW_SESSION_SCHEMA_VERSION, type IndexedGroup, type ReviewSession, type SessionAnalysis } from '../contract.ts'
import type { FileTable } from '../patch/fileTable.ts'
import { AnalysisStatus } from '../types.ts'
import { seedGroups } from './seedGroups.ts'

export const ANALYSIS_FILE_NAME = 'analysis.json'
export const ANALYSIS_TIMEOUT_MILLISECONDS = 16 * 60 * 1000

export type LoadedAnalysis = {
  status: AnalysisStatus
  overallSummary: string
  groups: IndexedGroup[]
  error: string | undefined
  analysisStartedAt: number | undefined
  isFallbackGrouping: boolean
}

function isIndexInRange(fileIndex: unknown, fileCount: number): fileIndex is number {
  return typeof fileIndex === 'number' && Number.isInteger(fileIndex) && fileIndex >= 0 && fileIndex < fileCount
}

function isWellFormedGroup(group: unknown): group is IndexedGroup {
  if (typeof group !== 'object' || group === null) return false

  const candidate = group as Partial<IndexedGroup>
  const visual = candidate.visual as Partial<NonNullable<IndexedGroup['visual']>> | undefined
  const isVisualWellFormed =
    visual === undefined ||
    (typeof visual === 'object' &&
      visual !== null &&
      typeof visual.caption === 'string' &&
      Array.isArray(visual.lines) &&
      visual.lines.every(line => typeof line === 'object' && line !== null))

  return (
    typeof candidate.key === 'string' &&
    typeof candidate.label === 'string' &&
    typeof candidate.summary === 'string' &&
    Array.isArray(candidate.fileIndexes) &&
    (candidate.fileNotes === undefined || (Array.isArray(candidate.fileNotes) && candidate.fileNotes.every(note => typeof note === 'object' && note !== null))) &&
    (candidate.lineNotes === undefined || (Array.isArray(candidate.lineNotes) && candidate.lineNotes.every(note => typeof note === 'object' && note !== null))) &&
    isVisualWellFormed
  )
}

function sanitizedGroup(group: IndexedGroup, fileCount: number): IndexedGroup {
  const visual = group.visual

  return {
    ...group,
    fileIndexes: (group.fileIndexes ?? []).filter(fileIndex => isIndexInRange(fileIndex, fileCount)),
    fileNotes: (group.fileNotes ?? []).filter(note => isIndexInRange(note.fileIndex, fileCount)),
    lineNotes: (group.lineNotes ?? []).filter(note => isIndexInRange(note.fileIndex, fileCount)),
    visual:
      visual === undefined
        ? undefined
        : {
            caption: visual.caption,
            lines: visual.lines.map(line =>
              line.anchor !== undefined && !isIndexInRange(line.anchor.fileIndex, fileCount) ? { ...line, anchor: undefined } : line,
            ),
          },
  }
}

function withEveryFilePlaced(groups: IndexedGroup[], table: FileTable): IndexedGroup[] {
  const placed = new Uint8Array(table.fileCount)
  const uniqueGroups = groups.map(group => ({
    ...group,
    fileIndexes: group.fileIndexes.filter(fileIndex => {
      if (placed[fileIndex] === 1) return false

      placed[fileIndex] = 1

      return true
    }),
  }))
  const leftover: number[] = []

  for (const fileIndex of table.sortedOrder()) {
    if (placed[fileIndex] === 0) leftover.push(fileIndex)
  }

  if (leftover.length === 0) return uniqueGroups

  return [
    ...uniqueGroups,
    {
      key: 'unplaced',
      label: 'Other files',
      category: ReviewCategory.Other,
      summary: `${leftover.length} files the analysis did not place`,
      fileIndexes: leftover,
      fileNotes: [],
      lineNotes: [],
    },
  ]
}

export function analysisModifiedTime(reviewDirectory: string): number {
  try {
    return statSync(join(reviewDirectory, ANALYSIS_FILE_NAME)).mtimeMs
  } catch {
    return 0
  }
}

export function loadAnalysis(reviewDirectory: string, session: ReviewSession, table: FileTable): LoadedAnalysis {
  const fallback: LoadedAnalysis = {
    status: AnalysisStatus.Failed,
    overallSummary: '',
    groups: seedGroups(table),
    error: undefined,
    analysisStartedAt: undefined,
    isFallbackGrouping: true,
  }

  let analysis: SessionAnalysis

  try {
    analysis = JSON.parse(readFileSync(join(reviewDirectory, ANALYSIS_FILE_NAME), 'utf8')) as SessionAnalysis
  } catch {
    return fallback
  }

  if (analysis.schemaVersion !== REVIEW_SESSION_SCHEMA_VERSION || analysis.reviewId !== session.reviewId) return fallback
  if (!Array.isArray(analysis.groups)) return fallback

  if (!analysis.groups.every(isWellFormedGroup)) return fallback

  const isUsable = analysis.status === AnalysisStatus.Ready || analysis.status === AnalysisStatus.Pending
  const groups = isUsable && analysis.groups.length > 0 ? analysis.groups.map(group => sanitizedGroup(group, table.fileCount)) : seedGroups(table)

  return {
    status: analysis.status,
    overallSummary: typeof analysis.overallSummary === 'string' ? analysis.overallSummary : '',
    groups: withEveryFilePlaced(groups, table),
    error: typeof analysis.error === 'string' ? analysis.error : undefined,
    analysisStartedAt: Date.parse(analysis.analysisStartedAt) || undefined,
    isFallbackGrouping: !isUsable || analysis.groups.length === 0,
  }
}
