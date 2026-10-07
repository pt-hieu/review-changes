import { describe, expect, test } from 'claude-code/testing'
import { parseTargetArgument, TargetError } from '../target.ts'
import { TargetRequestKind } from '../types.ts'

describe('parseTargetArgument', () => {
  test('nothing, or only whitespace, picks the target automatically', () => {
    expect(parseTargetArgument('')).toEqual({ kind: TargetRequestKind.Auto })
    expect(parseTargetArgument('   ')).toEqual({ kind: TargetRequestKind.Auto })
  })

  test('--worktree asks for the uncommitted changes', () => {
    expect(parseTargetArgument('--worktree')).toEqual({ kind: TargetRequestKind.Worktree })
  })

  test('a pull request by number, with or without #', () => {
    expect(parseTargetArgument('#53')).toEqual({ kind: TargetRequestKind.PullRequest, number: 53 })
    expect(parseTargetArgument(' 53 ')).toEqual({ kind: TargetRequestKind.PullRequest, number: 53 })
  })

  test('a pull request URL carries the repo it names', () => {
    expect(parseTargetArgument('https://github.com/example/notes/pull/53/files')).toEqual({
      kind: TargetRequestKind.PullRequest,
      number: 53,
      url: { owner: 'example', name: 'notes' },
    })
  })

  test('A...B compares from the merge base, A..B directly', () => {
    expect(parseTargetArgument('main...feature')).toEqual({ kind: TargetRequestKind.Range, base: 'main', head: 'feature', isMergeBase: true })
    expect(parseTargetArgument('main..feature')).toEqual({ kind: TargetRequestKind.Range, base: 'main', head: 'feature', isMergeBase: false })
  })

  test('an empty range side means HEAD', () => {
    expect(parseTargetArgument('...feature')).toEqual({ kind: TargetRequestKind.Range, base: 'HEAD', head: 'feature', isMergeBase: true })
    expect(parseTargetArgument('main..')).toEqual({ kind: TargetRequestKind.Range, base: 'main', head: 'HEAD', isMergeBase: false })
  })

  test('anything else is a revision for git to resolve', () => {
    expect(parseTargetArgument('HEAD~2')).toEqual({ kind: TargetRequestKind.Revision, revision: 'HEAD~2' })
  })

  test('an unknown option is refused with the usage', () => {
    expect(() => parseTargetArgument('-x')).toThrow(TargetError)
    expect(() => parseTargetArgument('-x')).toThrow('Unknown option "-x".')
    expect(() => parseTargetArgument('-x')).toThrow('Usage: /review-changes [target]')
  })

  test('more than one target is refused', () => {
    expect(() => parseTargetArgument('a b')).toThrow(TargetError)
    expect(() => parseTargetArgument('a b')).toThrow('Usage: /review-changes [target]')
  })

  test('a range side that looks like an option is refused', () => {
    expect(() => parseTargetArgument('main...-x')).toThrow(TargetError)
  })
})
