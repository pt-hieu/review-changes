import { describe, expect, test } from 'bun:test'
import { REVIEW_SESSION_SCHEMA_VERSION } from '../../contract.ts'
import { ReviewCategory, ReviewLineSide, ReviewVisualChange } from '../../review/types.ts'
import { AnalysisStatus } from '../../types.ts'
import { parseSessionAnalysis } from '../sessionAnalysis.ts'

const GROUP = {
  key: 'search',
  label: 'Search',
  category: 'core',
  summary: 'Adds search.',
  fileIndexes: [0, 1],
  fileNotes: [{ fileIndex: 0, text: 'Read this first.', critical: true }],
  lineNotes: [{ fileIndex: 1, side: 'additions', line: 4, text: 'New branch.' }],
  visual: { caption: 'Flow', lines: [{ text: 'query', depth: 0, change: 'added', anchor: { fileIndex: 1, side: 'additions', line: 4 } }] },
}

function analysisWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: REVIEW_SESSION_SCHEMA_VERSION,
    reviewId: 'review-1',
    status: 'ready',
    analysisStartedAt: '2026-01-01T00:00:00.000Z',
    overallSummary: 'Adds search.',
    groups: [GROUP],
    ...overrides,
  }
}

describe('parseSessionAnalysis', () => {
  test('reads a written analysis into enum members', () => {
    expect(parseSessionAnalysis(analysisWith({}))).toEqual({
      schemaVersion: REVIEW_SESSION_SCHEMA_VERSION,
      reviewId: 'review-1',
      status: AnalysisStatus.Ready,
      analysisStartedAt: '2026-01-01T00:00:00.000Z',
      overallSummary: 'Adds search.',
      groups: [
        {
          key: 'search',
          label: 'Search',
          category: ReviewCategory.Core,
          summary: 'Adds search.',
          fileIndexes: [0, 1],
          fileNotes: [{ fileIndex: 0, text: 'Read this first.', critical: true }],
          lineNotes: [{ fileIndex: 1, side: ReviewLineSide.Additions, line: 4, text: 'New branch.' }],
          visual: {
            caption: 'Flow',
            lines: [{ text: 'query', depth: 0, change: ReviewVisualChange.Added, anchor: { fileIndex: 1, side: ReviewLineSide.Additions, line: 4 } }],
          },
        },
      ],
    })
  })

  test('rejects another schema version, an unknown status, or a group without its fields', () => {
    expect(parseSessionAnalysis(analysisWith({ schemaVersion: 99 }))).toBeUndefined()
    expect(parseSessionAnalysis(analysisWith({ status: 'thinking' }))).toBeUndefined()
    expect(parseSessionAnalysis(analysisWith({ groups: [{ key: 'search' }] }))).toBeUndefined()
    expect(parseSessionAnalysis(null)).toBeUndefined()
  })

  test('files an unknown category under other and drops notes it cannot read', () => {
    const parsed = parseSessionAnalysis(analysisWith({ groups: [{ ...GROUP, category: 'misc', fileNotes: [{ text: 'no file' }], lineNotes: [{ fileIndex: 1, side: 'up', line: 4, text: 'bad side' }] }] }))

    expect(parsed?.groups[0]?.category).toBe(ReviewCategory.Other)
    expect(parsed?.groups[0]?.fileNotes).toEqual([])
    expect(parsed?.groups[0]?.lineNotes).toEqual([])
  })
})
