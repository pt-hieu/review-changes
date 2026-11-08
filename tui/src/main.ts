import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findReviewCandidate } from './review/git.ts'
import type { SessionMessageText } from './review/analysis.ts'
import { ingestAnalysis } from './analysis/ingest.ts'
import { ANALYSIS_FILE_NAME } from './analysis/sessionAnalysis.ts'
import { collect } from './collect/collect.ts'
import { createCommandRunner } from './collect/commandRunner.ts'
import type { SessionAnalysis } from './contract.ts'
import { LaunchExitCode } from './types.ts'
import { loadReview, UnsupportedSchemaError } from './session/loadReview.ts'
import { loadOrCreateSeed } from './store/reviewedStore.ts'
import { runApp } from './view/runtime.ts'

const USAGE = [
  'usage: review-changes [--cwd DIR] [target]',
  '       review-changes open <reviewDirectory>',
  '       review-changes stat <reviewDirectory>',
  '       review-changes collect --cwd DIR            (stdin: {"target": string, "messages": [...]})',
  '       review-changes ingest <reviewDirectory> --review-id ID [--failed REASON]   (stdin: the analyzer answer)',
  '       review-changes candidate --cwd DIR',
].join('\n')

function valueOfOption(argumentsList: string[], name: string): string | undefined {
  const position = argumentsList.indexOf(name)

  return position === -1 ? undefined : argumentsList[position + 1]
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function describe(reviewDirectory: string): void {
  const seed = loadOrCreateSeed(join(reviewDirectory, 'reviewed'))
  const review = loadReview(reviewDirectory, seed)
  const { table } = review

  print({
    files: table.fileCount,
    hunks: table.hunkCount,
    additions: table.totalAdditions(),
    deletions: table.totalDeletions(),
    patchBytes: table.patchByteLength,
    scanMilliseconds: Math.round(review.scanMilliseconds),
  })
  review.reader.close()
}

async function runCollect(argumentsList: string[]): Promise<number> {
  const workingDirectory = valueOfOption(argumentsList, '--cwd') ?? process.cwd()
  let input: { target: string; messages: SessionMessageText[] }

  try {
    const parsed = JSON.parse(await Bun.stdin.text()) as Partial<typeof input>

    input = { target: typeof parsed.target === 'string' ? parsed.target : '', messages: Array.isArray(parsed.messages) ? parsed.messages : [] }
  } catch {
    print({ isCollected: false, message: 'review-changes collect expects JSON on stdin.', modelMessage: 'review-changes collect expects JSON on stdin.' })

    return LaunchExitCode.Usage
  }

  print(await collect(input, workingDirectory))

  return 0
}

async function runIngest(argumentsList: string[]): Promise<number> {
  const reviewDirectory = argumentsList[1]
  const reviewId = valueOfOption(argumentsList, '--review-id')

  if (reviewDirectory === undefined || reviewId === undefined) {
    process.stderr.write(`${USAGE}\n`)

    return LaunchExitCode.Usage
  }

  const failedReason = valueOfOption(argumentsList, '--failed')
  let analysisStartedAt = new Date().toISOString()

  try {
    const existing = JSON.parse(readFileSync(join(reviewDirectory, ANALYSIS_FILE_NAME), 'utf8')) as Partial<SessionAnalysis>

    if (typeof existing.analysisStartedAt === 'string') analysisStartedAt = existing.analysisStartedAt
  } catch {
    analysisStartedAt = new Date().toISOString()
  }

  try {
    const outcome = ingestAnalysis({
      reviewDirectory,
      reviewId,
      analysisStartedAt,
      ...(failedReason === undefined ? { answer: await Bun.stdin.text() } : { failedReason }),
    })

    print(outcome)

    return outcome.isIngested ? 0 : LaunchExitCode.Unreadable
  } catch (error) {
    print({ isIngested: false, message: error instanceof Error ? error.message : 'unreadable review' })

    return error instanceof UnsupportedSchemaError ? LaunchExitCode.UnsupportedSchema : LaunchExitCode.Unreadable
  }
}

async function runCandidate(argumentsList: string[]): Promise<number> {
  const workingDirectory = valueOfOption(argumentsList, '--cwd') ?? process.cwd()

  print(await findReviewCandidate(createCommandRunner(), workingDirectory))

  return 0
}

function withoutOption(argumentsList: string[], name: string): string[] {
  const position = argumentsList.indexOf(name)

  return position === -1 ? argumentsList : argumentsList.toSpliced(position, 2)
}

async function runDirect(argumentsList: string[]): Promise<number> {
  const workingDirectory = valueOfOption(argumentsList, '--cwd') ?? process.cwd()
  const target = withoutOption(argumentsList, '--cwd').join(' ')
  const result = await collect({ target, messages: [] }, workingDirectory)

  if (!result.isCollected) {
    process.stderr.write(`${result.message}\n`)

    return LaunchExitCode.Unreadable
  }

  if (!result.isAnalysisCurrent) {
    ingestAnalysis({
      reviewDirectory: result.reviewDirectory,
      reviewId: result.reviewId,
      failedReason: 'not started from Claude Code; showing the default grouping',
      analysisStartedAt: new Date().toISOString(),
    })
  }

  runApp(result.reviewDirectory)

  return -1
}

async function main(argumentsList: string[]): Promise<number> {
  const [subcommand, reviewDirectory] = argumentsList

  if (subcommand === 'open' && reviewDirectory !== undefined) {
    runApp(reviewDirectory)

    return -1
  }

  if (subcommand === 'collect') return runCollect(argumentsList)
  if (subcommand === 'ingest') return runIngest(argumentsList)
  if (subcommand === 'candidate') return runCandidate(argumentsList)

  if (subcommand === 'stat' && reviewDirectory !== undefined) {
    try {
      describe(reviewDirectory)

      return 0
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : 'unreadable review'}\n`)

      return error instanceof UnsupportedSchemaError ? LaunchExitCode.UnsupportedSchema : LaunchExitCode.Unreadable
    }
  }

  if (subcommand === 'open' || subcommand === 'stat') {
    process.stderr.write(`${USAGE}\n`)

    return LaunchExitCode.Usage
  }

  return runDirect(argumentsList)
}

const exitCode = await main(process.argv.slice(2))

if (exitCode >= 0) process.exit(exitCode)
