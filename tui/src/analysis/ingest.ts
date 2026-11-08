import { renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractJsonText, normalizeAnalysis } from '../review/analysis.ts'
import type { ReviewAnalysis, ReviewFile, ReviewHunk, ReviewVisualLine } from '../review/payload.ts'
import { ReviewFileStatus } from '../review/types.ts'
import {
  REVIEW_SESSION_SCHEMA_VERSION,
  type IndexedAnchor,
  type IndexedGroup,
  type IndexedVisualLine,
  type SessionAnalysis,
} from '../contract.ts'
import type { FileTable } from '../patch/fileTable.ts'
import { PatchReader } from '../patch/patchReader.ts'
import { scanFileHunks, scanPatch } from '../patch/scanIndex.ts'
import { readSession } from '../session/loadReview.ts'
import { AnalysisStatus, FileFlag, FileStatusCode } from '../types.ts'
import { ANALYSIS_FILE_NAME } from './sessionAnalysis.ts'
import { seedGroups } from './seedGroups.ts'

const MAXIMUM_REASON_CHARACTERS = 300
const VISUAL_ANCHOR_PATTERN = /\(([^()\s]+?)(?::\d+)?\)\s*$/
const HIDDEN_CHARACTERS = /[\p{C}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu

const STATUS_OF_CODE: Record<FileStatusCode, ReviewFileStatus> = {
  [FileStatusCode.Modified]: ReviewFileStatus.Modified,
  [FileStatusCode.Added]: ReviewFileStatus.Added,
  [FileStatusCode.Removed]: ReviewFileStatus.Removed,
  [FileStatusCode.Renamed]: ReviewFileStatus.Renamed,
  [FileStatusCode.Copied]: ReviewFileStatus.Copied,
}

export type IngestOutcome = { isIngested: boolean; message: string }

export type AnalyzedAnswer = { overallSummary: string; groups: IndexedGroup[] } | { error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function plainReason(text: string): string {
  return text.replace(HIDDEN_CHARACTERS, ' ').replace(/\s+/g, ' ').trim().slice(0, MAXIMUM_REASON_CHARACTERS)
}

function pathsNeedingHunks(rawGroups: unknown[]): Set<string> {
  const paths = new Set<string>()

  for (const rawGroup of rawGroups) {
    if (!isRecord(rawGroup)) continue

    for (const note of Array.isArray(rawGroup.lineNotes) ? rawGroup.lineNotes : []) {
      if (isRecord(note) && typeof note.path === 'string') paths.add(note.path)
    }

    const lines = isRecord(rawGroup.visual) && Array.isArray(rawGroup.visual.lines) ? rawGroup.visual.lines : []

    for (const line of lines) {
      const match = typeof line === 'string' ? VISUAL_ANCHOR_PATTERN.exec(line) : null

      if (match?.[1] !== undefined) paths.add(match[1])
    }
  }

  return paths
}

function hunksOf(table: FileTable, reader: PatchReader, fileIndex: number): ReviewHunk[] {
  const { first, end } = table.hunkRange(fileIndex)

  if (first === end) return []

  const hunks = scanFileHunks(reader.descriptor, table.patchOffset[fileIndex]!, table.patchOffset[fileIndex + 1]!)

  return Array.from({ length: hunks.count }, (_, hunkIndex) => ({
    header: '',
    oldStart: hunks.oldStart[hunkIndex]!,
    oldLines: hunks.oldLines[hunkIndex]!,
    newStart: hunks.newStart[hunkIndex]!,
    newLines: hunks.newLines[hunkIndex]!,
  }))
}

function reviewFilesOf(table: FileTable, reader: PatchReader, hunkPaths: Set<string>): ReviewFile[] {
  return Array.from({ length: table.fileCount }, (_, fileIndex) => {
    const path = table.pathOf(fileIndex)
    const previousPath = table.previousPathOf(fileIndex)

    return {
      path,
      ...(previousPath === undefined ? {} : { previousPath }),
      status: STATUS_OF_CODE[table.status[fileIndex] as FileStatusCode] ?? ReviewFileStatus.Modified,
      additions: table.additions[fileIndex]!,
      deletions: table.deletions[fileIndex]!,
      isBinary: (table.flags[fileIndex]! & FileFlag.Binary) !== 0,
      hunks: hunkPaths.has(path) ? hunksOf(table, reader, fileIndex) : [],
      patch: '',
      patchHash: '',
      isPatchOmitted: true,
    }
  })
}

function withSeedsExpanded(rawGroups: unknown[], seeds: IndexedGroup[], table: FileTable): unknown[] {
  const seedsByKey = new Map(seeds.map(seed => [seed.key, seed]))
  const placedPaths = new Set<string>()

  const expanded = rawGroups.map(rawGroup => {
    if (!isRecord(rawGroup)) return rawGroup

    const seedPaths: string[] = []

    for (const key of Array.isArray(rawGroup.seeds) ? rawGroup.seeds : []) {
      const seed = typeof key === 'string' ? seedsByKey.get(key) : undefined

      if (seed !== undefined) for (const fileIndex of seed.fileIndexes) seedPaths.push(table.pathOf(fileIndex))
    }

    const ownPaths = (Array.isArray(rawGroup.filePaths) ? rawGroup.filePaths : []).filter((path): path is string => typeof path === 'string')
    const filePaths = [...seedPaths, ...ownPaths]

    for (const path of filePaths) placedPaths.add(path)

    return { ...rawGroup, filePaths }
  })

  const leftoverGroups = seeds.flatMap(seed => {
    const filePaths = seed.fileIndexes.map(fileIndex => table.pathOf(fileIndex)).filter(path => !placedPaths.has(path))

    if (filePaths.length === 0) return []

    return [{ key: seed.key, label: seed.label, category: seed.category, summary: seed.summary, filePaths }]
  })

  return [...expanded, ...leftoverGroups]
}

function indexedGroupsOf(analysis: ReviewAnalysis, table: FileTable): IndexedGroup[] {
  const fileIndexByPath = new Map<string, number>()

  for (let fileIndex = 0; fileIndex < table.fileCount; fileIndex++) fileIndexByPath.set(table.pathOf(fileIndex), fileIndex)

  const fileIndexOf = (path: string): number => fileIndexByPath.get(path) ?? -1

  return analysis.groups.map(group => {
    const { filePaths, fileNotes, lineNotes, visual, ...remainingFields } = group

    return {
      ...remainingFields,
      fileIndexes: filePaths.map(fileIndexOf).filter(fileIndex => fileIndex >= 0),
      fileNotes: fileNotes.map(({ path, ...note }) => ({ ...note, fileIndex: fileIndexOf(path) })).filter(note => note.fileIndex >= 0),
      lineNotes: lineNotes.map(({ path, ...note }) => ({ ...note, fileIndex: fileIndexOf(path) })).filter(note => note.fileIndex >= 0),
      ...(visual === undefined
        ? {}
        : {
            visual: {
              caption: visual.caption,
              lines: visual.lines.map((line: ReviewVisualLine): IndexedVisualLine => {
                const { anchor, ...remainingLineFields } = line

                if (anchor === undefined || fileIndexOf(anchor.path) < 0) return remainingLineFields

                const { path, ...remainingAnchorFields } = anchor
                const indexedAnchor: IndexedAnchor = { ...remainingAnchorFields, fileIndex: fileIndexOf(path) }

                return { ...remainingLineFields, anchor: indexedAnchor }
              }),
            },
          }),
    }
  })
}

export function analyzeAnswer(answerText: string, table: FileTable, reader: PatchReader, seeds: IndexedGroup[]): AnalyzedAnswer {
  const jsonText = extractJsonText(answerText)

  if (jsonText === null) return { error: 'the answer held no JSON' }

  let parsed: unknown

  try {
    parsed = JSON.parse(jsonText)
  } catch (error) {
    return { error: `the answer's JSON did not parse (${error instanceof Error ? error.message : String(error)})` }
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.groups)) return { error: 'the answer has no "groups" list' }

  const rawGroups = withSeedsExpanded(parsed.groups, seeds, table)
  const files = reviewFilesOf(table, reader, pathsNeedingHunks(rawGroups))
  const analysis = normalizeAnalysis(parsed.overallSummary, rawGroups, files)

  return { overallSummary: analysis.overallSummary, groups: indexedGroupsOf(analysis, table) }
}

function writeAnalysis(reviewDirectory: string, analysis: SessionAnalysis): void {
  const temporaryPath = join(reviewDirectory, `${ANALYSIS_FILE_NAME}.tmp`)

  writeFileSync(temporaryPath, JSON.stringify(analysis))
  renameSync(temporaryPath, join(reviewDirectory, ANALYSIS_FILE_NAME))
}

export function ingestAnalysis(input: {
  reviewDirectory: string
  reviewId: string
  answer?: string
  failedReason?: string
  analysisStartedAt: string
}): IngestOutcome {
  const session = readSession(input.reviewDirectory)

  if (session.reviewId !== input.reviewId) return { isIngested: false, message: 'this review was replaced by a newer one; the answer was dropped' }

  const reader = new PatchReader(join(input.reviewDirectory, session.patchFileName))

  try {
    const table = scanPatch(reader.descriptor, reader.byteLength, { seed: 1 })
    const seeds = seedGroups(table)
    const baseFields: Pick<SessionAnalysis, 'schemaVersion' | 'reviewId' | 'analysisStartedAt'> = { schemaVersion: REVIEW_SESSION_SCHEMA_VERSION, reviewId: session.reviewId, analysisStartedAt: input.analysisStartedAt }

    if (input.failedReason !== undefined || input.answer === undefined) {
      writeAnalysis(input.reviewDirectory, {
        ...baseFields,
        status: AnalysisStatus.Failed,
        error: plainReason(input.failedReason ?? 'no answer'),
        overallSummary: '',
        groups: seeds,
      })

      return { isIngested: true, message: 'recorded the failure; the default grouping stays' }
    }

    const analyzed = analyzeAnswer(input.answer, table, reader, seeds)

    if ('error' in analyzed) {
      writeAnalysis(input.reviewDirectory, {
        ...baseFields,
        status: AnalysisStatus.Failed,
        error: plainReason(analyzed.error),
        overallSummary: '',
        groups: seeds,
      })

      return { isIngested: true, message: `the analysis failed: ${plainReason(analyzed.error)}` }
    }

    writeAnalysis(input.reviewDirectory, { ...baseFields, status: AnalysisStatus.Ready, ...analyzed })

    return { isIngested: true, message: `analysis ready: ${analyzed.groups.length} groups` }
  } finally {
    reader.close()
  }
}
