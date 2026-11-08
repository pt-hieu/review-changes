import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ingestAnalysis } from '../../analysis/ingest.ts'
import { collect } from '../collect.ts'

const roots: string[] = []

function git(directory: string, ...commandArguments: string[]): string {
  const result = Bun.spawnSync(
    ['git', '-c', 'user.name=Ada', '-c', 'user.email=ada@example.com', '-c', 'commit.gpgsign=false', ...commandArguments],
    { cwd: directory, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } },
  )

  if (result.exitCode !== 0) throw new Error(`git ${commandArguments.join(' ')}: ${result.stderr.toString()}`)

  return result.stdout.toString()
}

function createRepository(name = 'repo'): string {
  const root = mkdtempSync(join(tmpdir(), 'collect-test-'))
  const directory = join(root, name)
  roots.push(root)
  mkdirSync(directory)
  git(directory, 'init', '-q', '-b', 'main')

  return directory
}

function write(directory: string, path: string, text: string): void {
  mkdirSync(join(directory, path, '..'), { recursive: true })
  writeFileSync(join(directory, path), text)
}

function commitAll(directory: string, message: string): void {
  git(directory, 'add', '-A')
  git(directory, 'commit', '-q', '-m', message)
}

function looseObjectCount(directory: string): number {
  return Number(/count: (\d+)/.exec(git(directory, 'count-objects', '-v'))?.[1])
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('collecting the working tree', () => {
  test('diffs changed and untracked files of a repository whose path holds a colon, without touching the repository', async () => {
    const directory = createRepository('weird:4')
    write(directory, 'src/a.ts', 'one\ntwo\n')
    commitAll(directory, 'base')
    write(directory, 'src/a.ts', 'one\ntwo\nthree\n')
    write(directory, 'src/new.ts', 'brand new\n')
    write(directory, 'empty.txt', '')
    const indexBefore = readFileSync(join(directory, '.git/index'))
    const objectsBefore = looseObjectCount(directory)
    const statusBefore = git(directory, 'status', '--porcelain')

    const result = await collect({ target: '--worktree', messages: [] }, directory)

    expect(result).toMatchObject({ isCollected: true, fileCount: 3, additions: 2, deletions: 0, modelLabel: 'uncommitted changes', isAnalysisCurrent: false })
    expect(readFileSync(join(directory, '.git/index')).equals(indexBefore)).toBe(true)
    expect(looseObjectCount(directory)).toBe(objectsBefore)
    expect(git(directory, 'status', '--porcelain')).toBe(statusBefore)
    expect(readdirSync(join(directory, '.git/review-changes/tmp'))).toStrictEqual([])

    if (!result.isCollected) return

    const patch = readFileSync(join(result.reviewDirectory, 'patch.diff'), 'utf8')
    expect(patch).toContain('diff --git a/src/new.ts b/src/new.ts')
    expect(patch).toMatch(/index 0{40}\.\.[0-9a-f]{40}\n/)
    expect(result.analyzerPrompt).toContain('---MANIFEST--- (3 files, +2/-0)')
  })

  test('keeps a submodule change in the list when the repository asks for a log of it', async () => {
    const directory = createRepository()
    write(directory, 'a.txt', 'a\n')
    commitAll(directory, 'base')
    git(directory, 'update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},vendor/sub`)
    git(directory, 'commit', '-q', '-m', 'add submodule')
    git(directory, 'config', 'diff.submodule', 'log')
    git(directory, 'config', 'diff.noprefix', 'true')

    const result = await collect({ target: 'HEAD', messages: [] }, directory)

    expect(result).toMatchObject({ isCollected: true, fileCount: 1 })
  })

  test('says there is nothing to review in a clean repository', async () => {
    const directory = createRepository()
    write(directory, 'a.txt', 'a\n')
    commitAll(directory, 'base')

    const result = await collect({ target: '--worktree', messages: [] }, directory)

    expect(result).toStrictEqual({ isCollected: false, message: 'No changes in Uncommitted changes on main.', modelMessage: 'No changes in uncommitted changes.' })
  })

  test('says so outside a repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'collect-test-'))
    roots.push(root)

    const result = await collect({ target: '', messages: [] }, root)

    expect(result).toMatchObject({ isCollected: false, message: expect.stringContaining('Not inside a git repository') })
  })

  test('refuses an option-like target before running anything', async () => {
    const directory = createRepository()

    const result = await collect({ target: '--output=/tmp/x', messages: [] }, directory)

    expect(result).toMatchObject({ isCollected: false, message: expect.stringContaining('Unknown option') })
  })
})

describe('collecting a commit or a range', () => {
  test('diffs one commit against its parent and labels it without third-party text', async () => {
    const directory = createRepository()
    write(directory, 'a.txt', 'a\n')
    commitAll(directory, 'base')
    write(directory, 'a.txt', 'a\nb\n')
    write(directory, 'renamed-from.txt', 'x\ny\nz\n'.repeat(20))
    commitAll(directory, 'second')

    const result = await collect({ target: 'HEAD', messages: [] }, directory)

    expect(result).toMatchObject({ isCollected: true, fileCount: 2, modelLabel: expect.stringMatching(/^commit [0-9a-f]{7}$/) })
  })

  test('diffs a range', async () => {
    const directory = createRepository()
    write(directory, 'a.txt', 'a\n')
    commitAll(directory, 'base')
    write(directory, 'a.txt', 'a\nb\n')
    commitAll(directory, 'second')

    const result = await collect({ target: 'HEAD~1..HEAD', messages: [] }, directory)

    expect(result).toMatchObject({ isCollected: true, fileCount: 1, additions: 1, modelLabel: 'the requested range' })
  })
})

describe('collecting again', () => {
  test('skips the analyzer only once the same patch has a ready analysis', async () => {
    const directory = createRepository()
    write(directory, 'a.txt', 'a\n')
    commitAll(directory, 'base')
    write(directory, 'a.txt', 'a\nb\n')

    const first = await collect({ target: '--worktree', messages: [] }, directory)
    const second = await collect({ target: '--worktree', messages: [] }, directory)

    expect(first).toMatchObject({ isCollected: true, isAnalysisCurrent: false })
    expect(second).toMatchObject({ isCollected: true, isAnalysisCurrent: false })

    if (!second.isCollected) return

    const answer = JSON.stringify({ overallSummary: 's', groups: [{ key: 'all', label: 'All', summary: 's', seeds: ['seed-1'] }] })
    ingestAnalysis({ reviewDirectory: second.reviewDirectory, reviewId: second.reviewId, answer, analysisStartedAt: new Date().toISOString() })

    const third = await collect({ target: '--worktree', messages: [] }, directory)

    expect(third).toMatchObject({ isCollected: true, isAnalysisCurrent: true, reviewId: second.reviewId, analyzerPrompt: '' })

    write(directory, 'a.txt', 'a\nb\nc\n')
    const fourth = await collect({ target: '--worktree', messages: [] }, directory)

    expect(fourth).toMatchObject({ isCollected: true, isAnalysisCurrent: false })
    expect(fourth.isCollected && fourth.reviewId).not.toBe(second.reviewId)
  })

  test('drops an analyzer answer that belongs to a replaced review', async () => {
    const directory = createRepository()
    write(directory, 'a.txt', 'a\n')
    commitAll(directory, 'base')
    write(directory, 'a.txt', 'a\nb\n')
    const first = await collect({ target: '--worktree', messages: [] }, directory)
    write(directory, 'a.txt', 'a\nb\nc\n')
    await collect({ target: '--worktree', messages: [] }, directory)

    if (!first.isCollected) throw new Error('expected a collected review')

    const outcome = ingestAnalysis({ reviewDirectory: first.reviewDirectory, reviewId: first.reviewId, answer: '{"groups":[]}', analysisStartedAt: new Date().toISOString() })

    expect(outcome.isIngested).toBe(false)
    expect(existsSync(join(first.reviewDirectory, 'analysis.json'))).toBe(true)
  })
})
