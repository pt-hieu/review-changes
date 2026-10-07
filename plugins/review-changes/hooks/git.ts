import { plural } from './counts.ts'
import type { ReviewCommit, ReviewRepository, ReviewTarget } from './payload.ts'
import type { TargetRequest } from './target.ts'
import { ReviewTargetKind, TargetRequestKind } from './types.ts'

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

export const DIFF_FLAGS = [
  '-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '-M', '--src-prefix=a/', '--dst-prefix=b/',
] as const

const MAXIMUM_UNTRACKED_FILES = 200
const PULL_REQUEST_TIMEOUT_MILLISECONDS = 120_000
const DEFAULT_BRANCH_FALLBACKS = ['main', 'master', 'origin/main', 'origin/master']
const TRUNCATED_DIFF_MESSAGE = 'The diff is larger than 4 MiB; review a narrower target.'
const COMMAND_ENVIRONMENT = { LC_ALL: 'C' }
const NO_INDEX_DIFFERENCE_EXIT_CODES = [0, 1]
const EVERY_UNTRACKED_FILE_LISTED_INDIVIDUALLY = '--untracked-files=all'
const STATUS_COMMAND = ['git', 'status', '--porcelain=v1', '-z', EVERY_UNTRACKED_FILE_LISTED_INDIVIDUALLY]

type CommandResult = Awaited<ReturnType<RunCommand>>

