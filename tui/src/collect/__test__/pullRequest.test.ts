import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Runner } from '../../review/git.ts'
import { createCommandRunner } from '../commandRunner.ts'
import { diffToFile } from '../diffCommand.ts'
import { fetchIntoQuarantine } from '../pullRequest.ts'

const roots: string[] = []

function git(directory: string, ...commandArguments: string[]): string {
  const result = Bun.spawnSync(
    ['git', '-c', 'user.name=Ada', '-c', 'user.email=ada@example.com', '-c', 'commit.gpgsign=false', '-c', 'protocol.file.allow=always', ...commandArguments],
    { cwd: directory, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } },
  )

  if (result.exitCode !== 0) throw new Error(`git ${commandArguments.join(' ')}: ${result.stderr.toString()}`)

  return result.stdout.toString()
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('fetching a pull request into a quarantine', () => {
  test('diffs the pull request without leaving a ref, a FETCH_HEAD or an object in the clone', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pull-request-test-'))
    roots.push(root)
    const upstream = join(root, 'upstream')
    mkdirSync(upstream)
    git(upstream, 'init', '-q', '-b', 'main')
    writeFileSync(join(upstream, 'a.txt'), 'one\n')
    git(upstream, 'add', '-A')
    git(upstream, 'commit', '-q', '-m', 'base')
    const baseObjectId = git(upstream, 'rev-parse', 'HEAD').trim()
    git(upstream, 'checkout', '-q', '-b', 'feature')
    writeFileSync(join(upstream, 'a.txt'), 'one\ntwo\n')
    git(upstream, 'commit', '-q', '-am', 'feature')
    const headObjectId = git(upstream, 'rev-parse', 'HEAD').trim()
    git(upstream, 'update-ref', 'refs/pull/7/head', headObjectId)
    git(upstream, 'checkout', '-q', 'main')
    git(upstream, 'branch', '-q', '-D', 'feature')

    const clone = join(root, 'clone')
    git(root, 'clone', '-q', '--no-local', upstream, clone)
    git(clone, 'config', '--add', 'remote.origin.fetch', '+refs/pull/*/head:refs/remotes/origin/pr/*')
    const refsBefore = git(clone, 'for-each-ref')
    const runner = new Runner(createCommandRunner(), clone)
    const scratch = join(root, 'scratch')

    const environment = await fetchIntoQuarantine({
      git: runner,
      repositoryRoot: clone,
      remote: 'origin',
      baseObjectId,
      pullRequestNumber: 7,
      quarantineDirectory: join(scratch, 'quarantine'),
    })
    const patchPath = join(root, 'patch.diff')
    await diffToFile({ directory: clone, revisions: [`${baseObjectId}...${headObjectId}`], outputPath: patchPath, environment })
    rmSync(scratch, { recursive: true, force: true })

    expect(await Bun.file(patchPath).text()).toContain('+two')
    expect(git(clone, 'for-each-ref')).toBe(refsBefore)
    expect(existsSync(join(clone, '.git/FETCH_HEAD'))).toBe(false)
    expect(Bun.spawnSync(['git', 'cat-file', '-e', headObjectId], { cwd: clone }).exitCode).not.toBe(0)
    expect(git(clone, 'fsck', '--no-dangling')).not.toContain('missing')
  })
})
