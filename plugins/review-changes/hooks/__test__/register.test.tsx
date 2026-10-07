import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { deliver, startReview } from '../review.ts'
import type { AnalyzerAnswer } from '../review.ts'
import { NoticeType, ReviewCategory, ReviewLineSide } from '../types.ts'
import { fakeEngine, REPOSITORY_ROOT, WORKTREE_PATCH } from './fakeEngine.ts'
import { createFakeRunCommand, createRepository } from './fakeGit.ts'
import type { FakeEnvironment } from './fakeGit.ts'

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

const PRESENTATION = { isFullscreen: false, columns: 80 }

function fakeProcesses(on: On, environment: FakeEnvironment) {
  const runCommand = createFakeRunCommand(environment)

  on('process.run', async ($, e) => {
    const result = await runCommand(e.argv)

    return { value: { ...result, isStderrTruncated: false } }
  })
}

function dirtyRepository(statusEntries: string[]) {
  return createRepository({ root: REPOSITORY_ROOT, branches: {}, statusEntries })
}

function fakeSession(on: On, workingDirectory: string) {
  mock.clock(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: workingDirectory }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
}

function drawEngineBand(on: On) {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
}

describe('/review-changes', () => {
  test('answers a bad argument with the usage', async ($, on) => {
    fakeSession(on, '/repo')
    fakeProcesses(on, { repository: createRepository({ root: null }) })
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })

    const { text } = await $.command.run({
      command: 'review-changes',
      args: '-x',
      origin: { kind: 'composer' } as never,
      presentation: PRESENTATION,
    })

    expect(text).toContain('Unknown option "-x".')
    expect(text).toContain('Usage: /review-changes [target]')
  })

  test('says so when the session is not inside a git repository', async ($, on) => {
    fakeSession(on, '/not-a-repo')
    fakeProcesses(on, { repository: createRepository({ root: null }) })
    await $.session.start({ cwd: '/not-a-repo', surface: null, isInteractive: true })

    const { text } = await $.command.run({
      command: 'review-changes',
      args: '',
      origin: { kind: 'composer' } as never,
      presentation: PRESENTATION,
    })

    expect(text).toBe('Not inside a git repository: /not-a-repo')
  })
})

