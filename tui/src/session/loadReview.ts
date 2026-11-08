import { join } from 'node:path'
import { REVIEW_SESSION_SCHEMA_VERSION, type ReviewSession } from '../contract.ts'
import { readFileSync } from 'node:fs'
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

export function readSession(reviewDirectory: string): ReviewSession {
  const parsed = JSON.parse(readFileSync(join(reviewDirectory, 'review.json'), 'utf8')) as Partial<ReviewSession>

  if (parsed.schemaVersion !== REVIEW_SESSION_SCHEMA_VERSION) {
    throw new UnsupportedSchemaError(`unsupported review schema version ${String(parsed.schemaVersion)}`)
  }

  if (typeof parsed.patchFileName !== 'string' || !PATCH_FILE_NAME_PATTERN.test(parsed.patchFileName)) {
    throw new Error('review.json names an invalid patch file')
  }

  return parsed as ReviewSession
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
