import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ReviewSourceError, parseGitHubName } from '../review/git.ts'
import type { Runner } from '../review/git.ts'
import type { ReviewCommit, ReviewTarget } from '../review/payload.ts'
import { ReviewTargetKind } from '../review/types.ts'
import { runCommandToFile, withEnvironment } from './commandRunner.ts'
import { MAXIMUM_PATCH_BYTES, diffToFile, objectsDirectory, quotedObjectDirectory } from './diffCommand.ts'

const NETWORK_TIMEOUT_MILLISECONDS = 120_000
const MAXIMUM_FILES_FOR_GITHUB_DIFF = 300
const GITHUB_TOO_LARGE_PATTERN = /406|too_large/

type PullRequestView = {
  number: number
  title: string
  body: string
  url: string
  author: { login: string } | null
  baseRefName: string
  headRefName: string
  state: string
  headRefOid: string
  baseRefOid: string
  changedFiles: number
  commits: { oid: string; messageHeadline: string; authors: { login?: string; name?: string }[] }[]
}

export type CollectedPullRequest = {
  target: ReviewTarget
  title: string
  description?: string
  commits: ReviewCommit[]
}

export type PullRequestDiffRequest = {
  git: Runner
  repositoryRoot: string
  pullRequestNumber: number
  url: { owner: string; name: string } | undefined
  scratchDirectory: string
  outputPath: string
}

export type FetchRequest = {
  git: Runner
  repositoryRoot: string
  remote: string
  baseObjectId: string
  pullRequestNumber: number
  quarantineDirectory: string
}

export function fetchArguments(remote: string, baseObjectId: string, pullRequestNumber: number): string[] {
  return [
    'git', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'fetch.writeCommitGraph=false',
    'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--refmap=', '--no-auto-maintenance', '--no-recurse-submodules',
    remote, baseObjectId, `refs/pull/${pullRequestNumber}/head`,
  ]
}

export async function fetchIntoQuarantine(request: FetchRequest): Promise<Record<string, string>> {
  const { git, repositoryRoot, remote, baseObjectId, pullRequestNumber, quarantineDirectory } = request
  mkdirSync(quarantineDirectory, { recursive: true })

  const environment = {
    GIT_OBJECT_DIRECTORY: quarantineDirectory,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: quotedObjectDirectory(await objectsDirectory(git.runCommand, repositoryRoot)),
  }
  const fetched = await withEnvironment(git.runCommand, environment)(fetchArguments(remote, baseObjectId, pullRequestNumber), {
    cwd: repositoryRoot,
    timeoutMs: NETWORK_TIMEOUT_MILLISECONDS * 5,
  })

  if (fetched.exitCode !== 0) {
    throw new ReviewSourceError(`Could not fetch pull request #${pullRequestNumber} from ${remote}: ${fetched.stderr.split('\n')[0] ?? ''}`)
  }

  return environment
}

async function findRemoteOf(git: Runner, repositoryName: string): Promise<string | null> {
  const names = (await git.output(['git', 'remote'])).split('\n').filter(name => name !== '')

  for (const name of names) {
    const result = await git.run(['git', 'remote', 'get-url', name])
    const gitHubName = result.exitCode === 0 ? parseGitHubName(result.stdout.trim()) : null

    if (gitHubName !== null && gitHubName.toLowerCase() === repositoryName.toLowerCase()) return name
  }

  return null
}

async function hasCommit(git: Runner, objectId: string): Promise<boolean> {
  return git.succeeds(['git', 'cat-file', '-e', `${objectId}^{commit}`])
}

function describe(view: PullRequestView): CollectedPullRequest {
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
    commits: (view.commits ?? []).map(commit => ({
      sha: commit.oid,
      subject: commit.messageHeadline,
      author: commit.authors[0]?.name || commit.authors[0]?.login || '',
    })),
  }
}

export async function collectPullRequestToFile(request: PullRequestDiffRequest): Promise<CollectedPullRequest> {
  const { git, repositoryRoot, pullRequestNumber, url, scratchDirectory, outputPath } = request
  const repositoryName = (await git.output(['gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])).trim()

  if (url !== undefined && `${url.owner}/${url.name}`.toLowerCase() !== repositoryName.toLowerCase()) {
    throw new ReviewSourceError(`That pull request belongs to ${url.owner}/${url.name}; this session is in ${repositoryName}.`)
  }

  const viewText = await git.output([
    'gh', 'pr', 'view', String(pullRequestNumber),
    '--json', 'number,title,body,url,author,baseRefName,headRefName,state,commits,headRefOid,baseRefOid,changedFiles',
  ], NETWORK_TIMEOUT_MILLISECONDS)

  let view: PullRequestView
  try {
    view = JSON.parse(viewText) as PullRequestView
  } catch {
    throw new ReviewSourceError(`gh pr view ${pullRequestNumber} printed something other than JSON.`)
  }

  const revisions = [`${view.baseRefOid}...${view.headRefOid}`]
  const hasBothCommits = await hasCommit(git, view.baseRefOid) && await hasCommit(git, view.headRefOid)

  if (hasBothCommits) {
    await diffToFile({ directory: repositoryRoot, revisions, outputPath })

    return describe(view)
  }

  let isTooLargeForGitHub = view.changedFiles > MAXIMUM_FILES_FOR_GITHUB_DIFF

  if (!isTooLargeForGitHub) {
    const downloaded = await runCommandToFile(['gh', 'pr', 'diff', String(pullRequestNumber), '--color=never'], {
      cwd: repositoryRoot,
      outputPath,
      maximumBytes: MAXIMUM_PATCH_BYTES,
      timeoutMs: NETWORK_TIMEOUT_MILLISECONDS,
    })

    if (downloaded.exitCode === 0) return describe(view)

    isTooLargeForGitHub = GITHUB_TOO_LARGE_PATTERN.test(downloaded.stderr)

    if (!isTooLargeForGitHub) {
      throw new ReviewSourceError(`gh pr diff failed: ${downloaded.stderr.split('\n').find(line => line.trim() !== '') ?? 'no output'}`)
    }
  }

  if ((await git.output(['git', 'rev-parse', '--is-shallow-repository'])).trim() === 'true') {
    throw new ReviewSourceError('This pull request is too large for GitHub to diff, and this clone is shallow. Run git fetch --unshallow, or review a narrower target.')
  }

  const remote = await findRemoteOf(git, repositoryName)

  if (remote === null) {
    throw new ReviewSourceError(`This pull request is too large for GitHub to diff, and no remote of this clone points at ${repositoryName}.`)
  }

  const quarantineDirectory = join(scratchDirectory, 'quarantine')

  try {
    const environment = await fetchIntoQuarantine({
      git,
      repositoryRoot,
      remote,
      baseObjectId: view.baseRefOid,
      pullRequestNumber,
      quarantineDirectory,
    })

    await diffToFile({ directory: repositoryRoot, revisions, outputPath, environment })
  } finally {
    rmSync(quarantineDirectory, { recursive: true, force: true })
  }

  return describe(view)
}
