import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { ReviewCategory, ReviewFileStatus, ReviewTargetKind } from '../../../plugins/review-changes/hooks/types.ts'
import type { ReviewFile, ReviewPayload } from '../../../plugins/review-changes/hooks/payload.ts'
import {
  readCollapseReviewed,
  readLayout,
  readReviewed,
  writeCollapseReviewed,
  writeLayout,
  writeReviewed,
} from '../storage.ts'
import { DiffLayout } from '../types.ts'

function payloadFor(repositoryRoot: string, targetKey: string): ReviewPayload {
  return {
    schemaVersion: 1,
    generatedAt: '2026-01-01T00:00:00Z',
    repository: { root: repositoryRoot, name: 'repo' },
    target: { kind: ReviewTargetKind.Worktree, key: targetKey, label: 'Working tree', branch: null, base: 'HEAD' },
    title: 'Title',
    commits: [],
    files: [],
    analysis: { overallSummary: '', groups: [{ key: 'g', label: 'G', category: ReviewCategory.Other, summary: '', filePaths: [], fileNotes: [], lineNotes: [] }] },
  }
}

function fileFor(path: string, patchHash: string): ReviewFile {
  return {
    path,
    status: ReviewFileStatus.Modified,
    additions: 1,
    deletions: 0,
    isBinary: false,
    hunks: [],
    patch: '',
    patchHash,
    isPatchOmitted: false,
  }
}

function refuseLocalStorage(): void {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() {
      throw new DOMException('storage refused', 'SecurityError')
    },
  })
}

const realLocalStorageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  if (realLocalStorageDescriptor) Object.defineProperty(window, 'localStorage', realLocalStorageDescriptor)
})

describe('layout', () => {
  test('defaults to unified', () => {
    expect(readLayout()).toBe(DiffLayout.Unified)
  })

  test('returns the layout last written', () => {
    writeLayout(DiffLayout.Split)
    expect(readLayout()).toBe(DiffLayout.Split)

    writeLayout(DiffLayout.Unified)
    expect(readLayout()).toBe(DiffLayout.Unified)
  })

  test('falls back to unified when the stored value is not a known layout', () => {
    window.localStorage.setItem('review-changes:layout', 'sideways')

    expect(readLayout()).toBe(DiffLayout.Unified)
  })

  test('keeps the last written layout for the session when storage refuses access', () => {
    refuseLocalStorage()

    writeLayout(DiffLayout.Split)

    expect(readLayout()).toBe(DiffLayout.Split)
  })
})

describe('collapse reviewed', () => {
  test('defaults to collapsing reviewed files', () => {
    expect(readCollapseReviewed()).toBe(true)
  })

  test('returns the choice last written', () => {
    writeCollapseReviewed(false)
    expect(readCollapseReviewed()).toBe(false)

    writeCollapseReviewed(true)
    expect(readCollapseReviewed()).toBe(true)
  })

  test('keeps the last written choice for the session when storage refuses access', () => {
    refuseLocalStorage()

    writeCollapseReviewed(false)

    expect(readCollapseReviewed()).toBe(false)
  })
})

describe('reviewed', () => {
  const payload = payloadFor('/work/repo', 'worktree')
  const file = fileFor('src/a.ts', 'hash-1')

  test('is not reviewed by default', () => {
    expect(readReviewed(payload, file)).toBe(false)
  })

  test('returns the state last written and can be cleared again', () => {
    writeReviewed(payload, file, true)
    expect(readReviewed(payload, file)).toBe(true)

    writeReviewed(payload, file, false)
    expect(readReviewed(payload, file)).toBe(false)
  })

  test('marks only the written file', () => {
    writeReviewed(payload, file, true)

    expect(readReviewed(payload, fileFor('src/b.ts', 'hash-1'))).toBe(false)
  })

  test('treats a file whose patch changed as unreviewed', () => {
    writeReviewed(payload, file, true)

    expect(readReviewed(payload, fileFor('src/a.ts', 'hash-2'))).toBe(false)
  })

  test('treats the same file in another target or repository as unreviewed', () => {
    writeReviewed(payload, file, true)

    expect(readReviewed(payloadFor('/work/repo', 'pull-request:7'), file)).toBe(false)
    expect(readReviewed(payloadFor('/work/other', 'worktree'), file)).toBe(false)
  })

  test('remembers the original patch as reviewed after a change and a revert', () => {
    writeReviewed(payload, file, true)

    expect(readReviewed(payload, fileFor('src/a.ts', 'hash-2'))).toBe(false)
    expect(readReviewed(payload, file)).toBe(true)
  })

  test('keeps reviewed state for the session when storage refuses access', () => {
    const refusedPayload = payloadFor('/work/refused', 'worktree')
    refuseLocalStorage()

    expect(readReviewed(refusedPayload, file)).toBe(false)

    writeReviewed(refusedPayload, file, true)
    expect(readReviewed(refusedPayload, file)).toBe(true)
    expect(readReviewed(refusedPayload, fileFor('src/a.ts', 'hash-2'))).toBe(false)

    writeReviewed(refusedPayload, file, false)
    expect(readReviewed(refusedPayload, file)).toBe(false)
  })
})
