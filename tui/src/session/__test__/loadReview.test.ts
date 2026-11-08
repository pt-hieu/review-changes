import { afterAll, describe, expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { modifiedFilePatch, writeReviewDirectory } from '../../__test__/reviewDirectory.ts'
import { loadReview, UnsupportedSchemaError } from '../loadReview.ts'

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
