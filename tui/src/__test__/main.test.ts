import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appArguments, forgetBunPath, resolveBun } from '../../../plugins/review-changes/hooks/bun.ts'
import { BUNDLE_PATH, PLUGIN_DIRECTORY } from './bundlePaths.ts'

const temporaryRoots: string[] = []
const MARKER_NAME = 'preload-ran.txt'
const TRACE_NAME = 'git-trace.txt'
const TEST_TIMEOUT_MILLISECONDS = 60_000

afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true })
})

function git(directory: string, ...commandArguments: string[]): void {
  const result = Bun.spawnSync(
    ['git', '-c', 'user.name=Ada', '-c', 'user.email=ada@example.com', '-c', 'commit.gpgsign=false', ...commandArguments],
    { cwd: directory, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } },
  )

  if (result.exitCode !== 0) throw new Error(`git ${commandArguments.join(' ')}: ${result.stderr.toString()}`)
}

function createMaliciousRepository(): { directory: string; markerPath: string; tracePath: string } {
  const root = mkdtempSync(join(tmpdir(), 'main-test-'))
  const directory = join(root, 'repository')
  const markerPath = join(root, MARKER_NAME)
  const tracePath = join(root, TRACE_NAME)
  temporaryRoots.push(root)
  mkdirSync(directory)

  git(directory, 'init', '-q', '-b', 'main')
  writeFileSync(join(directory, 'tracked.txt'), 'one\n')
  git(directory, 'add', '-A')
  git(directory, 'commit', '-q', '-m', 'base')

  writeFileSync(join(directory, 'tracked.txt'), 'one\ntwo\n')
  writeFileSync(
    join(directory, 'preload.ts'),
    `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(markerPath)}, 'ran')\n`,
  )
  writeFileSync(join(directory, 'bunfig.toml'), 'preload = ["./preload.ts"]\n')
  writeFileSync(join(directory, '.env'), `GIT_TRACE=${tracePath}\n`)

  return { directory, markerPath, tracePath }
}

async function runForReal(commandArguments: readonly string[], options?: { cwd?: string; stdin?: string }) {
  const child = Bun.spawn([...commandArguments], {
    cwd: options?.cwd,
    stdin: options?.stdin === undefined ? 'ignore' : new Blob([options.stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { exitCode, stdout, stderr }
}

describe('collecting a repository that tries to hijack bun', () => {
  test('the preload of the repository bunfig.toml does not run and its .env is not loaded', async () => {
    forgetBunPath()
    const { directory, markerPath, tracePath } = createMaliciousRepository()

    const bunPath = (await resolveBun(runForReal, process.env.HOME, PLUGIN_DIRECTORY))!
    const collected = await runForReal(appArguments(bunPath, BUNDLE_PATH, 'collect', '--cwd', directory), {
      cwd: PLUGIN_DIRECTORY,
      stdin: JSON.stringify({ target: '--worktree', messages: [] }),
    })
    const result = JSON.parse(collected.stdout) as { isCollected: boolean; reviewId: string; reviewDirectory: string; fileCount: number }
    const ingested = await runForReal(
      appArguments(bunPath, BUNDLE_PATH, 'ingest', result.reviewDirectory, '--review-id', result.reviewId, '--failed', 'no analyzer in this test'),
      { cwd: PLUGIN_DIRECTORY },
    )

    expect(result).toMatchObject({ isCollected: true, fileCount: 4 })
    expect(ingested.exitCode).toBe(0)
    expect(existsSync(markerPath)).toBe(false)
    expect(existsSync(tracePath)).toBe(false)
  }, TEST_TIMEOUT_MILLISECONDS)

  test('a shell launch from the plugin directory reviews the repository named by --cwd without running its preload', async () => {
    const { directory, markerPath } = createMaliciousRepository()

    await runForReal([process.execPath, '--no-env-file', BUNDLE_PATH, '--cwd', directory, '--worktree'], { cwd: PLUGIN_DIRECTORY })

    expect(readdirSync(join(directory, '.git/review-changes/sessions'))).toHaveLength(1)
    expect(existsSync(markerPath)).toBe(false)
  }, TEST_TIMEOUT_MILLISECONDS)

  test('the same repository does hijack a bun started inside it, so the test above can fail', async () => {
    const { directory, markerPath, tracePath } = createMaliciousRepository()

    await runForReal([process.execPath, BUNDLE_PATH, 'candidate', '--cwd', directory], { cwd: directory })

    expect(readFileSync(markerPath, 'utf8')).toBe('ran')
    expect(existsSync(tracePath)).toBe(true)
  }, TEST_TIMEOUT_MILLISECONDS)
})
