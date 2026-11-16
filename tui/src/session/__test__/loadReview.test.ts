import { afterAll, describe, expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { modifiedFilePatch, writeReviewDirectory } from '../../__test__/reviewDirectory.ts'
import { REVIEW_SESSION_SCHEMA_VERSION } from '../../contract.ts'
import { ReviewTargetKind } from '../../review/types.ts'
import { loadReview, parseReviewSession, UnsupportedSchemaError } from '../loadReview.ts'

const temporaryDirectory = join(tmpdir(), `load-review-test-${process.pid}`)
const PATCH = modifiedFilePatch('a.txt', ['one', 'two'])

afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }))

describe('loadReview', () => {
  test('loads a review whose patch matches review.json', () => {
    const review = loadReview(writeReviewDirectory(temporaryDirectory, PATCH), 1)

    expect(review.table.fileCount).toBe(1)
    expect(review.table.pathOf(0)).toBe('a.txt')
    review.reader.close()
  })

  test('rejects a patch longer than review.json says', () => {
    const directory = writeReviewDirectory(temporaryDirectory, PATCH, { patchByteLength: PATCH.length - 1 })

    expect(() => loadReview(directory, 1)).toThrow('the patch does not match review.json')
  })

  test('rejects a patch shorter than review.json says', () => {
    const directory = writeReviewDirectory(temporaryDirectory, PATCH, { patchByteLength: PATCH.length + 1 })

    expect(() => loadReview(directory, 1)).toThrow('the patch does not match review.json')
  })

  test('rejects a patch swapped after collection for one of a different length', () => {
    const directory = writeReviewDirectory(temporaryDirectory, PATCH)
    writeFileSync(join(directory, 'patch.diff'), `${PATCH}+three\n`)

    expect(() => loadReview(directory, 1)).toThrow('the patch does not match review.json')
  })

  test('rejects a review.json that names a patch outside its directory', () => {
    const directory = writeReviewDirectory(temporaryDirectory, PATCH, { patchFileName: '../patch.diff' })

    expect(() => loadReview(directory, 1)).toThrow('invalid patch file')
  })

  test('rejects a review of an unknown schema version with the dedicated error', () => {
    const directory = writeReviewDirectory(temporaryDirectory, PATCH, { schemaVersion: 99 as never })

    expect(() => loadReview(directory, 1)).toThrow(UnsupportedSchemaError)
  })
})

describe('parseReviewSession', () => {
  const written = {
    schemaVersion: REVIEW_SESSION_SCHEMA_VERSION,
    reviewId: 'review-1',
    patchDigest: 'digest',
    generatedAt: '2026-01-01T00:00:00.000Z',
    repository: { root: '/repo', name: 'repo' },
    target: { kind: 'pull-request', key: 'pr-7', label: 'PR #7', number: 7, url: 'https://github.com/ada/repo/pull/7', baseRef: 'main', headRef: 'search', author: null, state: 'OPEN' },
    title: 'Add search',
    commits: [{ sha: 'abc', subject: 'Add search', author: 'Ada' }],
    patchFileName: 'patch.diff',
    patchByteLength: 12,
  }

  test('reads a written session, its target kind included', () => {
    expect(parseReviewSession(written)).toEqual({
      schemaVersion: REVIEW_SESSION_SCHEMA_VERSION,
      reviewId: 'review-1',
      patchDigest: 'digest',
      generatedAt: '2026-01-01T00:00:00.000Z',
      repository: { root: '/repo', name: 'repo' },
      target: {
        kind: ReviewTargetKind.PullRequest,
        key: 'pr-7',
        label: 'PR #7',
        number: 7,
        url: 'https://github.com/ada/repo/pull/7',
        baseRef: 'main',
        headRef: 'search',
        author: null,
        state: 'OPEN',
      },
      title: 'Add search',
      commits: [{ sha: 'abc', subject: 'Add search', author: 'Ada' }],
      patchFileName: 'patch.diff',
      patchByteLength: 12,
    })
  })

  test('rejects a session whose target lacks the fields of its kind', () => {
    expect(parseReviewSession({ ...written, target: { kind: 'range', key: 'range', label: 'range', base: 'main' } })).toBeUndefined()
    expect(parseReviewSession({ ...written, target: { ...written.target, kind: 'branch' } })).toBeUndefined()
  })

  test('rejects a session with a malformed commit or a missing field', () => {
    expect(parseReviewSession({ ...written, commits: [{ sha: 'abc' }] })).toBeUndefined()
    expect(parseReviewSession({ ...written, title: undefined })).toBeUndefined()
  })
})
