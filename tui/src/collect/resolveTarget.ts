import {
  EMPTY_TREE,
  ReviewSourceError,
  countCommitsAhead,
  currentBranch,
  findDefaultBranch,
  parseCommitLog,
} from '../review/git.ts'
import type { RepositoryContext } from '../review/git.ts'
import type { ReviewCommit, ReviewTarget } from '../review/payload.ts'
import type { TargetRequest } from '../review/target.ts'
import { ReviewTargetKind, TargetRequestKind } from '../review/types.ts'
import { diffToFile } from './diffCommand.ts'
import { collectPullRequestToFile } from './pullRequest.ts'
import { diffWorktreeToFile } from './worktree.ts'

export type PatchDestination = { scratchDirectory: string; outputPath: string }

export type TargetDetails = {
  target: ReviewTarget
  title: string
  description?: string
  commits: ReviewCommit[]
}

export type ResolvedTarget = {
  writePatch: (destination: PatchDestination) => Promise<TargetDetails>
}

const STATUS_COMMAND = ['git', 'status', '--porcelain=v1', '-z', '--untracked-files=all']

async function resolveWorktree({ git, repository }: RepositoryContext): Promise<ResolvedTarget> {
  const branch = await currentBranch(git)
  const label = `Uncommitted changes on ${branch ?? 'detached HEAD'}`
  const hasHead = await git.succeeds(['git', 'rev-parse', '--verify', '--quiet', 'HEAD'])
  const base = hasHead ? 'HEAD' : EMPTY_TREE

  return {
    writePatch: async destination => {
      await diffWorktreeToFile({
        runCommand: git.runCommand,
        repositoryRoot: repository.root,
        scratchDirectory: destination.scratchDirectory,
        outputPath: destination.outputPath,
      })

      return { target: { kind: ReviewTargetKind.Worktree, key: 'worktree', label, branch, base }, title: label, commits: [] }
    },
  }
}

async function resolveRange(context: RepositoryContext, base: string, head: string, isMergeBase: boolean): Promise<ResolvedTarget> {
  const { git, repository } = context

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

  const commits = parseCommitLog(await git.output(['git', 'log', '--reverse', '--format=%H%x1f%s%x1f%an%x1e', `${from}..${head}`]))
  const label = `${head} vs ${base}`

  return {
    writePatch: async destination => {
      await diffToFile({ directory: repository.root, revisions: [range], outputPath: destination.outputPath })

      return {
        target: { kind: ReviewTargetKind.Range, key: `range-${range}`, label, base, head, isMergeBase },
        title: commits.length === 1 ? commits[0]!.subject : label,
        commits,
      }
    },
  }
}

async function resolveRevision(context: RepositoryContext, revision: string): Promise<ResolvedTarget> {
  const { git, repository } = context
  const isBranch = await git.succeeds(['git', 'show-ref', '--verify', '--quiet', `refs/heads/${revision}`])
    || await git.succeeds(['git', 'show-ref', '--verify', '--quiet', `refs/remotes/${revision}`])

  if (isBranch) {
    const defaultBranch = await findDefaultBranch(git)

    if (defaultBranch === null) {
      throw new ReviewSourceError(`No default branch to compare ${revision} with; name a range such as main...${revision}.`)
    }

    return resolveRange(context, defaultBranch, revision, true)
  }

  if (!await git.succeeds(['git', 'rev-parse', '--verify', '--quiet', `${revision}^{commit}`])) {
    throw new ReviewSourceError(`Unknown revision "${revision}"`)
  }

  const sha = (await git.output(['git', 'rev-parse', `${revision}^{commit}`])).trim()
  const parentResult = await git.run(['git', 'rev-parse', '--verify', '--quiet', `${sha}^1`])
  const parent = parentResult.exitCode === 0 ? parentResult.stdout.trim() : EMPTY_TREE
  const commits = parseCommitLog(await git.output(['git', 'log', '-1', '--format=%H%x1f%s%x1f%an', sha]))

  return {
    writePatch: async destination => {
      await diffToFile({ directory: repository.root, revisions: [parent, sha], outputPath: destination.outputPath })

      return {
        target: { kind: ReviewTargetKind.Commit, key: `commit-${sha.slice(0, 12)}`, label: `${revision} (${sha.slice(0, 7)})`, revision, sha },
        title: commits[0]?.subject ?? revision,
        commits,
      }
    },
  }
}

async function resolveAutomatic(context: RepositoryContext): Promise<ResolvedTarget> {
  const { git } = context
  const status = await git.output(STATUS_COMMAND)

  if (status !== '') return resolveWorktree(context)

  const branchName = await currentBranch(git) ?? 'HEAD'
  const defaultBranch = await findDefaultBranch(git)

  if (defaultBranch === null) {
    throw new ReviewSourceError(`Nothing to review: no uncommitted changes, and no default branch to compare ${branchName} with.`)
  }

  if (await countCommitsAhead(git, defaultBranch) === 0) {
    throw new ReviewSourceError(`Nothing to review: no uncommitted changes, and ${branchName} is not ahead of ${defaultBranch}.`)
  }

  return resolveRange(context, defaultBranch, 'HEAD', true)
}

function resolvePullRequest(
  { git, repository }: RepositoryContext,
  request: Extract<TargetRequest, { kind: TargetRequestKind.PullRequest }>,
): ResolvedTarget {
  return {
    writePatch: destination =>
      collectPullRequestToFile({
        git,
        repositoryRoot: repository.root,
        pullRequestNumber: request.number,
        url: request.url,
        scratchDirectory: destination.scratchDirectory,
        outputPath: destination.outputPath,
      }),
  }
}

export async function resolveTarget(context: RepositoryContext, request: TargetRequest): Promise<ResolvedTarget> {
  switch (request.kind) {
    case TargetRequestKind.Auto:
      return resolveAutomatic(context)
    case TargetRequestKind.Worktree:
      return resolveWorktree(context)
    case TargetRequestKind.Range:
      return resolveRange(context, request.base, request.head, request.isMergeBase)
    case TargetRequestKind.Revision:
      return resolveRevision(context, request.revision)
    case TargetRequestKind.PullRequest:
      return resolvePullRequest(context, request)
  }
}
