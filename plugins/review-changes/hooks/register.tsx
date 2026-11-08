import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import {
  ANALYZER_AGENT,
  ANALYZER_FINISHED_NOTIFICATION,
  currentRunId,
  deliver,
  isFromAnalyzer,
  openPane,
  refreshCandidate,
  resetRun,
  startReview,
  startReviewWithToast,
} from './run.ts'
import type { ReviewChangesEngine } from './run.ts'
import { locateRex } from './rex.ts'
import { SessionMessageRole } from './types.ts'

const candidate = atom({ plugin: 'review-changes', key: 'candidate' } as const, null)
const run = atom({ plugin: 'review-changes', key: 'run' } as const, null)
const pane = atom({ plugin: 'review-changes', key: 'pane' } as const, null)
const isHidden = atom({ plugin: 'review-changes', key: 'isHidden' } as const, false)

const CANDIDATE_REFRESH_MILLISECONDS = 20_000

const REVIEW_BUTTON_COLUMNS = 20
const OPEN_PANE_BUTTON_COLUMNS = 16
const HIDE_BUTTON_COLUMNS = 8
const BAND_GAP_COLUMNS = 1
const BAND_BULLET = '◆ '

function pluginDirectoryOf(pluginRoot: string): string {
  return pluginRoot.replace(/\/\.claude-plugin\/?$/, '')
}

async function readRexEnvironment($: EngineInterface) {
  return {
    block: await $.env.get('REX_BLOCK'),
    session: await $.env.get('REX_SESSION'),
    binaryDirectory: await $.env.get('REX_BIN_DIR'),
    home: await $.env.get('HOME'),
  }
}

function reviewEngineOf($: EngineInterface): ReviewChangesEngine {
  return {
    pluginDirectory: pluginDirectoryOf($.plugin.root),
    runCommand: (commandArguments, options) => $.process.run(commandArguments, options),
    readEnvironment: () => readRexEnvironment($),
    sessionWorkingDirectory: () => $.session.cwd(),
    readSessionMessages: async () =>
      (await $.session.messages()).map(message => ({
        role: message.role === 'user' ? SessionMessageRole.User : SessionMessageRole.Assistant,
        text: message.text,
      })),
    spawnAnalyzer: request => $.agent.spawn({ subagentType: ANALYZER_AGENT, ...request }),
    after: (milliseconds, callback) => $.clock.after(milliseconds, callback),
    toast: (text, timeoutMilliseconds) => $.ui.toast(text, { timeoutMs: timeoutMilliseconds }),
    readRun: () => read($, run),
    updateRun: async change => {
      await update($, run, change)
    },
    readPane: () => read($, pane),
    writePane: async value => {
      await update($, pane, () => value)
    },
    readCandidate: () => read($, candidate),
    writeCandidate: async value => {
      await update($, candidate, () => value)
    },
  }
}

function truncate(text: string, columns: number): string {
  if (columns <= 1) return ''

  return text.length <= columns ? text : `${text.slice(0, columns - 1)}…`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'review-changes',
      description: 'Group the current repo’s changes by concern and review them in a terminal pane beside this session',
      argumentHint: '[#pr | --worktree | rev | A...B | A..B]',
    })

    const engine = reviewEngineOf($)
    await resetRun(engine)
    await refreshCandidate(engine)

    $.clock.every(CANDIDATE_REFRESH_MILLISECONDS, () => void refreshCandidate(engine))

    return next(e)
  })

  on('agent.offer', { agent: 'review-changes:analyzer' }, () => ({ isOffered: false }))

  on('session.receive', ($, e, next) => {
    if (e.agentId === undefined && isFromAnalyzer(e.text)) return { consumed: 'review-changes analyzer hand-back' }

    return next(e)
  })

  on('session.append', ($, e, next) => {
    const isMainConversation = e.agentId === undefined
    const text = e.message.content.map(block => (block.type === 'text' ? block.text : '')).join('')

    if (isMainConversation && e.origin.kind === 'peer' && isFromAnalyzer(text)) {
      return next({ ...e, message: { ...e.message, content: [{ type: 'text', text: ANALYZER_FINISHED_NOTIFICATION }] } })
    }

    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId) deliver(e.agentId, { answer: e.answer, reason: e.reason })
    else void refreshCandidate(reviewEngineOf($))

    return next(e)
  })

  on('command.run', { command: 'review-changes' }, async ($, e) => {
    const engine = reviewEngineOf($)
    const { text, userText } = await startReview(engine, e.args)

    if (userText !== undefined) engine.toast(userText, 8000)

    return { text }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)

    const runningReview = await read($, run)
    const offer = await read($, candidate)
    const lastPane = await read($, pane)
    const isInRex = locateRex(await readRexEnvironment($)) !== null
    const isRunning = runningReview !== null && runningReview.runId === currentRunId()

    if (!isRunning && offer === null && lastPane === null) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const otherBands = await next(e)
    const canOpenPane = lastPane !== null && isInRex
    const buttonWidths = [
      HIDE_BUTTON_COLUMNS,
      ...(canOpenPane ? [OPEN_PANE_BUTTON_COLUMNS] : []),
      ...(!isRunning && offer ? [REVIEW_BUTTON_COLUMNS] : []),
    ]
    const buttonColumns = buttonWidths.reduce((total, width) => total + width + BAND_GAP_COLUMNS, 0)
    const textColumns = Math.max(0, e.props.bodyColumns - buttonColumns - BAND_BULLET.length)

    return (
      <Box flexDirection="column">
        {otherBands}
        <Box flexDirection="row" marginTop={1} columnGap={BAND_GAP_COLUMNS}>
          {isRunning ? (
            <Text key="progress" dimColor wrap="truncate">
              {BAND_BULLET + truncate(`Reviewing ${runningReview.label}: ${runningReview.phase}…`, textColumns)}
            </Text>
          ) : offer ? (
            <Text key="summary" dimColor wrap="truncate">
              {BAND_BULLET + truncate(offer.summary, textColumns)}
            </Text>
          ) : null}
          {!isRunning && offer ? (
            <Button
              key="review"
              label={isInRex ? 'Review in pane' : 'Review'}
              variant="primary"
              hotkey="v"
              onPress={() => void startReviewWithToast(reviewEngineOf($), '')}
            />
          ) : null}
          {canOpenPane ? (
            <Button key="open-pane" label="Open pane" hotkey="p" onPress={() => void openPane(reviewEngineOf($))} />
          ) : null}
          <Button key="hide" label="Hide" dimColor onPress={() => update($, isHidden, () => true)} />
        </Box>
      </Box>
    )
  })
}