class Runner {
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

type RepositoryContext = {
  git: Runner
  repository: ReviewRepository
  gitCommonDirectory: string
}

type CollectedTarget = Omit<ReviewSource, 'repository' | 'gitCommonDirectory' | 'slug'>

export async function resolveReviewSource(
  runCommand: RunCommand,
  sessionWorkingDirectory: string,
  request: TargetRequest,
): Promise<ReviewSource> {
  const context = await openRepository(runCommand, sessionWorkingDirectory)
  const collected = await collectTarget(context, request)

  if (collected.patch === '') throw new ReviewSourceError(`No changes in ${collected.target.label}.`)

  return {
    repository: context.repository,
    gitCommonDirectory: context.gitCommonDirectory,
    ...collected,
    slug: slugFromKey(collected.target.key),
  }
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

async function openRepository(runCommand: RunCommand, sessionWorkingDirectory: string): Promise<RepositoryContext> {
  const root = await findRepositoryRoot(runCommand, sessionWorkingDirectory)
  const git = new Runner(runCommand, root)

  const gitCommonDirectory = (await git.output(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()

  const origin = await git.run(['git', 'remote', 'get-url', 'origin'])
  const gitHubName = origin.exitCode === 0 ? parseGitHubName(origin.stdout.trim()) : null
  const name = gitHubName ?? root.split('/').filter(segment => segment !== '').at(-1) ?? root

  return { git, repository: { root, name }, gitCommonDirectory }
}

async function collectTarget(context: RepositoryContext, request: TargetRequest): Promise<CollectedTarget> {
  switch (request.kind) {
    case TargetRequestKind.Auto:
      return collectAutomaticTarget(context)
    case TargetRequestKind.Worktree:
      return collectWorktree(context)
    case TargetRequestKind.Range:
      return collectRange(context, request.base, request.head, request.isMergeBase)
    case TargetRequestKind.Revision:
      return collectRevision(context, request.revision)
    case TargetRequestKind.PullRequest:
      return collectPullRequest(context, request.number, request.url)
  }
}

async function collectAutomaticTarget(context: RepositoryContext): Promise<CollectedTarget> {
  const { git } = context
  const status = await git.output(STATUS_COMMAND)

  if (status !== '') return collectWorktree(context)

  const branch = await currentBranch(git)
  const branchName = branch ?? 'HEAD'
  const defaultBranch = await findDefaultBranch(git)

  if (defaultBranch === null) {
    throw new ReviewSourceError(`Nothing to review: no uncommitted changes, and no default branch to compare ${branchName} with.`)
  }

  if (await countCommitsAhead(git, defaultBranch) === 0) {
    throw new ReviewSourceError(`Nothing to review: no uncommitted changes, and ${branchName} is not ahead of ${defaultBranch}.`)
  }

  return collectRange(context, defaultBranch, 'HEAD', true)
}

async function collectWorktree({ git }: RepositoryContext): Promise<CollectedTarget> {
  const hasHead = await git.succeeds(['git', 'rev-parse', '--verify', '--quiet', 'HEAD'])
  const base = hasHead ? 'HEAD' : EMPTY_TREE
  const branch = await currentBranch(git)
  const trackedPatch = await git.diff(['git', ...DIFF_FLAGS, base])

  const untrackedPaths = (await git.output(['git', 'ls-files', '--others', '--exclude-standard', '-z']))
    .split('\0')
    .filter(path => path !== '')
    .sort()
  const includedPaths = untrackedPaths.slice(0, MAXIMUM_UNTRACKED_FILES)
  const untrackedPatches: string[] = []
  for (const path of includedPaths) {
    untrackedPatches.push(
      await git.diff(['git', ...DIFF_FLAGS, '--no-index', '--', '/dev/null', path], {
        successCodes: NO_INDEX_DIFFERENCE_EXIT_CODES,
      }),
    )
  }

  const leftOutCount = untrackedPaths.length - includedPaths.length
  const label = `Uncommitted changes on ${branch ?? 'detached HEAD'}`
  return {
    target: { kind: ReviewTargetKind.Worktree, key: 'worktree', label, branch, base },
    title: label,
    ...(leftOutCount > 0
      ? { description: `${leftOutCount} more untracked ${plural(leftOutCount, 'file')} left out; only the first ${MAXIMUM_UNTRACKED_FILES} by path are included.` }
      : {}),
    commits: [],
    patch: trackedPatch + untrackedPatches.join(''),
  }
}

async function collectRange(
  { git }: RepositoryContext,
  base: string,
  head: string,
  isMergeBase: boolean,
): Promise<CollectedTarget> {
  for (const side of [base, head]) {
    if (!await git.succeeds(['git', 'rev-parse', '--verify', '--quiet', `${side}^{commit}`])) {
      throw new ReviewSourceError(`Unknown revision "${side}"`)
    }
  }

  const separator = isMergeBase ? '...' : '..'
  const range = `${base}${separator}${head}`
  let from = base
  if (isMergeBase) {
    const mergeBase = await git.run(['git', 'merge-base', base, head])

    if (mergeBase.exitCode !== 0) throw new ReviewSourceError(`${base} and ${head} share no history.`)
    from = mergeBase.stdout.trim()
  }

  const patch = await git.diff(['git', ...DIFF_FLAGS, range])
  const commits = parseCommitLog(await git.output(['git', 'log', '--reverse', '--format=%H%x1f%s%x1f%an%x1e', `${from}..${head}`]))

  const label = `${head} vs ${base}`
  return {
    target: { kind: ReviewTargetKind.Range, key: `range-${range}`, label, base, head, isMergeBase },
    title: commits.length === 1 ? commits[0]!.subject : label,
    commits,
    patch,
  }
}

async function collectRevision(context: RepositoryContext, revision: string): Promise<CollectedTarget> {
  const { git } = context

  const isBranch = await git.succeeds(['git', 'show-ref', '--verify', '--quiet', `refs/heads/${revision}`])
    || await git.succeeds(['git', 'show-ref', '--verify', '--quiet', `refs/remotes/${revision}`])

  if (isBranch) {
    const defaultBranch = await findDefaultBranch(git)

    if (defaultBranch === null) {
      throw new ReviewSourceError(`No default branch to compare ${revision} with; name a range such as main...${revision}.`)
    }

    return collectRange(context, defaultBranch, revision, true)
  }

  if (!await git.succeeds(['git', 'rev-parse', '--verify', '--quiet', `${revision}^{commit}`])) {
    throw new ReviewSourceError(`Unknown revision "${revision}"`)
  }

  const sha = (await git.output(['git', 'rev-parse', `${revision}^{commit}`])).trim()

  const parentResult = await git.run(['git', 'rev-parse', '--verify', '--quiet', `${sha}^1`])
  const parent = parentResult.exitCode === 0 ? parentResult.stdout.trim() : EMPTY_TREE

  const patch = await git.diff(['git', ...DIFF_FLAGS, parent, sha])
  const commits = parseCommitLog(await git.output(['git', 'log', '-1', '--format=%H%x1f%s%x1f%an', sha]))

  return {
    target: { kind: ReviewTargetKind.Commit, key: `commit-${sha.slice(0, 12)}`, label: `${revision} (${sha.slice(0, 7)})`, revision, sha },
    title: commits[0]?.subject ?? revision,
    commits,
    patch,
  }
}

type PullRequestView = {
  number: number
  title: string
  body: string
  url: string
  author: { login: string } | null
  baseRefName: string
  headRefName: string
  state: string
  commits: { oid: string; messageHeadline: string; authors: { login?: string; name?: string }[] }[]
}

async function collectPullRequest(
  { git }: RepositoryContext,
  pullRequestNumber: number,
  url: { owner: string; name: string } | undefined,
): Promise<CollectedTarget> {
  const repositoryName = (await git.output(['gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])).trim()

  if (url !== undefined) {
    const requestedName = `${url.owner}/${url.name}`

    if (requestedName.toLowerCase() !== repositoryName.toLowerCase()) {
      throw new ReviewSourceError(`That pull request belongs to ${requestedName}; this session is in ${repositoryName}.`)
    }
  }

  const viewText = await git.output([
    'gh', 'pr', 'view', String(pullRequestNumber),
    '--json', 'number,title,body,url,author,baseRefName,headRefName,state,commits',
  ], PULL_REQUEST_TIMEOUT_MILLISECONDS)

  let view: PullRequestView
  try {
    view = JSON.parse(viewText) as PullRequestView
  } catch {
    throw new ReviewSourceError(`gh pr view ${pullRequestNumber} printed something other than JSON.`)
  }

  const patch = await git.diff(['gh', 'pr', 'diff', String(pullRequestNumber), '--color=never'], { timeoutMilliseconds: PULL_REQUEST_TIMEOUT_MILLISECONDS })

  const commits = (view.commits ?? []).map(commit => ({
    sha: commit.oid,
    subject: commit.messageHeadline,
    author: commit.authors[0]?.name || commit.authors[0]?.login || '',
  }))

  return {
    target: {
      kind: ReviewTargetKind.PullRequest,
      key: `pr-${view.number}`,
      label: `#${view.number} ${view.headRefName} → ${view.baseRefName}`,
      number: view.number,
      url: view.url,
      baseRef: view.baseRefName,
      headRef: view.headRefName,
      author: view.author?.login ?? null,
      state: view.state,
    },
    title: view.title,
    ...(view.body ? { description: view.body } : {}),
    commits,
    patch,
  }
}

async function currentBranch(git: Runner): Promise<string | null> {
  const result = await git.run(['git', 'symbolic-ref', '--quiet', '--short', 'HEAD'])

  return result.exitCode === 0 ? result.stdout.trim() : null
}

async function findDefaultBranch(git: Runner): Promise<string | null> {
  const originHead = await git.run(['git', 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])

  if (originHead.exitCode === 0 && originHead.stdout.trim() !== '') return originHead.stdout.trim()

  for (const candidate of DEFAULT_BRANCH_FALLBACKS) {
    if (await git.succeeds(['git', 'rev-parse', '--verify', '--quiet', `${candidate}^{commit}`])) return candidate
  }

  return null
}

async function countCommitsAhead(git: Runner, defaultBranch: string): Promise<number> {
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

function parseCommitLog(text: string): ReviewCommit[] {
  return text
    .split('\x1e')
    .map(record => record.replace(/^\n+|\n+$/g, ''))
    .filter(record => record !== '')
    .map(record => {
      const [sha = '', subject = '', author = ''] = record.split('\x1f')
      return { sha, subject, author }
    })
}

function parseGitHubName(remoteUrl: string): string | null {
  const match = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/
    .exec(remoteUrl)

  return match ? `${match[1]}/${match[2]}` : null
}

function slugFromKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80)
}

function firstLine(text: string): string | undefined {
  return text.split('\n').map(line => line.trim()).find(line => line !== '')
}

