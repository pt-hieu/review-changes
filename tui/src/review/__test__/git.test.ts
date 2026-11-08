import { describe, expect, test } from 'bun:test'

import { findReviewCandidate } from '../git.ts'
import { createFakeRunCommand, createRepository } from './fakeGit.ts'
import type { FakeCommit, FakeRepository } from './fakeGit.ts'

const ROOT_SHA = '1'.repeat(40)
const FEATURE_SHA = '2'.repeat(40)
const TEST_SHA = '3'.repeat(40)

const APP_PATCH = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1 +1 @@',
  '-start(1)',
  '+start(2)',
  '',
].join('\n')

const FEATURE_PATCH = [
  'diff --git a/src/feature.ts b/src/feature.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/feature.ts',
  '@@ -0,0 +1 @@',
  '+export const feature = true',
  '',
].join('\n')

const TEST_PATCH = [
  'diff --git a/src/feature.test.ts b/src/feature.test.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/feature.test.ts',
  '@@ -0,0 +1 @@',
  '+test(feature)',
  '',
].join('\n')

const ROOT_COMMIT: FakeCommit = { sha: ROOT_SHA, subject: 'Start the app', author: 'Ada Lovelace', patch: APP_PATCH }
const FEATURE_COMMIT: FakeCommit = { sha: FEATURE_SHA, parent: ROOT_SHA, subject: 'Add the feature', author: 'Ada Lovelace', patch: FEATURE_PATCH }
const TEST_COMMIT: FakeCommit = { sha: TEST_SHA, parent: FEATURE_SHA, subject: 'Test the feature', author: 'Ada Lovelace', patch: TEST_PATCH }

function cleanOnMain(overrides: Partial<FakeRepository> = {}): FakeRepository {
  return createRepository({ branches: { main: ROOT_SHA }, commits: [ROOT_COMMIT], ...overrides })
}

function featureAheadOfMain(overrides: Partial<FakeRepository> = {}): FakeRepository {
  return createRepository({
    currentBranch: 'feature',
    branches: { main: ROOT_SHA, feature: TEST_SHA },
    commits: [ROOT_COMMIT, FEATURE_COMMIT, TEST_COMMIT],
    ...overrides,
  })
}

describe('findReviewCandidate', () => {
  function candidateOf(repository: FakeRepository) {
    return findReviewCandidate(createFakeRunCommand({ repository }), '/work/shop')
  }

  test('counts uncommitted files, a rename once', async () => {
    const repository = cleanOnMain({ statusEntries: ['R  lib/after.ts\0lib/before.ts', '?? notes.md'] })

    expect(await candidateOf(repository)).toEqual({ summary: '2 uncommitted files' })
  })

  test('says "file" for a single uncommitted file', async () => {
    expect(await candidateOf(cleanOnMain({ statusEntries: [' M src/app.ts'] }))).toEqual({ summary: '1 uncommitted file' })
  })

  test('reports commits ahead of the default branch when clean', async () => {
    expect(await candidateOf(featureAheadOfMain())).toEqual({ summary: '2 commits ahead of main' })
  })

  test('says "commit" for a single commit ahead', async () => {
    const repository = featureAheadOfMain({ branches: { main: ROOT_SHA, feature: FEATURE_SHA } })

    expect(await candidateOf(repository)).toEqual({ summary: '1 commit ahead of main' })
  })

  test('is null when clean and level with the default branch', async () => {
    expect(await candidateOf(cleanOnMain())).toBeNull()
  })

  test('is null outside a repository', async () => {
    expect(await candidateOf(createRepository({ root: null }))).toBeNull()
  })
})
