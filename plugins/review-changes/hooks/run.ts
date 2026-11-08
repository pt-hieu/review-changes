import type { PluginState } from 'claude-code'

import { BUN_MISSING_MESSAGE, appArguments, forgetBunPath, resolveBun } from './bun.ts'
import type { CommandRunner } from './bun.ts'
import {
  closeArguments,
  focusArguments,
  isBlockAlive,
  locateRex,
  parseSplitBlockId,
  runRex,
  splitArguments,
} from './rex.ts'
import type { RexLocation } from './rex.ts'
import { PaneOutcome, ReviewPhase, SessionMessageRole } from './types.ts'

type ReviewChangesState = PluginState['review-changes']

export type SessionMessageText = { role: SessionMessageRole; text: string }

export type CollectedReview = {
  isCollected: true
  reviewId: string
  reviewDirectory: string
  repositoryRoot: string
  label: string
  modelLabel: string
  fileCount: number
  additions: number
  deletions: number
  isAnalysisCurrent: boolean
  analyzerPrompt: string
}

export type AnalyzerAnswer = { answer: string; reason: string }

export type RexEnvironment = { block?: string; session?: string; binaryDirectory?: string; home?: string }

export type ReviewChangesEngine = {
  pluginDirectory: string
  runCommand: CommandRunner
  readEnvironment: () => Promise<RexEnvironment>
  sessionWorkingDirectory: () => Promise<string>
  readSessionMessages: () => Promise<SessionMessageText[]>
  spawnAnalyzer: (request: { prompt: string; description: string; cwd: string }) => Promise<{
    agentId?: string
    model?: string
    deny?: string
  }>
  after: (milliseconds: number, callback: () => void) => { cancel: () => void }
  toast: (text: string, timeoutMilliseconds: number) => void
  readRun: () => Promise<ReviewChangesState['run']>
  updateRun: (change: (current: ReviewChangesState['run']) => ReviewChangesState['run']) => Promise<void>
  readPane: () => Promise<ReviewChangesState['pane']>
  writePane: (value: ReviewChangesState['pane']) => Promise<void>
  readCandidate: () => Promise<ReviewChangesState['candidate']>
  writeCandidate: (value: ReviewChangesState['candidate']) => Promise<void>
}

export type NotCollected = { isCollected: false; message: string; modelMessage: string }

export type StartedReview = { text: string; userText?: string; completion?: Promise<void> }

export const ANALYZER_AGENT = 'review-changes:analyzer'

export const ANALYZER_FINISHED_NOTIFICATION =
  'The user ran the review-changes plugin, which started this subagent to lay out a code change for them. The subagent has finished, and the plugin shows its answer in the review pane, where the user reviews the change themselves. Nothing here needs action from you: acknowledge it in one short sentence.'

export const ANSWER_TIMEOUT_MILLISECONDS = 15 * 60_000
export const COLLECT_TIMEOUT_MILLISECONDS = 600_000
export const MESSAGE_CHARACTER_LIMIT = 4001

