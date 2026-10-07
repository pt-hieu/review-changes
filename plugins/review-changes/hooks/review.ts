import type { PluginState } from 'claude-code'

import { buildAnalyzerPrompt, buildModelNoteWithUntrustedAnalysis, buildSessionNote, fallbackAnalysis, parseAnalyzerAnswer } from './analysis.ts'
import { countOf, totalLineCounts } from './counts.ts'
import { ReviewSourceError, findReviewCandidate, resolveReviewSource } from './git.ts'
import type { ReviewSource, RunCommand } from './git.ts'
import { assembleReviewHtml } from './html.ts'
import { buildReviewFiles } from './patch.ts'
import { REVIEW_PAYLOAD_SCHEMA_VERSION } from './payload.ts'
import type { ReviewFile, ReviewPayload } from './payload.ts'
import { TargetError, parseTargetArgument } from './target.ts'
import { NoticeType } from './types.ts'

type ReviewChangesState = PluginState['review-changes']
type RunState = ReviewChangesState['run']

export type AnalyzerAnswer = { answer: string; reason: string }

export type ReviewEngine = {
  pluginDirectory: string
  runCommand: RunCommand
  shouldOpenBrowser: () => Promise<boolean>
  sessionWorkingDirectory: () => Promise<string>
  readFile: (path: string) => Promise<string>
  writeFile: (path: string, text: string) => Promise<void>
  spawnAnalyzer: (request: { prompt: string; description: string; cwd: string }) => Promise<{
    agentId?: string
    model?: string
    deny?: string
  }>
  now: () => Promise<number>
  after: (milliseconds: number, callback: () => void) => { cancel: () => void }
  setStatus: (text: string | undefined) => void
  toast: (text: string, timeoutMilliseconds: number) => void
  appendNotice: (text: string, type: NoticeType) => Promise<void>
  readRun: () => Promise<RunState>
  updateRun: (change: (current: RunState) => RunState) => Promise<void>
  writeLast: (value: NonNullable<ReviewChangesState['last']>) => Promise<void>
  readCandidate: () => Promise<ReviewChangesState['candidate']>
  writeCandidate: (value: ReviewChangesState['candidate']) => Promise<void>
}

const MILLISECONDS_PER_MINUTE = 60_000
export const ANSWER_TIMEOUT_MILLISECONDS = 15 * MILLISECONDS_PER_MINUTE
const MAXIMUM_EARLY_ANSWERS = 20

let runIdStartedByThisModuleLife: string | null = null
const answerWaiters = new Map<string, (input: AnalyzerAnswer) => void>()
const earlyAnswers = new Map<string, AnalyzerAnswer>()

