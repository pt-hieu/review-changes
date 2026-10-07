import { describe, expect, test } from 'claude-code/testing'

import { findReviewCandidate, resolveReviewSource } from '../git.ts'
import { ReviewTargetKind, TargetRequestKind } from '../types.ts'
import { createFakeRunCommand, createRepository } from './fakeGit.ts'
import type { FakeCommit, FakeEnvironment, FakePullRequest, FakeRepository } from './fakeGit.ts'

const AUTO_REQUEST = { kind: TargetRequestKind.Auto } as const
const WORKTREE_REQUEST = { kind: TargetRequestKind.Worktree } as const

const ROOT_SHA = '1'.repeat(40)
const FEATURE_SHA = '2'.repeat(40)
const TEST_SHA = '3'.repeat(40)
const MAIN_SHA = '4'.repeat(40)

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

const NOTES_PATCH = [
  'diff --git a/notes/todo.md b/notes/todo.md',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/notes/todo.md',
  '@@ -0,0 +1 @@',
  '+hello world',
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

const MAIN_PATCH = [
  'diff --git a/src/other.ts b/src/other.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/other.ts',
  '@@ -0,0 +1 @@',
  '+export const other = 1',
  '',
].join('\n')

const ROOT_COMMIT: FakeCommit = { sha: ROOT_SHA, subject: 'Start the app', author: 'Ada Lovelace', patch: APP_PATCH }
const FEATURE_COMMIT: FakeCommit = { sha: FEATURE_SHA, parent: ROOT_SHA, subject: 'Add the feature', author: 'Ada Lovelace', patch: FEATURE_PATCH }
const TEST_COMMIT: FakeCommit = { sha: TEST_SHA, parent: FEATURE_SHA, subject: 'Test the feature', author: 'Ada Lovelace', patch: TEST_PATCH }
const MAIN_COMMIT: FakeCommit = { sha: MAIN_SHA, parent: ROOT_SHA, subject: 'Move main on', author: 'Ada Lovelace', patch: MAIN_PATCH }

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

function resolveFrom(environment: FakeEnvironment, request: Parameters<typeof resolveReviewSource>[2]) {
  return resolveReviewSource(createFakeRunCommand(environment), '/work/shop/src', request)
}

describe('resolveReviewSource, automatic target', () => {
  test('picks the uncommitted changes when the worktree is dirty', async () => {
    const repository = cleanOnMain({ statusEntries: [' M src/app.ts'], trackedPatch: APP_PATCH })

    const source = await resolveFrom({ repository }, AUTO_REQUEST)

    expect(source.repository).toEqual({ root: '/work/shop', name: 'shop' })
    expect(source.gitCommonDirectory).toBe('/work/shop/.git')
    expect(source.target).toMatchObject({ kind: ReviewTargetKind.Worktree, label: 'Uncommitted changes on main', branch: 'main' })
    expect(source.title).toBe('Uncommitted changes on main')
    expect(source.commits).toEqual([])
    expect(source.patch).toBe(APP_PATCH)
  })

  test('picks the branch from its merge base with the default branch when clean and ahead', async () => {
    const source = await resolveFrom({ repository: featureAheadOfMain() }, AUTO_REQUEST)

    expect(source.target).toMatchObject({ kind: ReviewTargetKind.Range, label: 'HEAD vs main', base: 'main', head: 'HEAD', isMergeBase: true })
    expect(source.commits).toEqual([
      { sha: FEATURE_SHA, subject: 'Add the feature', author: 'Ada Lovelace' },
      { sha: TEST_SHA, subject: 'Test the feature', author: 'Ada Lovelace' },
    ])
    expect(source.title).toBe('HEAD vs main')
    expect(source.patch).toBe(FEATURE_PATCH + TEST_PATCH)
  })

  test('a branch with a single commit takes that commit’s subject as the title', async () => {
    const repository = featureAheadOfMain({ branches: { main: ROOT_SHA, feature: FEATURE_SHA } })

    const source = await resolveFrom({ repository }, AUTO_REQUEST)

    expect(source.title).toBe('Add the feature')
  })

  test('a branch that moved on from the default branch shows only its own commits', async () => {
    const repository = featureAheadOfMain({
      branches: { main: MAIN_SHA, feature: FEATURE_SHA },
      commits: [ROOT_COMMIT, FEATURE_COMMIT, MAIN_COMMIT],
    })

    const source = await resolveFrom({ repository }, AUTO_REQUEST)

    expect(source.patch).toBe(FEATURE_PATCH)
  })

  test('uses the default branch the remote names', async () => {
    const repository = featureAheadOfMain({
      originHead: 'origin/trunk',
      branches: { 'origin/trunk': ROOT_SHA, feature: FEATURE_SHA },
    })

    const source = await resolveFrom({ repository }, AUTO_REQUEST)

    expect(source.target).toMatchObject({ base: 'origin/trunk' })
  })

  test('says there is nothing to review when clean and level with the default branch', async () => {
    const repository = createRepository({ currentBranch: 'feature', branches: { main: ROOT_SHA, feature: ROOT_SHA }, commits: [ROOT_COMMIT] })

    await expect(resolveFrom({ repository }, AUTO_REQUEST)).rejects.toThrow(
      'Nothing to review: no uncommitted changes, and feature is not ahead of main.',
    )
  })

  test('says there is nothing to compare with when clean and no default branch exists', async () => {
    const repository = createRepository({ currentBranch: 'trunk', branches: { trunk: ROOT_SHA }, commits: [ROOT_COMMIT] })

    await expect(resolveFrom({ repository }, AUTO_REQUEST)).rejects.toThrow('no default branch to compare trunk with')
  })

  test('refuses a directory outside any git repository', async () => {
    const repository = createRepository({ root: null })

    await expect(resolveFrom({ repository }, AUTO_REQUEST)).rejects.toThrow('Not inside a git repository: /work/shop/src')
  })

  test('names the repository after its GitHub origin, else after its folder', async () => {
    const repository = cleanOnMain({ statusEntries: [' M src/app.ts'], trackedPatch: APP_PATCH })

    const withoutOrigin = await resolveFrom({ repository }, WORKTREE_REQUEST)
    const sshOrigin = await resolveFrom({ repository: { ...repository, remoteUrl: 'git@github.com:acme/shop.git' } }, WORKTREE_REQUEST)
    const httpsOrigin = await resolveFrom({ repository: { ...repository, remoteUrl: 'https://github.com/acme/shop' } }, WORKTREE_REQUEST)
    const otherHost = await resolveFrom({ repository: { ...repository, remoteUrl: 'https://example.test/acme/shop.git' } }, WORKTREE_REQUEST)

    expect(withoutOrigin.repository.name).toBe('shop')
    expect(sshOrigin.repository.name).toBe('acme/shop')
    expect(httpsOrigin.repository.name).toBe('acme/shop')
    expect(otherHost.repository.name).toBe('shop')
  })
})

describe('resolveReviewSource, worktree', () => {
  test('puts each untracked file’s section after the tracked diff', async () => {
    const repository = cleanOnMain({ trackedPatch: APP_PATCH, untrackedPatches: { 'notes/todo.md': NOTES_PATCH } })

    const { patch } = await resolveFrom({ repository }, WORKTREE_REQUEST)

    expect(patch).toBe(APP_PATCH + NOTES_PATCH)
  })

  test('compares a repository with no commits against the empty tree', async () => {
    const repository = createRepository({ branches: {}, trackedPatch: APP_PATCH })

    const source = await resolveFrom({ repository }, WORKTREE_REQUEST)

    expect(source.target).toMatchObject({ kind: ReviewTargetKind.Worktree, base: '4b825dc642cb6eb9a060e54bf8d69288fbee4904' })
    expect(source.patch).toBe(APP_PATCH)
  })

  test('reports a detached HEAD in the label', async () => {
    const repository = cleanOnMain({ currentBranch: null, detachedSha: ROOT_SHA, trackedPatch: APP_PATCH })

    const source = await resolveFrom({ repository }, WORKTREE_REQUEST)

    expect(source.title).toBe('Uncommitted changes on detached HEAD')
  })

  test('says there are no changes in a clean worktree', async () => {
    await expect(resolveFrom({ repository: cleanOnMain() }, WORKTREE_REQUEST)).rejects.toThrow(
      'No changes in Uncommitted changes on main.',
    )
  })

  test('leaves out untracked files beyond the first 200 by path, and says so', async () => {
    const untrackedPatches: Record<string, string> = {}
    for (let index = 0; index < 203; index++) untrackedPatches[`bulk/file-${String(index).padStart(3, '0')}.txt`] = `section ${index}\n`

    const source = await resolveFrom({ repository: cleanOnMain({ untrackedPatches }) }, WORKTREE_REQUEST)

    expect(source.patch).toContain('section 199\n')
    expect(source.patch).not.toContain('section 200\n')
    expect(source.description).toBe('3 more untracked files left out; only the first 200 by path are included.')
  })
})

describe('resolveReviewSource, revisions', () => {
  test('a branch name is compared with the default branch from their merge base', async () => {
    const repository = featureAheadOfMain({
      currentBranch: 'main',
      branches: { main: MAIN_SHA, feature: FEATURE_SHA },
      commits: [ROOT_COMMIT, FEATURE_COMMIT, MAIN_COMMIT],
    })

    const source = await resolveFrom({ repository }, { kind: TargetRequestKind.Revision, revision: 'feature' })

    expect(source.target).toMatchObject({ kind: ReviewTargetKind.Range, label: 'feature vs main', base: 'main', head: 'feature', isMergeBase: true })
    expect(source.title).toBe('Add the feature')
    expect(source.patch).toBe(FEATURE_PATCH)
  })

  test('a commit is compared with its parent', async () => {
    const source = await resolveFrom({ repository: featureAheadOfMain() }, { kind: TargetRequestKind.Revision, revision: 'HEAD~1' })

    expect(source.target).toMatchObject({ kind: ReviewTargetKind.Commit, revision: 'HEAD~1', sha: FEATURE_SHA })
    expect(source.title).toBe('Add the feature')
    expect(source.commits).toEqual([{ sha: FEATURE_SHA, subject: 'Add the feature', author: 'Ada Lovelace' }])
    expect(source.patch).toBe(FEATURE_PATCH)
  })

  test('the root commit is compared with the empty tree', async () => {
    const source = await resolveFrom({ repository: cleanOnMain() }, { kind: TargetRequestKind.Revision, revision: ROOT_SHA })

    expect(source.title).toBe('Start the app')
    expect(source.patch).toBe(APP_PATCH)
  })

  test('an unknown revision is named', async () => {
    await expect(resolveFrom({ repository: cleanOnMain() }, { kind: TargetRequestKind.Revision, revision: 'nope' })).rejects.toThrow(
      'Unknown revision "nope"',
    )
  })
})

describe('resolveReviewSource, ranges', () => {
  const repository = featureAheadOfMain({
    currentBranch: 'main',
    branches: { main: MAIN_SHA, feature: TEST_SHA },
    commits: [ROOT_COMMIT, FEATURE_COMMIT, TEST_COMMIT, MAIN_COMMIT],
  })

  test('A...B shows what B added since it left A', async () => {
    const source = await resolveFrom({ repository }, { kind: TargetRequestKind.Range, base: 'main', head: 'feature', isMergeBase: true })

    expect(source.target).toMatchObject({ kind: ReviewTargetKind.Range, base: 'main', head: 'feature', isMergeBase: true })
    expect(source.commits.map(commit => commit.sha)).toEqual([FEATURE_SHA, TEST_SHA])
    expect(source.patch).toBe(FEATURE_PATCH + TEST_PATCH)
  })

  test('an unknown side is named', async () => {
    await expect(
      resolveFrom({ repository }, { kind: TargetRequestKind.Range, base: 'main', head: 'ghost', isMergeBase: true }),
    ).rejects.toThrow('Unknown revision "ghost"')
  })

  test('a range with no changes says so', async () => {
    await expect(
      resolveFrom({ repository }, { kind: TargetRequestKind.Range, base: 'main', head: 'main', isMergeBase: true }),
    ).rejects.toThrow('No changes in main vs main.')
  })

  test('histories that share nothing are refused', async () => {
    const unrelated: FakeCommit = { sha: 'f'.repeat(40), subject: 'Elsewhere', author: 'Ada Lovelace', patch: MAIN_PATCH }
    const disjoint = createRepository({ branches: { main: ROOT_SHA, orphan: unrelated.sha }, commits: [ROOT_COMMIT, unrelated] })

    await expect(
      resolveFrom({ repository: disjoint }, { kind: TargetRequestKind.Range, base: 'main', head: 'orphan', isMergeBase: true }),
    ).rejects.toThrow('main and orphan share no history.')
  })

  test('a diff cut at the output cap is refused', async () => {
    const truncated = cleanOnMain({ trackedPatch: APP_PATCH, isOutputTruncated: true })

    await expect(resolveFrom({ repository: truncated }, WORKTREE_REQUEST)).rejects.toThrow(
      'The diff is larger than 4 MiB; review a narrower target.',
    )
  })
})

describe('resolveReviewSource, slugs', () => {
  test('are file-name safe, at most 80 characters, and stable', async () => {
    const branch = `feature/${'very-long-name/'.repeat(8)}end`
    const repository = featureAheadOfMain({ currentBranch: 'main', branches: { main: ROOT_SHA, [branch]: FEATURE_SHA } })
    const request = { kind: TargetRequestKind.Revision, revision: branch } as const

    const first = await resolveFrom({ repository }, request)
    const second = await resolveFrom({ repository }, request)

    expect(first.slug).toMatch(/^[A-Za-z0-9._-]+$/)
    expect(first.slug.length).toBeLessThanOrEqual(80)
    expect(second.slug).toBe(first.slug)
  })

  test('differ between the targets of one repository', async () => {
    const repository = featureAheadOfMain({ statusEntries: [' M src/app.ts'], trackedPatch: APP_PATCH })
    const requests = [
      WORKTREE_REQUEST,
      { kind: TargetRequestKind.Range, base: 'main', head: 'feature', isMergeBase: true },
      { kind: TargetRequestKind.Range, base: 'main', head: 'feature', isMergeBase: false },
      { kind: TargetRequestKind.Revision, revision: 'HEAD' },
      { kind: TargetRequestKind.Revision, revision: 'HEAD~1' },
    ] as const

    const sources = await Promise.all(requests.map(request => resolveFrom({ repository }, request)))

    expect(new Set(sources.map(source => source.slug)).size).toBe(requests.length)
    expect(new Set(sources.map(source => source.target.key)).size).toBe(requests.length)
  })
})

describe('resolveReviewSource, pull requests', () => {
  const pullRequest: FakePullRequest = {
    title: 'Absorb the registry changes',
    body: 'Closes #51',
    author: 'example',
    baseRefName: 'main',
    headRefName: 'prototype/absorb',
    state: 'MERGED',
    commits: [
      { oid: 'aaaa', messageHeadline: 'Take the page title size', authors: [{ login: 'example', name: 'Ada Lovelace' }] },
      { oid: 'bbbb', messageHeadline: 'Open results on arrival', authors: [{ login: 'example', name: '' }] },
    ],
    diff: FEATURE_PATCH,
  }
  const environment: FakeEnvironment = {
    repository: cleanOnMain(),
    gitHub: { repositoryName: 'example/notes', pullRequests: { 53: pullRequest } },
  }

  test('a pull request of this repo is collected with its metadata, commits and diff', async () => {
    const source = await resolveFrom(environment, {
      kind: TargetRequestKind.PullRequest,
      number: 53,
      url: { owner: 'Example', name: 'notes' },
    })

    expect(source.target).toMatchObject({
      kind: ReviewTargetKind.PullRequest,
      label: '#53 prototype/absorb → main',
      number: 53,
      url: 'https://github.com/example/notes/pull/53',
      baseRef: 'main',
      headRef: 'prototype/absorb',
      author: 'example',
      state: 'MERGED',
    })
    expect(source.title).toBe('Absorb the registry changes')
    expect(source.description).toBe('Closes #51')
    expect(source.commits).toEqual([
      { sha: 'aaaa', subject: 'Take the page title size', author: 'Ada Lovelace' },
      { sha: 'bbbb', subject: 'Open results on arrival', author: 'example' },
    ])
    expect(source.patch).toBe(FEATURE_PATCH)
  })

  test('a pull request URL of another repo is refused, naming both', async () => {
    const request = { kind: TargetRequestKind.PullRequest, number: 7, url: { owner: 'antfu', name: 'pulls.review' } } as const

    await expect(resolveFrom(environment, request)).rejects.toThrow(
      'That pull request belongs to antfu/pulls.review; this session is in example/notes.',
    )
  })

  test('a pull request that does not exist fails with gh’s message', async () => {
    await expect(resolveFrom(environment, { kind: TargetRequestKind.PullRequest, number: 99 })).rejects.toThrow(
      'no pull request found for #99',
    )
  })

  test('a gh failure carries gh’s first error line', async () => {
    const signedOut: FakeEnvironment = {
      ...environment,
      gitHub: { ...environment.gitHub!, failure: '\nTo get started with GitHub CLI, please run:  gh auth login\n' },
    }

    await expect(resolveFrom(signedOut, { kind: TargetRequestKind.PullRequest, number: 53 })).rejects.toThrow(
      'To get started with GitHub CLI, please run:  gh auth login',
    )
  })

  test('a missing gh is reported', async () => {
    await expect(resolveFrom({ repository: cleanOnMain() }, { kind: TargetRequestKind.PullRequest, number: 53 })).rejects.toThrow(
      'gh failed',
    )
  })
})

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
