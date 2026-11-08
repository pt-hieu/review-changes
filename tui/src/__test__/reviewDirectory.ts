import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ReviewTargetKind } from '../review/types.ts'
import { REVIEW_SESSION_SCHEMA_VERSION, type ReviewSession } from '../contract.ts'

export const PATCH_INDEX_LINE = 'index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644'

export function writeReviewDirectory(
  parentDirectory: string,
  patch: string | Uint8Array,
  overrides: Partial<ReviewSession> = {},
): string {
  mkdirSync(parentDirectory, { recursive: true })
  const reviewDirectory = mkdtempSync(join(parentDirectory, 'review-'))
  const patchBytes = typeof patch === 'string' ? Buffer.from(patch) : patch

  writeFileSync(join(reviewDirectory, 'patch.diff'), patchBytes)

  const session: ReviewSession = {
    schemaVersion: REVIEW_SESSION_SCHEMA_VERSION,
    reviewId: 'review-1',
    patchDigest: 'digest',
    generatedAt: '2026-01-01T00:00:00.000Z',
    repository: { root: '/tmp/repository', name: 'repository' },
    target: { kind: ReviewTargetKind.Worktree, key: 'worktree', label: 'worktree', branch: null, base: 'HEAD' },
    title: 'Fixture review',
    commits: [],
    patchFileName: 'patch.diff',
    patchByteLength: patchBytes.length,
    ...overrides,
  }

  writeFileSync(join(reviewDirectory, 'review.json'), JSON.stringify(session))

  return reviewDirectory
}

export function modifiedFilePatch(path: string, bodyLines: string[]): string {
  const added = bodyLines.length

  return [
    `diff --git a/${path} b/${path}`,
    PATCH_INDEX_LINE,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -0,0 +1,${added} @@`,
    ...bodyLines.map(line => `+${line}`),
    '',
  ].join('\n')
}

export function fileSection(path: string, additions: number, deletions: number): string {
  return [
    `diff --git a/${path} b/${path}`,
    PATCH_INDEX_LINE,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${deletions} +1,${additions} @@`,
    ...Array.from({ length: deletions }, (_unused, line) => `-old ${line}`),
    ...Array.from({ length: additions }, (_unused, line) => `+new ${line}`),
    '',
  ].join('\n')
}

export function binaryFileSection(path: string): string {
  return `diff --git a/${path} b/${path}\n${PATCH_INDEX_LINE}\nBinary files a/${path} and b/${path} differ\n`
}