export function currentRunId(): string | null {
  return runIdStartedByThisModuleLife
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function deliver(agentId: string, input: AnalyzerAnswer): void {
  const waiter = answerWaiters.get(agentId)
  if (waiter) {
    waiter(input)
    return
  }

  const isRunInFlight = runIdStartedByThisModuleLife !== null

  if (!isRunInFlight) return

  holdAnswerArrivingBeforeItsWaiter(agentId, input)
}

function holdAnswerArrivingBeforeItsWaiter(agentId: string, input: AnalyzerAnswer): void {
  earlyAnswers.set(agentId, input)

  for (const staleAgentId of earlyAnswers.keys()) {
    if (earlyAnswers.size <= MAXIMUM_EARLY_ANSWERS) break

    earlyAnswers.delete(staleAgentId)
  }
}

function registerAnswerWaiterSynchronously(
  engine: ReviewEngine,
  agentId: string,
  timeoutMilliseconds: number,
): Promise<AnalyzerAnswer> {
  return new Promise((resolve, reject) => {
    const earlyAnswer = earlyAnswers.get(agentId)
    if (earlyAnswer) {
      earlyAnswers.delete(agentId)
      resolve(earlyAnswer)
      return
    }

    const timer = engine.after(timeoutMilliseconds, () => {
      answerWaiters.delete(agentId)
      reject(new Error(`the analyzer gave no answer within ${Math.round(timeoutMilliseconds / MILLISECONDS_PER_MINUTE)} minutes`))
    })

    answerWaiters.set(agentId, input => {
      timer.cancel()
      answerWaiters.delete(agentId)
      resolve(input)
    })
  })
}

async function clearRun(engine: ReviewEngine, runId: string): Promise<void> {
  if (runIdStartedByThisModuleLife === runId) runIdStartedByThisModuleLife = null

  engine.setStatus(undefined)
  await engine.updateRun(current => (current?.runId === runId ? null : current))
}

export type StartedReview = {
  text: string
  completion?: Promise<void>
}

export async function startReview(engine: ReviewEngine, argumentText: string): Promise<StartedReview> {
  if (runIdStartedByThisModuleLife !== null) {
    const current = await engine.readRun()
    return { text: `A review is already running: ${current?.label ?? 'current changes'}.` }
  }

  let request: ReturnType<typeof parseTargetArgument>
  try {
    request = parseTargetArgument(argumentText)
  } catch (error) {
    if (error instanceof TargetError) return { text: error.message }

    throw error
  }

  const runId = crypto.randomUUID()
  runIdStartedByThisModuleLife = runId

  try {
    return await collectAndAnalyze(engine, runId, request)
  } catch (error) {
    await clearRun(engine, runId).catch(() => undefined)

    throw error
  }
}

async function collectAndAnalyze(
  engine: ReviewEngine,
  runId: string,
  request: ReturnType<typeof parseTargetArgument>,
): Promise<StartedReview> {
  await engine.updateRun(() => ({ runId, label: 'current changes', phase: 'collecting' }))
  engine.setStatus('review-changes: collecting the diff…')

  let source: ReviewSource
  let files: ReviewFile[]
  let outputDirectory: string
  let patchPath: string
  try {
    source = await resolveReviewSource(engine.runCommand, await engine.sessionWorkingDirectory(), request)
    files = await buildReviewFiles(source.patch)
    outputDirectory = `${source.gitCommonDirectory}/review-changes`
    patchPath = `${outputDirectory}/${source.slug}.patch`
    await engine.writeFile(patchPath, source.patch)
  } catch (error) {
    await clearRun(engine, runId)

    if (error instanceof ReviewSourceError) return { text: error.message }

    return { text: `review-changes failed: ${messageOf(error)}` }
  }

  const label = source.target.label

  let model: string | undefined
  let answer: Promise<AnalyzerAnswer> | undefined
  let spawnFailure = 'the analyzer did not start'
  try {
    const spawned = await engine.spawnAnalyzer({
      description: 'Group changes for review',
      prompt: buildAnalyzerPrompt(source, files, patchPath),
      cwd: source.repository.root,
    })

    if (spawned.deny) spawnFailure = spawned.deny

    if (spawned.agentId) {
      model = spawned.model
      answer = registerAnswerWaiterSynchronously(engine, spawned.agentId, ANSWER_TIMEOUT_MILLISECONDS)
    }
  } catch (error) {
    spawnFailure = `the analyzer did not start (${messageOf(error)})`
  }

  await engine.updateRun(() => ({ runId, label, phase: 'analyzing' }))
  engine.setStatus(
    answer
      ? `review-changes: analysing ${countOf(files.length, 'file')} with ${model ?? 'the analyzer'}…`
      : 'review-changes: writing the page…',
  )

  const completion = finishReview(engine, {
    runId,
    source,
    files,
    model,
    outputDirectory,
    answer: answer ?? Promise.reject(new Error(spawnFailure)),
  })

  const { additions, deletions } = totalLineCounts(files)
  return {
    text: `Reviewing ${label} (${countOf(files.length, 'file')}, +${additions}/−${deletions}). The page opens when the analysis is done.`,
    completion,
  }
}

export async function startReviewWithToast(engine: ReviewEngine, argumentText: string): Promise<void> {
  try {
    const { text } = await startReview(engine, argumentText)
    engine.toast(text, 6000)
  } catch (error) {
    engine.toast(`review-changes failed: ${messageOf(error)}`, 8000)
  }
}

async function readViewerAsset(engine: ReviewEngine, fileName: string): Promise<string> {
  const path = `${engine.pluginDirectory}/assets/${fileName}`

  try {
    return await engine.readFile(path)
  } catch (error) {
    throw new Error(`cannot read the viewer bundle at ${path} (${messageOf(error)}); run \`bun run build:viewer\``)
  }
}

async function finishReview(
  engine: ReviewEngine,
  {
    runId,
    source,
    files,
    model,
    outputDirectory,
    answer,
  }: {
    runId: string
    source: ReviewSource
    files: ReviewFile[]
    model: string | undefined
    outputDirectory: string
    answer: Promise<AnalyzerAnswer>
  },
): Promise<void> {
  const label = source.target.label

  try {
    let parsed: ReturnType<typeof parseAnalyzerAnswer>
    try {
      const settled = await answer

      if (settled.reason !== 'answer') throw new Error(`the analyzer ended (${settled.reason})`)

      parsed = parseAnalyzerAnswer(settled.answer, files)
    } catch (error) {
      const reason = messageOf(error)
      parsed = { analysis: fallbackAnalysis(files, reason), error: reason }
    }

    await engine.updateRun(current => (current?.runId === runId ? { runId, label, phase: 'writing' } : current))
    engine.setStatus('review-changes: writing the page…')

    const viewerScript = await readViewerAsset(engine, 'viewer.js')
    const viewerStyle = await readViewerAsset(engine, 'viewer.css')

    const payload: ReviewPayload = {
      schemaVersion: REVIEW_PAYLOAD_SCHEMA_VERSION,
      generatedAt: new Date(await engine.now()).toISOString(),
      repository: source.repository,
      target: source.target,
      title: source.title,
      description: source.description,
      commits: source.commits,
      files,
      analysis: parsed.analysis,
      analysisModel: model,
      analysisError: parsed.error,
    }

    const html = assembleReviewHtml({ payload, viewerScript, viewerStyle })
    const htmlPath = `${outputDirectory}/${source.slug}.html`
    await engine.writeFile(htmlPath, html)

    if (await engine.shouldOpenBrowser()) await openInBrowser(engine.runCommand, htmlPath)

    await engine.writeLast({ label, htmlPath })
    await engine.appendNotice(buildSessionNote(payload, htmlPath), NoticeType.System)
    await engine.appendNotice(buildModelNoteWithUntrustedAnalysis(payload, htmlPath), NoticeType.User)
    engine.toast(`Review ready: ${label}`, 6000)
  } catch (error) {
    const text = `review-changes failed: ${messageOf(error)}`
    engine.toast(text, 8000)
    await engine.appendNotice(text, NoticeType.System).catch(() => undefined)
  } finally {
    await clearRun(engine, runId).catch(() => undefined)
    await refreshCandidate(engine)
  }
}

export async function openInBrowser(runCommand: RunCommand, htmlPath: string): Promise<boolean> {
  try {
    const system = await runCommand(['uname', '-s'])
    const opener = system.stdout.trim() === 'Darwin' ? 'open' : 'xdg-open'

    const opened = await runCommand([opener, htmlPath])

    return opened.exitCode === 0
  } catch {
    return false
  }
}

export async function refreshCandidate(engine: ReviewEngine): Promise<void> {
  try {
    const found = await findReviewCandidate(engine.runCommand, await engine.sessionWorkingDirectory())
    const current = await engine.readCandidate()

    if ((current?.summary ?? null) === (found?.summary ?? null)) return

    await engine.writeCandidate(found)
  } catch {
    return
  }
}

export async function resetRun(engine: ReviewEngine): Promise<void> {
  runIdStartedByThisModuleLife = null
  await engine.updateRun(() => null)
}
