import { describe, expect, test } from 'claude-code/testing'

import { BUN_MISSING_MESSAGE } from '../bun.ts'
import { deliver, startReview } from '../run.ts'
import { SessionMessageRole } from '../types.ts'
import { APP_PATH, BUN_PATH, COLLECTED, EXPECTED_SPLIT, IN_REX, OUTSIDE_REX, REVIEW_DIRECTORY, createWorld } from './fakeWorld.ts'

const INGEST = `${BUN_PATH} --no-env-file ${APP_PATH} ingest ${REVIEW_DIRECTORY} --review-id review-1`
const CLOSE = '/rex/bin/rex block close block-9 -s session-1'
const FOCUS = '/rex/bin/rex block focus block-9 -s session-1'
const INSPECT_ALIVE = { '/rex/bin/rex block inspect block-9 -s session-1': { exitCode: 0 } }
const OPEN_PANE = { reviewDirectory: REVIEW_DIRECTORY, repositoryRoot: '/repo', label: COLLECTED.label, blockId: 'block-9' }
const ANALYSIS_NOTE = 'The analysis runs in the background; the pane picks it up when it lands.'

function commandLineToRun(directory = REVIEW_DIRECTORY): string {
  return `'${BUN_PATH}' --no-env-file '${APP_PATH}' open '${directory}'`
}

describe('/review-changes in a Rex session', () => {
  test('opens the pane beside the session and starts the analysis without waiting for it', async () => {
    const { engine, world } = createWorld({ environment: IN_REX })

    const started = await startReview(engine, '#12')

    expect(world.commands).toContainEqual(EXPECTED_SPLIT)
    expect(world.pane).toStrictEqual({ reviewDirectory: REVIEW_DIRECTORY, repositoryRoot: '/repo', label: COLLECTED.label, blockId: 'block-2' })
    expect(world.prompts).toStrictEqual(['the analyzer prompt'])
    expect(world.run?.phase).toBe('analyzing')
    expect(started.text).toBe(`Opened the review pane for pull request #12: 4200 files, +91000/−3000. ${ANALYSIS_NOTE}`)

    deliver('agent-1', { answer: '```json\n{"groups":[]}\n```', reason: 'answer' })
    await started.completion

    expect(world.stdinOf.get(INGEST)).toBe('```json\n{"groups":[]}\n```')
    expect(world.toasts).toStrictEqual(['Analysis landed for #12 evil-branch → main'])
    expect(world.run).toBe(null)
  })

  test('sends the target and only the user messages to collect, never as an argument', async () => {
    const { engine, world } = createWorld({ environment: IN_REX })

    const started = await startReview(engine, ' -x --worktree ')
    deliver('agent-1', { answer: '{}', reason: 'answer' })
    await started.completion

    const collectKey = `${BUN_PATH} --no-env-file ${APP_PATH} collect --cwd /repo`
    expect(JSON.parse(world.stdinOf.get(collectKey) ?? '')).toStrictEqual({
      target: '-x --worktree',
      messages: [{ role: SessionMessageRole.User, text: 'please review the search work' }],
    })
    expect(world.commands.flat().some(argument => argument.includes('--worktree'))).toBe(false)
  })

  test('runs bun from the plugin directory so the repository under review cannot configure it', async () => {
    const { engine, world } = createWorld({ environment: IN_REX })

    const started = await startReview(engine, '')
    deliver('agent-1', { answer: '{}', reason: 'answer' })
    await started.completion

    expect(world.bunWorkingDirectories.length).toBeGreaterThan(3)
    expect(world.bunWorkingDirectories.every(directory => directory === '/plugin')).toBe(true)
  })

  test('keeps text from the pull request out of what the model reads', async () => {
    const { engine } = createWorld({ environment: IN_REX })

    const started = await startReview(engine, '#12')
    deliver('agent-1', { answer: '{}', reason: 'answer' })
    await started.completion

    expect(started.text).not.toContain('evil-branch')
  })

  test('records a failed analysis when the analyzer is aborted', async () => {
    const { engine, world } = createWorld({ environment: IN_REX })

    const started = await startReview(engine, '')
    deliver('agent-1', { answer: '', reason: 'aborted' })
    await started.completion

    expect(world.commands).toContainEqual([...INGEST.split(' '), '--failed', 'the analyzer ended (aborted)'])
    expect(world.run).toBe(null)
  })

  test('records a failed analysis when the analyzer gives no answer in time', async () => {
    const { engine, world } = createWorld({ environment: IN_REX })

    const started = await startReview(engine, '')
    for (const fire of world.timers.splice(0)) fire()
    await started.completion

    expect(world.commands).toContainEqual([...INGEST.split(' '), '--failed', 'the analyzer gave no answer within 15 minutes'])
  })

  test('refuses a second run while one is in flight', async () => {
    const { engine } = createWorld({ environment: IN_REX })
    const started = await startReview(engine, '')

    const second = await startReview(engine, '')

    expect(second.text).not.toContain('evil-branch')
    expect(second.userText).toBe('A review is already running: #12 evil-branch → main.')

    deliver('agent-1', { answer: '{}', reason: 'answer' })
    await started.completion
  })

  test('focuses the pane that is already open for an unchanged, analysed review', async () => {
    const current = { ...COLLECTED, isAnalysisCurrent: true }
    const { engine, world } = createWorld({ environment: IN_REX, collected: current, replies: { ...INSPECT_ALIVE, [FOCUS]: { exitCode: 0 } } })
    world.pane = OPEN_PANE

    const started = await startReview(engine, '')

    expect(world.commands).toContainEqual(FOCUS.split(' '))
    expect(world.commands).not.toContainEqual(EXPECTED_SPLIT)
    expect(world.prompts).toStrictEqual([])
    expect(started.completion).toBeUndefined()
    expect(started.text).toBe('The review pane for pull request #12: 4200 files, +91000/−3000 is already open and up to date; it has focus.')
    expect(world.run).toBe(null)
  })

  test('replaces the open pane when the review changed', async () => {
    const { engine, world } = createWorld({ environment: IN_REX, replies: { ...INSPECT_ALIVE, [CLOSE]: { exitCode: 0 } } })
    world.pane = OPEN_PANE

    const started = await startReview(engine, '')
    deliver('agent-1', { answer: '{}', reason: 'answer' })
    await started.completion

    const closedAt = world.commands.findIndex(command => command.join(' ') === CLOSE)
    const splitAt = world.commands.findIndex(command => command.join(' ') === EXPECTED_SPLIT.join(' '))
    expect(closedAt).toBeGreaterThanOrEqual(0)
    expect(splitAt).toBeGreaterThan(closedAt)
  })

  test('hands over the command to run when the split fails, as for a stale block', async () => {
    const { engine, world } = createWorld({
      environment: IN_REX,
      replies: { [EXPECTED_SPLIT.join(' ')]: { exitCode: 3, stderr: 'block block-1 not found\u001b]0;pwned\u0007\n' } },
    })

    const started = await startReview(engine, '')
    deliver('agent-1', { answer: '{}', reason: 'answer' })
    await started.completion

    expect(started.text).toBe(
      `Review of pull request #12: 4200 files, +91000/−3000 is ready, but the Rex pane did not open (block block-1 not found ]0;pwned ). To open it, run: ${commandLineToRun()} ${ANALYSIS_NOTE}`,
    )
    expect(world.pane?.blockId).toBe(null)
  })
})

