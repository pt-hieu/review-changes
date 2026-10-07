import { TargetRequestKind } from './types.ts'

export type TargetRequest =
  | { kind: TargetRequestKind.Auto }
  | { kind: TargetRequestKind.Worktree }
  | { kind: TargetRequestKind.PullRequest; number: number; url?: { owner: string; name: string } }
  | { kind: TargetRequestKind.Range; base: string; head: string; isMergeBase: boolean }
  | { kind: TargetRequestKind.Revision; revision: string }

export class TargetError extends Error {
  override name = 'TargetError'
}

export const TARGET_USAGE = [
  'Usage: /review-changes [target]',
  '  (nothing)     uncommitted changes, else the branch vs the default branch',
  '  --worktree    uncommitted changes, staged and unstaged, with untracked files',
  '  <branch>      the branch vs the default branch, from their merge base',
  '  <commit>      one commit vs its parent',
  '  A...B         B vs A, from their merge base',
  '  A..B          B vs A',
  '  #53 | 53 | <pull request URL>   a pull request of this repo',
].join('\n')

const RANGE_SEPARATORS_LONGEST_FIRST = ['...', '..']
const PULL_REQUEST_NUMBER_PATTERN = /^#?(\d+)$/
const PULL_REQUEST_URL_PATTERN = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/

export function parseTargetArgument(text: string): TargetRequest {
  const trimmed = text.trim()
  if (trimmed === '') return { kind: TargetRequestKind.Auto }

  const tokens = trimmed.split(/\s+/)
  const unknownOption = tokens.find(token => token.startsWith('-') && token !== '--worktree')
  if (unknownOption !== undefined) throw new TargetError(`Unknown option "${unknownOption}".\n${TARGET_USAGE}`)
  if (tokens.length > 1) throw new TargetError(`Give one target, not ${tokens.length}.\n${TARGET_USAGE}`)

  const token = trimmed
  if (token === '--worktree') return { kind: TargetRequestKind.Worktree }

  const numberMatch = PULL_REQUEST_NUMBER_PATTERN.exec(token)
  if (numberMatch) return { kind: TargetRequestKind.PullRequest, number: parsePullRequestNumber(numberMatch[1]!) }

  const urlMatch = PULL_REQUEST_URL_PATTERN.exec(token)
  if (urlMatch) {
    return {
      kind: TargetRequestKind.PullRequest,
      number: parsePullRequestNumber(urlMatch[3]!),
      url: { owner: urlMatch[1]!, name: urlMatch[2]!.replace(/\.git$/, '') },
    }
  }

  const separator = RANGE_SEPARATORS_LONGEST_FIRST.find(candidate => token.includes(candidate))
  if (separator !== undefined) {
    const separatorIndex = token.indexOf(separator)
    const base = token.slice(0, separatorIndex) || 'HEAD'
    const head = token.slice(separatorIndex + separator.length) || 'HEAD'

    const optionLikeSide = [base, head].find(side => side.startsWith('-'))
    if (optionLikeSide !== undefined) {
      throw new TargetError(`A range side cannot start with "-": "${optionLikeSide}".\n${TARGET_USAGE}`)
    }

    return { kind: TargetRequestKind.Range, base, head, isMergeBase: separator === '...' }
  }

  return { kind: TargetRequestKind.Revision, revision: token }
}

function parsePullRequestNumber(digits: string): number {
  const pullRequestNumber = Number(digits)

  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) {
    throw new TargetError(`"${digits}" is not a pull request number.\n${TARGET_USAGE}`)
  }

  return pullRequestNumber
}
