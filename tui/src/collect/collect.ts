import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildAnalyzerPrompt,
  selectUserRequests,
  SINGLE_USER_REQUEST_CHARACTER_LIMIT,
} from '../review/analysis.ts'
import type { SessionMessageText } from '../review/analysis.ts'
import { ReviewSourceError, openRepository, slugFromKey } from '../review/git.ts'
import type { ReviewSource } from '../review/git.ts'
import { buildReviewFiles } from '../review/patch.ts'
import type { ReviewTarget } from '../review/payload.ts'
import { TargetError, parseTargetArgument } from '../review/target.ts'
import { ReviewTargetKind } from '../review/types.ts'
import { buildLargeAnalyzerPrompt } from '../analysis/largePrompt.ts'
import { buildManifest } from '../analysis/manifest.ts'
import { plainReason } from '../analysis/ingest.ts'
import { seedGroups } from '../analysis/seedGroups.ts'
import { summarizeSeeds } from '../analysis/seedSummaries.ts'
import { ANALYSIS_FILE_NAME } from '../analysis/sessionAnalysis.ts'
import { REVIEW_SESSION_SCHEMA_VERSION } from '../contract.ts'
import type { CollectResult, ReviewSession, SessionAnalysis } from '../contract.ts'
import type { FileTable } from '../patch/fileTable.ts'
import { PatchReader } from '../patch/patchReader.ts'
import { scanPatch } from '../patch/scanIndex.ts'
import { AnalysisStatus } from '../types.ts'
import { createCommandRunner } from './commandRunner.ts'
import { MAXIMUM_CHANGED_ENTRIES } from './diffCommand.ts'
import { pruneSessions, pruneTemporaryEntries } from './retention.ts'
import { resolveTarget } from './resolveTarget.ts'

const SMALL_TIER_MAXIMUM_FILES = 1000
const SMALL_TIER_MAXIMUM_BYTES = 4 * 1024 * 1024
const LABEL_CHARACTER_LIMIT = 80
const TITLE_CHARACTER_LIMIT = 300
const DESCRIPTION_CHARACTER_LIMIT = 20_000
const SMALL_PROMPT_CHARACTER_LIMIT = 256 * 1024
const GENERIC_FAILURE_MESSAGE = 'review-changes could not collect the changes.'
const HASH_CHUNK_BYTES = 1024 * 1024
const HIDDEN_CHARACTERS = /[\p{C}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu
const REVIEW_CHANGES_COMMAND = /<command-name>\/?review-changes<\/command-name>/

export type CollectInput = { target: string; messages: SessionMessageText[] }

function safeLabel(text: string): string {
  return text.replace(HIDDEN_CHARACTERS, '').slice(0, LABEL_CHARACTER_LIMIT)
}

export function modelLabelOf(target: ReviewTarget): string {
  switch (target.kind) {
    case ReviewTargetKind.PullRequest:
      return `pull request #${target.number}`
    case ReviewTargetKind.Worktree:
      return 'uncommitted changes'
    case ReviewTargetKind.Commit:
      return `commit ${target.sha.slice(0, 7)}`
    case ReviewTargetKind.Range:
      return 'the requested range'
  }
}

export function sha256OfFile(path: string): string {
  const hasher = new Bun.CryptoHasher('sha256')
  const descriptor = openSync(path, 'r')
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES)

  try {
    for (;;) {
      const byteCount = readSync(descriptor, buffer, 0, HASH_CHUNK_BYTES, null)

      if (byteCount === 0) break

      hasher.update(buffer.subarray(0, byteCount))
    }
  } finally {
    closeSync(descriptor)
  }

  return hasher.digest('hex')
}

function readExisting<Value>(path: string): Value | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Value
  } catch {
    return undefined
  }
}

function pendingAnalysis(reviewId: string, table: FileTable): SessionAnalysis {
  return {
    schemaVersion: REVIEW_SESSION_SCHEMA_VERSION,
    reviewId,
    status: AnalysisStatus.Pending,
    analysisStartedAt: new Date().toISOString(),
    overallSummary: '',
    groups: seedGroups(table),
  }
}