for (const surface of ['terminal', 'desktop'] as const) {
  describe(`the band above the prompt on ${surface}`, () => {
    test('offers a review of uncommitted changes, and hides on request', async ($, on) => {
      fakeSession(on, '/repo')
      drawEngineBand(on)
      fakeProcesses(on, { repository: dirtyRepository([' M src/app.ts', '?? notes.md']) })
      await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
      const ui = await $.ui.mount({ plugin: 'review-changes', surface, component: 'AbovePrompt', props: BAND_PROPS })

      expect(await ui.find({ type: 'Text', text: '2 uncommitted files' })).toBeDefined()
      expect((await ui.find({ key: 'review' }))?.props.label).toBe('Review changes')

      await ui.press({ key: 'hide' })
      expect(await ui.find({ key: 'review' })).toBeUndefined()
      expect(await ui.find({ key: 'hide' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
    })

    test('leaves the band to the engine when there is nothing to review', async ($, on) => {
      fakeSession(on, '/repo')
      drawEngineBand(on)
      fakeProcesses(on, { repository: dirtyRepository([]) })
      await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
      const ui = await $.ui.mount({ plugin: 'review-changes', surface, component: 'AbovePrompt', props: BAND_PROPS })

      expect(await ui.find({ key: 'review' })).toBeUndefined()
      expect(await ui.find({ key: 'hide' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
    })
  })
}

const HTML_PATH = '/repo/.git/review-changes/worktree.html'
const payloadElementStart = '<script type="application/json" id="review-payload">'

function pagePayload(html: string | undefined): Record<string, unknown> {
  const page = html ?? ''
  const start = page.indexOf(payloadElementStart) + payloadElementStart.length
  return JSON.parse(page.slice(start, page.indexOf('</script>', start)))
}

const GROUPED_ANSWER: AnalyzerAnswer = {
  reason: 'answer',
  answer: [
    '```json',
    JSON.stringify({
      overallSummary: 'Listens on every interface.',
      groups: [
        {
          key: 'server',
          label: 'Server',
          category: ReviewCategory.Core,
          summary: 'Binds to all interfaces. Containers need it.',
          filePaths: ['src/app.ts'],
          lineNotes: [{ path: 'src/app.ts', side: ReviewLineSide.Additions, line: 2, text: 'Now reachable from outside.', critical: true }],
        },
      ],
    }),
    '```',
  ].join('\n'),
}

const FALLBACK_GROUPS = [
  {
    key: 'uncategorized',
    label: 'Uncategorized',
    category: ReviewCategory.Other,
    summary: '',
    filePaths: ['src/app.ts'],
    fileNotes: [],
    lineNotes: [],
  },
]

describe('a review run', () => {
  test('writes the page from the analyzer’s answer, opens it and leaves a note', async () => {
    const { engine, world } = fakeEngine({ agentId: 'agent-grouped', model: 'claude-sonnet' })

    const started = await startReview(engine, '--worktree')
    expect(started.text).toContain('Reviewing Uncommitted changes on main')
    expect(started.text).toContain('1 file')
    expect(world.run?.label).toBe('Uncommitted changes on main')
    expect(world.status).toContain('claude-sonnet')

    deliver('agent-grouped', GROUPED_ANSWER)
    await started.completion

    expect(world.written.get('/repo/.git/review-changes/worktree.patch')).toBe(WORKTREE_PATCH)
    expect(pagePayload(world.written.get(HTML_PATH))).toMatchObject({
      generatedAt: '2026-10-07T12:00:00.000Z',
      title: 'Uncommitted changes on main',
      repository: { root: '/repo', name: 'acme/shop' },
      analysisModel: 'claude-sonnet',
      analysis: {
        overallSummary: 'Listens on every interface.',
        groups: [
          {
            key: 'server',
            label: 'Server',
            category: ReviewCategory.Core,
            summary: 'Binds to all interfaces. Containers need it.',
            filePaths: ['src/app.ts'],
            fileNotes: [],
            lineNotes: [{ path: 'src/app.ts', side: ReviewLineSide.Additions, line: 2, text: 'Now reachable from outside.', critical: true }],
          },
        ],
      },
    })
    const [sessionNotice, modelNotice] = world.notices
    expect(world.notices.map(notice => notice.type)).toStrictEqual([NoticeType.System, NoticeType.User])
    expect(sessionNotice?.text).toContain('Uncommitted changes on main')
    expect(sessionNotice?.text).toContain('Listens on every interface.')
    expect(sessionNotice?.text).toContain('- src/app.ts:2 — Now reachable from outside.')
    expect(sessionNotice?.text).toContain(`Page: ${HTML_PATH}`)
    expect(modelNotice?.text).toContain(HTML_PATH)
    expect(modelNotice?.text).toContain(sessionNotice?.text ?? '')
    expect(world.toasts).toStrictEqual(['Review ready: Uncommitted changes on main'])
    expect(world.openedInBrowser).toStrictEqual([HTML_PATH])
    expect(world.last).toStrictEqual({ label: 'Uncommitted changes on main', htmlPath: HTML_PATH })
    expect(world.run).toBe(null)
    expect(world.status).toBeUndefined()
    expect(world.candidate).toStrictEqual({ summary: '1 uncommitted file' })
  })

  test('writes the page without opening a browser when the environment asks for none', async () => {
    const { engine, world } = fakeEngine({ deny: 'denied' }, { shouldOpenBrowser: false })

    await (await startReview(engine, '--worktree')).completion

    expect(world.written.has(HTML_PATH)).toBe(true)
    expect(world.openedInBrowser).toStrictEqual([])
    expect(world.notices[0]?.text).toContain(`Page: ${HTML_PATH}`)
  })

  test('refuses a second run while one is in flight', async () => {
    const { engine } = fakeEngine({ agentId: 'agent-busy', model: 'claude-sonnet' })
    const started = await startReview(engine, '')

    const refusal = (await startReview(engine, '--worktree')).text
    expect(refusal).toContain('already running')
    expect(refusal).toContain('Uncommitted changes on main')

    deliver('agent-busy', GROUPED_ANSWER)
    await started.completion
  })

  test('takes an answer that arrives before the run waits for it', async () => {
    const { engine, world } = fakeEngine({ agentId: 'agent-early', model: 'claude-sonnet' })
    const spawnAnalyzer = engine.spawnAnalyzer
    engine.spawnAnalyzer = async request => {
      const spawned = await spawnAnalyzer(request)
      deliver('agent-early', GROUPED_ANSWER)
      return spawned
    }

    await (await startReview(engine, '--worktree')).completion

    expect(pagePayload(world.written.get(HTML_PATH))).toMatchObject({
      analysis: { overallSummary: 'Listens on every interface.' },
    })
  })

  test('still writes the page, grouped as a fallback, when the analyzer is aborted', async () => {
    const { engine, world } = fakeEngine({ agentId: 'agent-aborted', model: 'claude-sonnet' })
    const started = await startReview(engine, '--worktree')

    deliver('agent-aborted', { answer: '', reason: 'aborted' })
    await started.completion

    expect(pagePayload(world.written.get(HTML_PATH))).toMatchObject({
      analysisError: 'the analyzer ended (aborted)',
      analysis: { groups: FALLBACK_GROUPS },
    })
    expect(world.notices[0]?.text).toContain('Analysis failed: the analyzer ended (aborted)')
    expect(world.toasts).toStrictEqual(['Review ready: Uncommitted changes on main'])
  })

  test('gives up waiting after the timeout and writes the fallback page', async () => {
    const { engine, world } = fakeEngine({ agentId: 'agent-silent', model: 'claude-sonnet' })
    const started = await startReview(engine, '--worktree')

    for (const fire of world.pendingTimers.splice(0)) fire()
    await started.completion

    expect(pagePayload(world.written.get(HTML_PATH))).toMatchObject({
      analysisError: 'the analyzer gave no answer within 15 minutes',
      analysis: { groups: FALLBACK_GROUPS },
    })
  })

  test('writes the fallback page when the spawn is denied', async () => {
    const { engine, world } = fakeEngine({ deny: 'subagents are off in this session' })

    await (await startReview(engine, '--worktree')).completion

    expect(pagePayload(world.written.get(HTML_PATH))).toMatchObject({
      analysisError: 'subagents are off in this session',
      analysis: { groups: FALLBACK_GROUPS },
    })
  })

  test('reports a missing viewer bundle as a failure, writing no page', async () => {
    const { engine, world } = fakeEngine({ deny: 'denied' }, { assets: {} })

    await (await startReview(engine, '--worktree')).completion

    expect(world.written.has(HTML_PATH)).toBe(false)
    expect(world.toasts[0]).toContain('review-changes failed: cannot read the viewer bundle at /plugin/assets/viewer.js')
    expect(world.notices).toStrictEqual([{ type: NoticeType.System, text: world.toasts[0] }])
    expect(world.run).toBe(null)
  })
})
