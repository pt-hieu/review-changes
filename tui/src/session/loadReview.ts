import { join } from 'node:path'
import { REVIEW_SESSION_SCHEMA_VERSION, type ReviewSession } from '../contract.ts'
import { readFileSync } from 'node:fs'
import { isRecord, memberOf, optionalString } from '../json.ts'
import type { ReviewCommit, ReviewRepository, ReviewTarget } from '../review/payload.ts'
import { ReviewTargetKind } from '../review/types.ts'
import { scanPatch } from '../patch/scanIndex.ts'
import { PatchReader } from '../patch/patchReader.ts'
import type { FileTable } from '../patch/fileTable.ts'
import { LineIndexCache } from '../patch/lineIndex.ts'

export class UnsupportedSchemaError extends Error {}

export type LoadedReview = {
  session: ReviewSession
  table: FileTable
  reader: PatchReader
  lineIndexes: LineIndexCache
  scanMilliseconds: number
}

const PATCH_FILE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/

function parseRepository(value: unknown): ReviewRepository | undefined {
  if (!isRecord(value) || typeof value.root !== 'string' || typeof value.name !== 'string') return undefined

  return { root: value.root, name: value.name }
}

function parseCommit(value: unknown): ReviewCommit | undefined {
  if (!isRecord(value) || typeof value.sha !== 'string' || typeof value.subject !== 'string' || typeof value.author !== 'string') return undefined

  return { sha: value.sha, subject: value.subject, author: value.author }
}

function parseCommits(value: unknown): ReviewCommit[] | undefined {
  if (!Array.isArray(value)) return undefined

  const commits = value.map(parseCommit).filter(commit => commit !== undefined)

  return commits.length === value.length ? commits : undefined
}

function parseTarget(value: unknown): ReviewTarget | undefined {
  if (!isRecord(value) || typeof value.key !== 'string' || typeof value.label !== 'string') return undefined

  const { key, label } = value
  const kind = memberOf(Object.values(ReviewTargetKind), value.kind)

  switch (kind) {
    case undefined:
      return undefined
    case ReviewTargetKind.Worktree:
      if (typeof value.base !== 'string' || (value.branch !== null && typeof value.branch !== 'string')) return undefined

      return { kind, key, label, branch: value.branch, base: value.base }
    case ReviewTargetKind.Range:
      if (typeof value.base !== 'string' || typeof value.head !== 'string' || typeof value.isMergeBase !== 'boolean') return undefined

      return { kind, key, label, base: value.base, head: value.head, isMergeBase: value.isMergeBase }
    case ReviewTargetKind.Commit:
      if (typeof value.revision !== 'string' || typeof value.sha !== 'string') return undefined

      return { kind, key, label, revision: value.revision, sha: value.sha }
    case ReviewTargetKind.PullRequest:
      if (
        typeof value.number !== 'number' ||
        typeof value.url !== 'string' ||
        typeof value.baseRef !== 'string' ||
        typeof value.headRef !== 'string' ||
        typeof value.state !== 'string' ||
        (value.author !== null && typeof value.author !== 'string')
      ) {
        return undefined
      }

      return { kind, key, label, number: value.number, url: value.url, baseRef: value.baseRef, headRef: value.headRef, author: value.author, state: value.state }
    default: {
      const unhandledKind: never = kind
      return unhandledKind
    }
  }
}

export function parseReviewSession(value: unknown): ReviewSession | undefined {
  if (!isRecord(value) || value.schemaVersion !== REVIEW_SESSION_SCHEMA_VERSION) return undefined

  const repository = parseRepository(value.repository)
  const target = parseTarget(value.target)
  const commits = parseCommits(value.commits)
  const description = optionalString(value.description)
  const { reviewId, patchDigest, generatedAt, title, patchFileName, patchByteLength } = value

  if (repository === undefined || target === undefined || commits === undefined) return undefined
  if (typeof reviewId !== 'string' || typeof patchDigest !== 'string' || typeof generatedAt !== 'string' || typeof title !== 'string') return undefined
  if (typeof patchFileName !== 'string' || typeof patchByteLength !== 'number') return undefined

  return {
    schemaVersion: REVIEW_SESSION_SCHEMA_VERSION,
    reviewId,
    patchDigest,
    generatedAt,
    repository,
    target,
    title,
    ...(description === undefined ? {} : { description }),
    commits,
    patchFileName,
    patchByteLength,
  }
}

export function readSession(reviewDirectory: string): ReviewSession {
  const parsed: unknown = JSON.parse(readFileSync(join(reviewDirectory, 'review.json'), 'utf8'))
  const schemaVersion = isRecord(parsed) ? parsed.schemaVersion : undefined

  if (schemaVersion !== REVIEW_SESSION_SCHEMA_VERSION) {
    throw new UnsupportedSchemaError(`unsupported review schema version ${String(schemaVersion)}`)
  }

  const patchFileName = isRecord(parsed) ? parsed.patchFileName : undefined

  if (typeof patchFileName !== 'string' || !PATCH_FILE_NAME_PATTERN.test(patchFileName)) {
    throw new Error('review.json names an invalid patch file')
  }

  const session = parseReviewSession(parsed)

  if (session === undefined) throw new Error('review.json does not hold a review')

  return session
}

export function loadReview(reviewDirectory: string, seed: number): LoadedReview {
  const session = readSession(reviewDirectory)
  const patchPath = join(reviewDirectory, session.patchFileName)
  const reader = new PatchReader(patchPath)

  if (reader.byteLength !== session.patchByteLength) {
    reader.close()

    throw new Error('the patch does not match review.json; collect the review again')
  }

  const started = performance.now()
  const table = scanPatch(reader.descriptor, reader.byteLength, { seed })
  const scanMilliseconds = performance.now() - started

  return { session, table, reader, lineIndexes: new LineIndexCache(table, reader), scanMilliseconds }
}