async function analyzerPromptFor(input: {
  source: ReviewSource
  table: FileTable
  reader: PatchReader
  patchPath: string
  manifestPath: string
  userRequests: string[]
}): Promise<string> {
  const { source, table, reader, patchPath, manifestPath, userRequests } = input
  const isSmall = table.fileCount <= SMALL_TIER_MAXIMUM_FILES && table.patchByteLength <= SMALL_TIER_MAXIMUM_BYTES

  if (isSmall) {
    const files = await buildReviewFiles(readFileSync(patchPath, 'utf8'))

    const smallPrompt = buildAnalyzerPrompt(source, files, patchPath, userRequests)

    if (smallPrompt.length <= SMALL_PROMPT_CHARACTER_LIMIT) return smallPrompt
  }

  const seeds = seedGroups(table)

  writeFileSync(manifestPath, buildManifest(table, seeds))

  return buildLargeAnalyzerPrompt({
    title: source.title,
    targetLabel: source.target.label,
    pullRequestUrl: source.target.kind === ReviewTargetKind.PullRequest ? source.target.url : undefined,
    description: source.description,
    userRequests,
    commits: source.commits,
    seeds: summarizeSeeds(seeds, table, reader),
    fileCount: table.fileCount,
    additions: table.totalAdditions(),
    deletions: table.totalDeletions(),
    manifestPath,
    patchPath,
  })
}

