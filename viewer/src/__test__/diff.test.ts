import { describe, expect, test } from 'bun:test'
import { ReviewFileStatus } from '../../../plugins/review-changes/hooks/types.ts'
import type { ReviewFile } from '../../../plugins/review-changes/hooks/payload.ts'
import { estimateUnifiedRowCount } from '../diff.ts'

function fileWith(hunkOldLines: number[], additions: number): ReviewFile {
  return {
    path: 'src/a.ts',
    status: ReviewFileStatus.Modified,
    additions,
    deletions: 0,
    isBinary: false,
    hunks: hunkOldLines.map((oldLines) => ({ header: '', oldStart: 1, oldLines, newStart: 1, newLines: 0 })),
    patch: '',
    patchHash: 'hash',
    isPatchOmitted: false,
  }
}

describe('estimateUnifiedRowCount', () => {
  test('is zero for a file with no hunks and no additions', () => {
    expect(estimateUnifiedRowCount(fileWith([], 0))).toBe(0)
  })

  test('counts a hunk header row plus its old lines, plus every added line', () => {
    expect(estimateUnifiedRowCount(fileWith([10], 4))).toBe(15)
  })

  test('adds one header row per hunk', () => {
    expect(estimateUnifiedRowCount(fileWith([3, 0, 7], 2))).toBe(15)
  })

  test('counts only added lines for a new file whose hunk has no old lines', () => {
    expect(estimateUnifiedRowCount(fileWith([0], 25))).toBe(26)
  })
})
