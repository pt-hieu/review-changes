import { plural } from './counts.ts'
import type { ReviewCommit, ReviewRepository, ReviewTarget } from './payload.ts'

export type RunCommand = (
  commandArguments: readonly string[],
  options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean }>

export type ReviewSource = {
  repository: ReviewRepository
  gitCommonDirectory: string
  target: ReviewTarget
  slug: string
  title: string
  description?: string
  commits: ReviewCommit[]
  patch: string
}

export class ReviewSourceError extends Error {
  override name = 'ReviewSourceError'
}

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

const DIFF_FLAGS = [
  '-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '-M', '--src-prefix=a/', '--dst-prefix=b/',
] as const
const DEFAULT_BRANCH_FALLBACKS = ['main', 'master', 'origin/main', 'origin/master']
const TRUNCATED_DIFF_MESSAGE = 'The diff is larger than 4 MiB; review a narrower target.'
const COMMAND_ENVIRONMENT = { LC_ALL: 'C' }
const EVERY_UNTRACKED_FILE_LISTED_INDIVIDUALLY = '--untracked-files=all'
const STATUS_COMMAND = ['git', 'status', '--porcelain=v1', '-z', EVERY_UNTRACKED_FILE_LISTED_INDIVIDUALLY]

type CommandResult = Awaited<ReturnType<RunCommand>>

export class Runner {
  readonly runCommand: RunCommand
  readonly directory: string

  constructor(runCommand: RunCommand, directory: string) {
    this.runCommand = runCommand
    this.directory = directory
  }

  async run(commandArguments: readonly string[], timeoutMilliseconds?: number): Promise<CommandResult> {
    try {
      return await this.runCommand(commandArguments, {
        cwd: this.directory,
        env: COMMAND_ENVIRONMENT,
        ...(timeoutMilliseconds === undefined ? {} : { timeoutMs: timeoutMilliseconds }),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new ReviewSourceError(`Could not run ${commandArguments[0]}: ${reason}`)
    }
  }

  async succeeds(commandArguments: readonly string[]): Promise<boolean> {
    return (await this.run(commandArguments)).exitCode === 0
  }

  private async succeeded(
    commandArguments: readonly string[],
    { timeoutMilliseconds, successCodes = [0] }: { timeoutMilliseconds?: number; successCodes?: readonly number[] },
  ): Promise<CommandResult> {
    const result = await this.run(commandArguments, timeoutMilliseconds)

    if (!successCodes.includes(result.exitCode)) {
      throw new ReviewSourceError(`${commandArguments[0]} failed: ${firstLine(result.stderr) ?? `exit code ${result.exitCode}`}`)
    }

    return result
  }

  async output(commandArguments: readonly string[], timeoutMilliseconds?: number): Promise<string> {
    return (await this.succeeded(commandArguments, { timeoutMilliseconds })).stdout
  }

  async diff(
    commandArguments: readonly string[],
    options: { timeoutMilliseconds?: number; successCodes?: readonly number[] } = {},
  ): Promise<string> {
    const result = await this.succeeded(commandArguments, options)

    if (result.isStdoutTruncated) throw new ReviewSourceError(TRUNCATED_DIFF_MESSAGE)

    return result.stdout
  }
}

export type RepositoryContext = {
  git: Runner
  repository: ReviewRepository
  gitCommonDirectory: string
}

export async function findReviewCandidate(runCommand: RunCommand, sessionWorkingDirectory: string): Promise<{ summary: string } | null> {
  try {
    const root = await findRepositoryRoot(runCommand, sessionWorkingDirectory)
    const git = new Runner(runCommand, root)

    const status = await git.output(STATUS_COMMAND)
    const changedFileCount = countStatusEntries(status)

    if (changedFileCount > 0) return { summary: `${changedFileCount} uncommitted ${plural(changedFileCount, 'file')}` }

    const defaultBranch = await findDefaultBranch(git)

    if (defaultBranch === null) return null

    const aheadCount = await countCommitsAhead(git, defaultBranch)

    if (aheadCount > 0) return { summary: `${aheadCount} ${plural(aheadCount, 'commit')} ahead of ${defaultBranch}` }

    return null
  } catch {
    return null
  }
}

async function findRepositoryRoot(runCommand: RunCommand, sessionWorkingDirectory: string): Promise<string> {
  const result = await new Runner(runCommand, sessionWorkingDirectory).run(['git', 'rev-parse', '--show-toplevel'])
  const root = result.stdout.trim()

  if (result.exitCode !== 0 || root === '') throw new ReviewSourceError(`Not inside a git repository: ${sessionWorkingDirectory}`)

  return root
}

export async function openRepository(runCommand: RunCommand, sessionWorkingDirectory: string): Promise<RepositoryContext> {
  const root = await findRepositoryRoot(runCommand, sessionWorkingDirectory)
  const git = new Runner(runCommand, root)

  const gitCommonDirectory = (await git.output(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()

  const origin = await git.run(['git', 'remote', 'get-url', 'origin'])
  const gitHubName = origin.exitCode === 0 ? parseGitHubName(origin.stdout.trim()) : null
  const name = gitHubName ?? root.split('/').filter(segment => segment !== '').at(-1) ?? root

  return { git, repository: { root, name }, gitCommonDirectory }
}

export async function currentBranch(git: Runner): Promise<string | null> {
  const result = await git.run(['git', 'symbolic-ref', '--quiet', '--short', 'HEAD'])

  return result.exitCode === 0 ? result.stdout.trim() : null
}

export async function findDefaultBranch(git: Runner): Promise<string | null> {
  const originHead = await git.run(['git', 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])

  if (originHead.exitCode === 0 && originHead.stdout.trim() !== '') return originHead.stdout.trim()

  for (const candidate of DEFAULT_BRANCH_FALLBACKS) {
    if (await git.succeeds(['git', 'rev-parse', '--verify', '--quiet', `${candidate}^{commit}`])) return candidate
  }

  return null
}

export async function countCommitsAhead(git: Runner, defaultBranch: string): Promise<number> {
  const result = await git.run(['git', 'rev-list', '--count', `${defaultBranch}..HEAD`])

  return result.exitCode === 0 ? Number(result.stdout.trim()) || 0 : 0
}

function countStatusEntries(status: string): number {
  const fields = status.split('\0')
  let count = 0

  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!

    if (field === '') continue

    count++

    const hasOldPathAsExtraField = /[RC]/.test(field.slice(0, 2))
    if (hasOldPathAsExtraField) index++
  }

  return count
}

export function parseCommitLog(text: string): ReviewCommit[] {
  return text
    .split('\x1e')
    .map(record => record.replace(/^\n+|\n+$/g, ''))
    .filter(record => record !== '')
    .map(record => {
      const [sha = '', subject = '', author = ''] = record.split('\x1f')
      return { sha, subject, author }
    })
}

export function parseGitHubName(remoteUrl: string): string | null {
  const match = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/
    .exec(remoteUrl)

  return match ? `${match[1]}/${match[2]}` : null
}

export function slugFromKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80)
}

export function firstLine(text: string): string | undefined {
  return text.split('\n').map(line => line.trim()).find(line => line !== '')
}