async function collectUnchecked(input: CollectInput, workingDirectory: string): Promise<CollectResult> {
  const request = parseTargetArgument(input.target)
  const runCommand = createCommandRunner()
  const context = await openRepository(runCommand, workingDirectory)
  const reviewRoot = join(context.gitCommonDirectory, 'review-changes')
  const sessionsDirectory = join(reviewRoot, 'sessions')
  const temporaryRoot = join(reviewRoot, 'tmp')

  for (const directory of [sessionsDirectory, temporaryRoot, join(reviewRoot, 'reviewed')]) mkdirSync(directory, { recursive: true, mode: 0o700 })

  pruneTemporaryEntries(temporaryRoot, Date.now())

  const runDirectory = mkdtempSync(join(temporaryRoot, 'run-'))
  const patchTemporaryPath = join(runDirectory, 'patch.tmp')

  try {
    const resolved = await resolveTarget(context, request)
    const details = await resolved.writePatch({ scratchDirectory: join(runDirectory, 'scratch'), outputPath: patchTemporaryPath })
    const label = safeLabel(details.target.label)
    const modelLabel = modelLabelOf(details.target)

    details.title = details.title.slice(0, TITLE_CHARACTER_LIMIT)
    details.description = details.description?.slice(0, DESCRIPTION_CHARACTER_LIMIT)

    if (!existsSync(patchTemporaryPath) || statSync(patchTemporaryPath).size === 0) {
      return { isCollected: false, message: `No changes in ${label}.`, modelMessage: `No changes in ${modelLabel}.` }
    }

    const reader = new PatchReader(patchTemporaryPath)

    try {
      const table = scanPatch(reader.descriptor, reader.byteLength, { seed: 1 })

      if (table.fileCount === 0) return { isCollected: false, message: `No changes in ${label}.`, modelMessage: `No changes in ${modelLabel}.` }

      if (table.fileCount > MAXIMUM_CHANGED_ENTRIES) {
        return { isCollected: false, message: `${table.fileCount} files changed, over the limit of ${MAXIMUM_CHANGED_ENTRIES}; review a narrower target.`, modelMessage: `More than ${MAXIMUM_CHANGED_ENTRIES} files changed; review a narrower target.` }
      }

      const patchDigest = sha256OfFile(patchTemporaryPath)
      const slug = `${slugFromKey(details.target.key)}-${Bun.hash(details.target.key + context.repository.root).toString(16).padStart(8, '0').slice(-8)}`
      const reviewDirectory = join(sessionsDirectory, slug)
      const existingSession = readExisting<ReviewSession>(join(reviewDirectory, 'review.json'))
      const existingAnalysis = readExisting<SessionAnalysis>(join(reviewDirectory, ANALYSIS_FILE_NAME))
      const isAnalysisCurrent =
        existingSession?.patchDigest === patchDigest &&
        existingAnalysis?.reviewId === existingSession.reviewId &&
        existingAnalysis.status === AnalysisStatus.Ready
      const reviewId = isAnalysisCurrent ? existingSession.reviewId : crypto.randomUUID()
      const patchPath = join(reviewDirectory, 'patch.diff')
      const manifestPath = join(reviewDirectory, 'manifest.tsv')

      mkdirSync(reviewDirectory, { recursive: true, mode: 0o700 })

      let analyzerPrompt = ''

      if (isAnalysisCurrent) {
        const now = new Date()

        utimesSync(reviewDirectory, now, now)
      } else {
        rmSync(join(reviewDirectory, 'review.json'), { force: true })
        renameSync(patchTemporaryPath, patchPath)

        const source: ReviewSource = {
          repository: context.repository,
          gitCommonDirectory: context.gitCommonDirectory,
          target: details.target,
          slug,
          title: details.title,
          description: details.description,
          commits: details.commits,
          patch: '',
        }
        const userRequests = selectUserRequests(
          input.messages
            .filter(message => !REVIEW_CHANGES_COMMAND.test(message.text))
            .map(message => ({ ...message, text: message.text.slice(0, SINGLE_USER_REQUEST_CHARACTER_LIMIT + 1) })),
        )
        const session: ReviewSession = {
          schemaVersion: REVIEW_SESSION_SCHEMA_VERSION,
          reviewId,
          patchDigest,
          generatedAt: new Date().toISOString(),
          repository: context.repository,
          target: details.target,
          title: details.title,
          ...(details.description === undefined ? {} : { description: details.description }),
          commits: details.commits,
          patchFileName: 'patch.diff',
          patchByteLength: reader.byteLength,
        }

        analyzerPrompt = await analyzerPromptFor({ source, table, reader, patchPath, manifestPath, userRequests })
        writeFileSync(join(reviewDirectory, `${ANALYSIS_FILE_NAME}.tmp`), JSON.stringify(pendingAnalysis(reviewId, table)))
        renameSync(join(reviewDirectory, `${ANALYSIS_FILE_NAME}.tmp`), join(reviewDirectory, ANALYSIS_FILE_NAME))
        writeFileSync(join(reviewDirectory, 'review.json.tmp'), JSON.stringify(session))
        renameSync(join(reviewDirectory, 'review.json.tmp'), join(reviewDirectory, 'review.json'))
      }

      pruneSessions(sessionsDirectory)

      return {
        isCollected: true,
        reviewId,
        reviewDirectory,
        repositoryRoot: context.repository.root,
        label,
        modelLabel,
        fileCount: table.fileCount,
        additions: table.totalAdditions(),
        deletions: table.totalDeletions(),
        isAnalysisCurrent,
        analyzerPrompt,
      }
    } finally {
      reader.close()
    }
  } finally {
    rmSync(runDirectory, { recursive: true, force: true })
  }
}

export async function collect(input: CollectInput, workingDirectory: string): Promise<CollectResult> {
  try {
    return await collectUnchecked(input, workingDirectory)
  } catch (error) {
    if (error instanceof TargetError) {
      const message = plainReason(error.message)

      return { isCollected: false, message, modelMessage: message }
    }

    if (error instanceof ReviewSourceError) return { isCollected: false, message: plainReason(error.message), modelMessage: GENERIC_FAILURE_MESSAGE }

    return {
      isCollected: false,
      message: plainReason(`review-changes failed: ${error instanceof Error ? error.message : String(error)}`),
      modelMessage: GENERIC_FAILURE_MESSAGE,
    }
  }
}
