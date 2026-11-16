import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ReviewCategory, ReviewLineSide, ReviewVisualChange } from '../review/types.ts'
import {
  REVIEW_SESSION_SCHEMA_VERSION,
  type IndexedAnchor,
  type IndexedFileNote,
  type IndexedGroup,
  type IndexedLineNote,
  type IndexedVisual,
  type IndexedVisualLine,
  type ReviewSession,
  type SessionAnalysis,
} from '../contract.ts'
import { isNonNegativeInteger, isRecord, memberOf, optionalString, stringOr } from '../json.ts'
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

function isIndexInRange(fileIndex: number, fileCount: number): boolean {
  return fileIndex < fileCount
}

function parseFileNote(value: unknown): IndexedFileNote | undefined {
  if (!isRecord(value) || !isNonNegativeInteger(value.fileIndex) || typeof value.text !== 'string') return undefined

  return { fileIndex: value.fileIndex, text: value.text, ...(value.critical === true ? { critical: true } : {}) }
}

function parseLineNote(value: unknown): IndexedLineNote | undefined {
  if (!isRecord(value) || !isNonNegativeInteger(value.fileIndex) || typeof value.text !== 'string' || typeof value.line !== 'number') return undefined

  const side = memberOf(Object.values(ReviewLineSide), value.side)

  if (side === undefined) return undefined

  return { fileIndex: value.fileIndex, side, line: value.line, text: value.text, ...(value.critical === true ? { critical: true } : {}) }
}

function parseAnchor(value: unknown): IndexedAnchor | undefined {
  if (!isRecord(value) || !isNonNegativeInteger(value.fileIndex)) return undefined

  const side = memberOf(Object.values(ReviewLineSide), value.side)

  return {
    fileIndex: value.fileIndex,
    ...(side === undefined ? {} : { side }),
    ...(typeof value.line === 'number' ? { line: value.line } : {}),
  }
}

function parseVisualLine(value: unknown): IndexedVisualLine | undefined {
  if (!isRecord(value) || typeof value.text !== 'string') return undefined

  const anchor = parseAnchor(value.anchor)

  return {
    text: value.text,
    depth: typeof value.depth === 'number' ? value.depth : 0,
    change: memberOf(Object.values(ReviewVisualChange), value.change) ?? ReviewVisualChange.Unchanged,
    ...(anchor === undefined ? {} : { anchor }),
  }
}

function parseVisual(value: unknown): IndexedVisual | undefined {
  if (!isRecord(value) || typeof value.caption !== 'string' || !Array.isArray(value.lines)) return undefined

  return { caption: value.caption, lines: value.lines.map(parseVisualLine).filter(line => line !== undefined) }
}

function parseNotes<Note>(value: unknown, parseNote: (note: unknown) => Note | undefined): Note[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value)) return undefined

  return value.map(parseNote).filter(note => note !== undefined)
}

function parseGroup(value: unknown): IndexedGroup | undefined {
  if (!isRecord(value) || typeof value.key !== 'string' || typeof value.label !== 'string' || typeof value.summary !== 'string') return undefined
  if (!Array.isArray(value.fileIndexes)) return undefined

  const fileNotes = parseNotes(value.fileNotes, parseFileNote)
  const lineNotes = parseNotes(value.lineNotes, parseLineNote)
  const visual = value.visual === undefined ? undefined : parseVisual(value.visual)

  if (fileNotes === undefined || lineNotes === undefined) return undefined
  if (value.visual !== undefined && visual === undefined) return undefined

  return {
    key: value.key,
    label: value.label,
    category: memberOf(Object.values(ReviewCategory), value.category) ?? ReviewCategory.Other,
    summary: value.summary,
    ...(value.critical === true ? { critical: true } : {}),
    fileIndexes: value.fileIndexes.filter(isNonNegativeInteger),
    fileNotes,
    lineNotes,
    ...(visual === undefined ? {} : { visual }),
  }
}

export function parseSessionAnalysis(value: unknown): SessionAnalysis | undefined {
  if (!isRecord(value) || value.schemaVersion !== REVIEW_SESSION_SCHEMA_VERSION || typeof value.reviewId !== 'string') return undefined
  if (!Array.isArray(value.groups)) return undefined

  const status = memberOf(Object.values(AnalysisStatus), value.status)
  const groups = value.groups.map(parseGroup).filter(group => group !== undefined)
  const model = optionalString(value.model)
  const error = optionalString(value.error)

  if (status === undefined || groups.length !== value.groups.length) return undefined

  return {
    schemaVersion: REVIEW_SESSION_SCHEMA_VERSION,
    reviewId: value.reviewId,
    status,
    analysisStartedAt: stringOr(value.analysisStartedAt, ''),
    ...(model === undefined ? {} : { model }),
    ...(error === undefined ? {} : { error }),
    overallSummary: stringOr(value.overallSummary, ''),
    groups,
  }
}

function sanitizedGroup(group: IndexedGroup, fileCount: number): IndexedGroup {
  const visual = group.visual

  return {
    ...group,
    fileIndexes: group.fileIndexes.filter(fileIndex => isIndexInRange(fileIndex, fileCount)),
    fileNotes: group.fileNotes.filter(note => isIndexInRange(note.fileIndex, fileCount)),
    lineNotes: group.lineNotes.filter(note => isIndexInRange(note.fileIndex, fileCount)),
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

  let analysis: SessionAnalysis | undefined

  try {
    analysis = parseSessionAnalysis(JSON.parse(readFileSync(join(reviewDirectory, ANALYSIS_FILE_NAME), 'utf8')))
  } catch {
    return fallback
  }

  if (analysis === undefined || analysis.reviewId !== session.reviewId) return fallback

  const isUsable = analysis.status === AnalysisStatus.Ready || analysis.status === AnalysisStatus.Pending
  const groups = isUsable && analysis.groups.length > 0 ? analysis.groups.map(group => sanitizedGroup(group, table.fileCount)) : seedGroups(table)

  return {
    status: analysis.status,
    overallSummary: analysis.overallSummary,
    groups: withEveryFilePlaced(groups, table),
    error: analysis.error,
    analysisStartedAt: Date.parse(analysis.analysisStartedAt) || undefined,
    isFallbackGrouping: !isUsable || analysis.groups.length === 0,
  }
}
