import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findReviewCandidate } from './review/git.ts'
import { ingestAnalysis } from './analysis/ingest.ts'
import { ANALYSIS_FILE_NAME } from './analysis/sessionAnalysis.ts'
import { collect, parseCollectInput } from './collect/collect.ts'
import { createCommandRunner } from './collect/commandRunner.ts'
import { isRecord } from './json.ts'
import { CommandKind, LaunchExitCode } from './types.ts'
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

type Command =
  | { kind: CommandKind.Open; reviewDirectory: string }
  | { kind: CommandKind.Stat; reviewDirectory: string }
  | { kind: CommandKind.Collect; workingDirectory: string }
  | { kind: CommandKind.Ingest; reviewDirectory: string; reviewId: string; failedReason: string | undefined }
  | { kind: CommandKind.Candidate; workingDirectory: string }
  | { kind: CommandKind.Direct; workingDirectory: string; target: string }
  | { kind: CommandKind.Usage }

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

function readCollectInput(text: string): ReturnType<typeof parseCollectInput> {
  try {
    return parseCollectInput(JSON.parse(text))
  } catch {
    return undefined
  }
}

async function runCollect(workingDirectory: string): Promise<number> {
  const input = readCollectInput(await Bun.stdin.text())

  if (input === undefined) {
    print({ isCollected: false, message: 'review-changes collect expects JSON on stdin.', modelMessage: 'review-changes collect expects JSON on stdin.' })

    return LaunchExitCode.Usage
  }

  print(await collect(input, workingDirectory))

  return 0
}

async function runIngest(reviewDirectory: string, reviewId: string, failedReason: string | undefined): Promise<number> {
  let analysisStartedAt = new Date().toISOString()

  try {
    const existing: unknown = JSON.parse(readFileSync(join(reviewDirectory, ANALYSIS_FILE_NAME), 'utf8'))

    if (isRecord(existing) && typeof existing.analysisStartedAt === 'string') analysisStartedAt = existing.analysisStartedAt
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

async function runCandidate(workingDirectory: string): Promise<number> {
  print(await findReviewCandidate(createCommandRunner(), workingDirectory))

  return 0
}

function withoutOption(argumentsList: string[], name: string): string[] {
  const position = argumentsList.indexOf(name)

  return position === -1 ? argumentsList : argumentsList.toSpliced(position, 2)
}

async function runDirect(workingDirectory: string, target: string): Promise<number> {
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

function parseCommandLine(argumentsList: string[], currentDirectory: string): Command {
  const [subcommand, reviewDirectory] = argumentsList
  const workingDirectory = valueOfOption(argumentsList, '--cwd') ?? currentDirectory

  if (subcommand === CommandKind.Open || subcommand === CommandKind.Stat) {
    if (reviewDirectory === undefined) return { kind: CommandKind.Usage }

    return subcommand === CommandKind.Open ? { kind: CommandKind.Open, reviewDirectory } : { kind: CommandKind.Stat, reviewDirectory }
  }

  if (subcommand === CommandKind.Collect) return { kind: CommandKind.Collect, workingDirectory }
  if (subcommand === CommandKind.Candidate) return { kind: CommandKind.Candidate, workingDirectory }

  if (subcommand === CommandKind.Ingest) {
    const reviewId = valueOfOption(argumentsList, '--review-id')

    if (reviewDirectory === undefined || reviewId === undefined) return { kind: CommandKind.Usage }

    return { kind: CommandKind.Ingest, reviewDirectory, reviewId, failedReason: valueOfOption(argumentsList, '--failed') }
  }

  return { kind: CommandKind.Direct, workingDirectory, target: withoutOption(argumentsList, '--cwd').join(' ') }
}

function runStat(reviewDirectory: string): number {
  try {
    describe(reviewDirectory)

    return 0
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'unreadable review'}\n`)

    return error instanceof UnsupportedSchemaError ? LaunchExitCode.UnsupportedSchema : LaunchExitCode.Unreadable
  }
}

async function main(command: Command): Promise<number> {
  switch (command.kind) {
    case CommandKind.Open:
      runApp(command.reviewDirectory)

      return -1
    case CommandKind.Stat:
      return runStat(command.reviewDirectory)
    case CommandKind.Collect:
      return runCollect(command.workingDirectory)
    case CommandKind.Ingest:
      return runIngest(command.reviewDirectory, command.reviewId, command.failedReason)
    case CommandKind.Candidate:
      return runCandidate(command.workingDirectory)
    case CommandKind.Direct:
      return runDirect(command.workingDirectory, command.target)
    case CommandKind.Usage:
      process.stderr.write(`${USAGE}\n`)

      return LaunchExitCode.Usage
    default: {
      const unhandledCommand: never = command
      return unhandledCommand
    }
  }
}

const exitCode = await main(parseCommandLine(process.argv.slice(2), process.cwd()))

if (exitCode >= 0) process.exit(exitCode)
