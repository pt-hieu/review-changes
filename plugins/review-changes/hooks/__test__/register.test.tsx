import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { forgetBunPath } from '../bun.ts'
import { BUN_PATH, COLLECTED, EXPECTED_SPLIT } from './fakeWorld.ts'

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

const PRESENTATION = { isFullscreen: false, columns: 80 }
const REX_ENVIRONMENT: Record<string, string> = { REX_BLOCK: 'block-1', REX_SESSION: 'session-1', REX_BIN_DIR: '/rex/bin', HOME: '/home/ada' }

type Reply = { exitCode: number; stdout?: string }

const APP = 'APP'
const SPLIT = EXPECTED_SPLIT.map(argument => (argument.endsWith('review-changes.js') ? APP : argument)).join(' ')

function normalized(argv: readonly string[]): string {
  const appArgument = argv.find(argument => argument.endsWith('/assets/review-changes.js'))
  const pluginDirectory = appArgument?.slice(0, -'/assets/review-changes.js'.length)

  return argv.map(argument => (argument === appArgument ? APP : argument === pluginDirectory ? '/plugin' : argument)).join(' ')
}

function fakeSession(on: On) {
  mock.clock(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
}

function fakeEnvironment(on: On, values: Record<string, string>) {
  on('env.get', (_$, e) => ({ value: values[e.name] }))
}

function fakeProcesses(on: On, replies: Record<string, Reply>, commands: string[][] = []) {
  forgetBunPath()

  const known: Record<string, Reply> = {
    'bun --no-env-file -e console.log(process.execPath)': { exitCode: 0, stdout: `${BUN_PATH}\n` },
    [`${BUN_PATH} --no-env-file ${APP} candidate --cwd /repo`]: { exitCode: 0, stdout: '{"summary":"2 uncommitted files"}\n' },
    ...replies,
  }

  on('process.run', (_$, e) => {
    commands.push([...e.argv])

    const reply = known[normalized(e.argv)]

    if (reply === undefined) return { value: { exitCode: 127, stdout: '', stderr: 'unknown', isStdoutTruncated: false, isStderrTruncated: false } }

    return { value: { exitCode: reply.exitCode, stdout: reply.stdout ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

function drawEngineBand(on: On) {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine band</Text>
  })
}

describe('/review-changes', () => {
  test('opens the split pane through rex and answers with counts only', async ($, on) => {
    const commands: string[][] = []
    fakeSession(on)
    fakeEnvironment(on, REX_ENVIRONMENT)
    fakeProcesses(
      on,
      {
        [`test -f ${APP}`]: { exitCode: 0 },
        [`${BUN_PATH} --no-env-file ${APP} collect --cwd /repo`]: { exitCode: 0, stdout: `${JSON.stringify({ ...COLLECTED, isAnalysisCurrent: true })}\n` },
        [SPLIT]: { exitCode: 0, stdout: '{"block_ids":["block-2"]}\n' },
      },
      commands,
    )
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })

    const { text } = await $.command.run({ command: 'review-changes', args: '#12', origin: { kind: 'composer' } as never, presentation: PRESENTATION })

    expect(text).toContain('Opened the review pane for pull request #12: 4200 files')
    expect(text).not.toContain('evil-branch')
  })

  test('answers a missing bun without collecting anything', async ($, on) => {
    fakeSession(on)
    fakeEnvironment(on, REX_ENVIRONMENT)
    fakeProcesses(on, { 'bun --no-env-file -e console.log(process.execPath)': { exitCode: 127 } })
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })

    const { text } = await $.command.run({ command: 'review-changes', args: '', origin: { kind: 'composer' } as never, presentation: PRESENTATION })

    expect(text).toContain('review-changes needs bun')
  })
})

for (const surface of ['terminal', 'desktop'] as const) {
  describe(`the band above the prompt on ${surface}`, () => {
    test('offers a pane review beside the other plugins’ bands in Rex, and hides on request', async ($, on) => {
      fakeSession(on)
      drawEngineBand(on)
      fakeEnvironment(on, REX_ENVIRONMENT)
      fakeProcesses(on, {})
      await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
      const ui = await $.ui.mount({ plugin: 'review-changes', surface, component: 'AbovePrompt', props: BAND_PROPS })

      expect(await ui.find({ type: 'Text', text: '2 uncommitted files' })).toBeDefined()
      expect((await ui.find({ key: 'review' }))?.props.label).toBe('Review in pane')
      expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()

      await ui.press({ key: 'hide' })
      expect(await ui.find({ key: 'review' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
    })

    test('labels the button plainly outside Rex and offers no pane to open', async ($, on) => {
      fakeSession(on)
      drawEngineBand(on)
      fakeEnvironment(on, { HOME: '/home/ada' })
      fakeProcesses(on, {})
      await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
      const ui = await $.ui.mount({ plugin: 'review-changes', surface, component: 'AbovePrompt', props: BAND_PROPS })

      expect((await ui.find({ key: 'review' }))?.props.label).toBe('Review')
      expect(await ui.find({ key: 'open-pane' })).toBeUndefined()
    })

    test('leaves the band to the engine when there is nothing to review', async ($, on) => {
      fakeSession(on)
      drawEngineBand(on)
      fakeEnvironment(on, REX_ENVIRONMENT)
      fakeProcesses(on, { [`${BUN_PATH} --no-env-file ${APP} candidate --cwd /repo`]: { exitCode: 0, stdout: 'null\n' } })
      await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
      const ui = await $.ui.mount({ plugin: 'review-changes', surface, component: 'AbovePrompt', props: BAND_PROPS })

      expect(await ui.find({ key: 'review' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
    })
  })
}