const MAXIMUM_EARLY_ANSWERS = 20
const INGEST_TIMEOUT_MILLISECONDS = 120_000
const ERROR_CHARACTER_LIMIT = 120
const HIDDEN_CHARACTERS = /[\p{C}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu

let runIdStartedByThisModuleLife: string | null = null
const answerWaiters = new Map<string, (input: AnalyzerAnswer) => void>()
const earlyAnswers = new Map<string, AnalyzerAnswer>()
const analyzerAgentIds = new Set<string>()

export function currentRunId(): string | null {
  return runIdStartedByThisModuleLife
}

export function isFromAnalyzer(text: string): boolean {
  return [...analyzerAgentIds].some(agentId => text.includes(`from="${agentId}"`))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function plainLine(text: string): string {
  const firstLine = text.split('\n').map(line => line.trim()).find(line => line !== '') ?? ''

  return firstLine.replace(HIDDEN_CHARACTERS, ' ').slice(0, ERROR_CHARACTER_LIMIT)
}

function quoted(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

function countOf(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`
}

export function deliver(agentId: string, input: AnalyzerAnswer): void {
  const waiter = answerWaiters.get(agentId)

  if (waiter) {
    waiter(input)

    return
  }

  if (runIdStartedByThisModuleLife === null) return

  earlyAnswers.set(agentId, input)

  for (const staleAgentId of earlyAnswers.keys()) {
    if (earlyAnswers.size <= MAXIMUM_EARLY_ANSWERS) break

    earlyAnswers.delete(staleAgentId)
  }
}

function registerAnswerWaiterSynchronously(engine: ReviewChangesEngine, agentId: string): Promise<AnalyzerAnswer> {
  return new Promise((resolve, reject) => {
    const earlyAnswer = earlyAnswers.get(agentId)

    if (earlyAnswer) {
      earlyAnswers.delete(agentId)
      resolve(earlyAnswer)

      return
    }

    const timer = engine.after(ANSWER_TIMEOUT_MILLISECONDS, () => {
      answerWaiters.delete(agentId)
      reject(new Error('the analyzer gave no answer within 15 minutes'))
    })

    answerWaiters.set(agentId, input => {
      timer.cancel()
      answerWaiters.delete(agentId)
      resolve(input)
    })
  })
}

async function clearRun(engine: ReviewChangesEngine, runId: string): Promise<void> {
  if (runIdStartedByThisModuleLife === runId) runIdStartedByThisModuleLife = null

  await engine.updateRun(current => (current?.runId === runId ? null : current))
}

const UNREADABLE_RESULT: NotCollected = {
  isCollected: false,
  message: 'review-changes could not read the collected review.',
  modelMessage: 'review-changes could not read the collected review.',
}

function parseCollectResult(stdout: string): CollectedReview | NotCollected {
  try {
    const parsed = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as Record<string, unknown>

    if (parsed.isCollected === true && typeof parsed.reviewDirectory === 'string' && typeof parsed.reviewId === 'string') {
      return parsed as unknown as CollectedReview
    }

    if (parsed.isCollected === false && typeof parsed.message === 'string' && typeof parsed.modelMessage === 'string') {
      return { isCollected: false, message: plainLine(parsed.message), modelMessage: plainLine(parsed.modelMessage) }
    }
  } catch {
    return UNREADABLE_RESULT
  }

  return UNREADABLE_RESULT
}

async function bundleExists(engine: ReviewChangesEngine, appPath: string): Promise<boolean> {
  try {
    return (await engine.runCommand(['test', '-f', appPath])).exitCode === 0
  } catch {
    return false
  }
}

async function collectReview(
  engine: ReviewChangesEngine,
  bunPath: string,
  appPath: string,
  argumentText: string,
): Promise<CollectedReview | NotCollected> {
  const messages = (await engine.readSessionMessages().catch(() => []))
    .filter(message => message.role === SessionMessageRole.User)
    .map(message => ({ role: message.role, text: message.text.slice(0, MESSAGE_CHARACTER_LIMIT) }))
  const workingDirectory = await engine.sessionWorkingDirectory()

  const result = await engine.runCommand(appArguments(bunPath, appPath, 'collect', '--cwd', workingDirectory), {
    cwd: engine.pluginDirectory,
    stdin: JSON.stringify({ target: argumentText.trim(), messages }),
    timeoutMs: COLLECT_TIMEOUT_MILLISECONDS,
  })

  if (result.stdout.trim() === '') {
    return {
      isCollected: false,
      message: `review-changes could not collect the changes${result.stderr ? `: ${plainLine(result.stderr)}` : '.'}`,
      modelMessage: 'review-changes could not collect the changes.',
    }
  }

  return parseCollectResult(result.stdout)
}

export function openCommandLine(bunPath: string, appPath: string, reviewDirectory: string): string {
  return `${quoted(bunPath)} --no-env-file ${quoted(appPath)} open ${quoted(reviewDirectory)}`
}

async function showPane(
  engine: ReviewChangesEngine,
  input: { rex: RexLocation | null; bunPath: string; appPath: string; collected: CollectedReview },
): Promise<{ outcome: PaneOutcome; detail: string }> {
  const { rex, bunPath, appPath, collected } = input
  const pane = await engine.readPane()
  const nextPane = (blockId: string | null) => ({
    reviewDirectory: collected.reviewDirectory,
    repositoryRoot: collected.repositoryRoot,
    label: collected.label,
    blockId,
  })

  if (rex === null) {
    await engine.writePane(nextPane(null))

    return { outcome: PaneOutcome.NotInRex, detail: '' }
  }

  if (pane?.blockId && await isBlockAlive(engine.runCommand, rex, pane.blockId)) {
    if (pane.reviewDirectory === collected.reviewDirectory && collected.isAnalysisCurrent) {
      await runRex(engine.runCommand, focusArguments(rex, pane.blockId))

      return { outcome: PaneOutcome.Focused, detail: '' }
    }

    await runRex(engine.runCommand, closeArguments(rex, pane.blockId))
  }

  try {
    const split = await runRex(engine.runCommand, splitArguments(rex, bunPath, appPath, engine.pluginDirectory, collected.reviewDirectory))
    const blockId = split.exitCode === 0 ? parseSplitBlockId(split.stdout) : null

    if (blockId === null) {
      await engine.writePane(nextPane(null))

      return { outcome: PaneOutcome.Failed, detail: plainLine(split.stderr || split.stdout) || `rex exited with ${split.exitCode}` }
    }

    await engine.writePane(nextPane(blockId))

    return { outcome: PaneOutcome.Opened, detail: '' }
  } catch (error) {
    await engine.writePane(nextPane(null))

    return { outcome: PaneOutcome.Failed, detail: plainLine(messageOf(error)) }
  }
}

function summaryText(collected: CollectedReview, outcome: PaneOutcome, detail: string, commandLine: string): string {
  const size = `${collected.modelLabel}: ${countOf(collected.fileCount, 'file')}, +${collected.additions}/−${collected.deletions}`
  const analysis = collected.isAnalysisCurrent
    ? 'The analysis is already up to date.'
    : 'The analysis runs in the background; the pane picks it up when it lands.'

  switch (outcome) {
    case PaneOutcome.Opened:
      return `Opened the review pane for ${size}. ${analysis}`
    case PaneOutcome.Focused:
      return `The review pane for ${size} is already open and up to date; it has focus.`
    case PaneOutcome.NotInRex:
      return `Review of ${size} is ready. Not inside Rex, so no pane was opened. To open it, run: ${commandLine} ${analysis}`
    case PaneOutcome.Failed:
      return `Review of ${size} is ready, but the Rex pane did not open (${detail}). To open it, run: ${commandLine} ${analysis}`
  }
}

export async function startReview(engine: ReviewChangesEngine, argumentText: string): Promise<StartedReview> {
  if (runIdStartedByThisModuleLife !== null) {
    const current = await engine.readRun()

    return { text: 'A review is already running.', userText: `A review is already running: ${current?.label ?? 'current changes'}.` }
  }

  const runId = crypto.randomUUID()
  runIdStartedByThisModuleLife = runId

  try {
    return await collectAndAnalyze(engine, runId, argumentText)
  } catch (error) {
    await clearRun(engine, runId).catch(() => undefined)

    throw error
  }
}

async function collectAndAnalyze(engine: ReviewChangesEngine, runId: string, argumentText: string): Promise<StartedReview> {
  await engine.updateRun(() => ({ runId, label: 'current changes', phase: ReviewPhase.Collecting }))

  const environment = await engine.readEnvironment()
  let bunPath = await resolveBun(engine.runCommand, environment.home, engine.pluginDirectory)

  if (bunPath === null) {
    await clearRun(engine, runId)

    return { text: BUN_MISSING_MESSAGE }
  }

  const appPath = `${engine.pluginDirectory}/assets/review-changes.js`

  if (!await bundleExists(engine, appPath)) {
    await clearRun(engine, runId)

    return { text: `review-changes's app bundle is missing at ${appPath}. Run bun run build:tui in the plugin's repository.` }
  }

  let collected: Awaited<ReturnType<typeof collectReview>>

  try {
    collected = await collectReview(engine, bunPath, appPath, argumentText)
  } catch {
    forgetBunPath()
    bunPath = await resolveBun(engine.runCommand, environment.home, engine.pluginDirectory)

    if (bunPath === null) {
      await clearRun(engine, runId)

      return { text: BUN_MISSING_MESSAGE }
    }

    collected = await collectReview(engine, bunPath, appPath, argumentText)
  }

  if (!collected.isCollected) {
    await clearRun(engine, runId)

    return { text: collected.modelMessage, userText: collected.message }
  }

  const rex = locateRex(environment)
  const { outcome, detail } = await showPane(engine, { rex, bunPath, appPath, collected })
  const commandLine = openCommandLine(bunPath, appPath, collected.reviewDirectory)
  const text = summaryText(collected, outcome, detail, commandLine)

  if (collected.isAnalysisCurrent) {
    await clearRun(engine, runId)
    await refreshCandidate(engine)

    return { text }
  }

  let answer: Promise<AnalyzerAnswer> | undefined
  let spawnFailure = 'the analyzer did not start'

  try {
    const spawned = await engine.spawnAnalyzer({
      description: 'Group changes for review',
      prompt: collected.analyzerPrompt,
      cwd: collected.repositoryRoot,
    })

    if (spawned.deny) spawnFailure = spawned.deny

    if (spawned.agentId) {
      analyzerAgentIds.add(spawned.agentId)
      answer = registerAnswerWaiterSynchronously(engine, spawned.agentId)
    }
  } catch (error) {
    spawnFailure = `the analyzer did not start (${messageOf(error)})`
  }

  await engine.updateRun(() => ({ runId, label: collected.label, phase: ReviewPhase.Analyzing }))

  const completion = finishAnalysis(engine, {
    runId,
    bunPath,
    appPath,
    collected,
    answer: answer ?? Promise.reject(new Error(spawnFailure)),
  })

  return { text, completion }
}

async function finishAnalysis(
  engine: ReviewChangesEngine,
  input: { runId: string; bunPath: string; appPath: string; collected: CollectedReview; answer: Promise<AnalyzerAnswer> },
): Promise<void> {
  const { runId, bunPath, appPath, collected, answer } = input
  const ingestArguments = appArguments(bunPath, appPath, 'ingest', collected.reviewDirectory, '--review-id', collected.reviewId)

  try {
    let ingest: Awaited<ReturnType<CommandRunner>>

    try {
      const settled = await answer

      if (settled.reason !== 'answer') throw new Error(`the analyzer ended (${settled.reason})`)

      ingest = await engine.runCommand(ingestArguments, { cwd: engine.pluginDirectory, stdin: settled.answer, timeoutMs: INGEST_TIMEOUT_MILLISECONDS })
    } catch (error) {
      ingest = await engine.runCommand([...ingestArguments, '--failed', plainLine(messageOf(error))], { cwd: engine.pluginDirectory, timeoutMs: INGEST_TIMEOUT_MILLISECONDS })
    }

    if (ingest.exitCode === 0) engine.toast(`Analysis landed for ${collected.label}`, 4000)
    else engine.toast(`review-changes could not record the analysis: ${plainLine(ingest.stdout || ingest.stderr)}`, 8000)
  } catch (error) {
    engine.toast(`review-changes analysis failed: ${plainLine(messageOf(error))}`, 8000)
  } finally {
    await clearRun(engine, runId).catch(() => undefined)
    await refreshCandidate(engine)
  }
}

export async function startReviewWithToast(engine: ReviewChangesEngine, argumentText: string): Promise<void> {
  try {
    const { text, userText } = await startReview(engine, argumentText)

    engine.toast(userText ?? text, 8000)
  } catch (error) {
    engine.toast(`review-changes failed: ${plainLine(messageOf(error))}`, 8000)
  }
}

export async function openPane(engine: ReviewChangesEngine): Promise<void> {
  const pane = await engine.readPane()
  const environment = await engine.readEnvironment()
  const rex = locateRex(environment)

  if (pane === null || rex === null) return

  if (pane.blockId && await isBlockAlive(engine.runCommand, rex, pane.blockId)) {
    await runRex(engine.runCommand, focusArguments(rex, pane.blockId))

    return
  }

  const bunPath = await resolveBun(engine.runCommand, environment.home, engine.pluginDirectory)

  if (bunPath === null) {
    engine.toast(BUN_MISSING_MESSAGE, 8000)

    return
  }

  const appPath = `${engine.pluginDirectory}/assets/review-changes.js`
  const split = await runRex(engine.runCommand, splitArguments(rex, bunPath, appPath, engine.pluginDirectory, pane.reviewDirectory))
  const blockId = split.exitCode === 0 ? parseSplitBlockId(split.stdout) : null

  if (blockId === null) {
    engine.toast(`The Rex pane did not open (${plainLine(split.stderr || split.stdout)}).`, 8000)

    return
  }

  await engine.writePane({ ...pane, blockId })
}

export async function refreshCandidate(engine: ReviewChangesEngine): Promise<void> {
  try {
    const environment = await engine.readEnvironment()
    const bunPath = await resolveBun(engine.runCommand, environment.home, engine.pluginDirectory)

    if (bunPath === null) return

    const workingDirectory = await engine.sessionWorkingDirectory()
    const result = await engine.runCommand(
      appArguments(bunPath, `${engine.pluginDirectory}/assets/review-changes.js`, 'candidate', '--cwd', workingDirectory),
      { cwd: engine.pluginDirectory, timeoutMs: 30_000 },
    )
    const parsed = JSON.parse(result.stdout.trim() || 'null') as { summary?: unknown } | null
    const found = parsed !== null && typeof parsed.summary === 'string' ? { summary: plainLine(parsed.summary) } : null
    const current = await engine.readCandidate()

    if ((current?.summary ?? null) === (found?.summary ?? null)) return

    await engine.writeCandidate(found)
  } catch {
    return
  }
}

export async function resetRun(engine: ReviewChangesEngine): Promise<void> {
  runIdStartedByThisModuleLife = null
  await engine.updateRun(() => null)
}