describe('/review-changes outside Rex', () => {
  test('skips the split, still analyses, and gives the command to run elsewhere', async () => {
    const { engine, world } = createWorld({ environment: OUTSIDE_REX })

    const started = await startReview(engine, '')

    expect(world.commands.some(command => command[0]?.endsWith('rex'))).toBe(false)
    expect(started.text).toBe(
      `Review of pull request #12: 4200 files, +91000/−3000 is ready. Not inside Rex, so no pane was opened. To open it, run: ${commandLineToRun()} ${ANALYSIS_NOTE}`,
    )
    expect(world.prompts).toStrictEqual(['the analyzer prompt'])

    deliver('agent-1', { answer: '{}', reason: 'answer' })
    await started.completion
  })

  test('quotes paths that hold spaces and quotes', async () => {
    const { engine } = createWorld({
      environment: OUTSIDE_REX,
      collected: { ...COLLECTED, reviewDirectory: "/repo/it's here/session", isAnalysisCurrent: true },
    })

    const started = await startReview(engine, '')

    expect(started.text).toContain(`open '/repo/it'\\''s here/session'`)
  })
})

describe('/review-changes when it cannot start', () => {
  test('says bun is missing and spawns no analyzer', async () => {
    const { engine, world } = createWorld({ environment: IN_REX, hasBun: false })

    const started = await startReview(engine, '')

    expect(started.text).toBe(BUN_MISSING_MESSAGE)
    expect(world.prompts).toStrictEqual([])
    expect(world.run).toBe(null)
  })

  test('says the bundle is missing', async () => {
    const { engine, world } = createWorld({ environment: IN_REX, hasBundle: false })

    const started = await startReview(engine, '')

    expect(started.text).toBe(`review-changes's app bundle is missing at ${APP_PATH}. Run bun run build:tui in the plugin's repository.`)
    expect(world.run).toBe(null)
  })

  test('relays the collector’s message when there is nothing to review', async () => {
    const { engine, world } = createWorld({ environment: IN_REX, collected: { isCollected: false, message: 'No changes in main vs HEAD.', modelMessage: 'No changes in the requested range.' } })

    const started = await startReview(engine, '')

    expect(started.text).toBe('No changes in the requested range.')
    expect(started.userText).toBe('No changes in main vs HEAD.')
    expect(world.prompts).toStrictEqual([])
    expect(world.run).toBe(null)
  })
})
