import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { ANALYZER_AGENT } from './analysis.ts'
import {
  currentRunId,
  deliver,
  openInBrowser,
  refreshCandidate,
  resetRun,
  startReview,
  startReviewWithToast,
} from './review.ts'
import type { ReviewEngine } from './review.ts'

const candidate = atom({ plugin: 'review-changes', key: 'candidate' } as const, null)
const run = atom({ plugin: 'review-changes', key: 'run' } as const, null)
const last = atom({ plugin: 'review-changes', key: 'last' } as const, null)
const isHidden = atom({ plugin: 'review-changes', key: 'isHidden' } as const, false)

const CANDIDATE_REFRESH_MILLISECONDS = 20_000

const REVIEW_BUTTON_COLUMNS = 20
const OPEN_LAST_BUTTON_COLUMNS = 22
const HIDE_BUTTON_COLUMNS = 8
const BAND_GAP_COLUMNS = 1

function pluginDirectoryOf(pluginRoot: string): string {
  return pluginRoot.replace(/\/\.claude-plugin\/?$/, '')
}

function reviewEngineOf($: EngineInterface): ReviewEngine {
  return {
    pluginDirectory: pluginDirectoryOf($.plugin.root),
    runCommand: (commandArguments, options) => $.process.run(commandArguments, options),
    shouldOpenBrowser: async () => !(await $.env.get('REVIEW_CHANGES_NO_OPEN')),
    sessionWorkingDirectory: () => $.session.cwd(),
    readSessionMessages: () => $.session.messages(),
    readFile: path => $.fs.read(path),
    writeFile: async (path, text) => {
      await $.fs.write(path, text)
    },
    spawnAnalyzer: request => $.agent.spawn({ subagentType: ANALYZER_AGENT, ...request }),
    now: () => $.clock.now(),
    after: (milliseconds, callback) => $.clock.after(milliseconds, callback),
    toast: (text, timeoutMilliseconds) => $.ui.toast(text, { timeoutMs: timeoutMilliseconds }),
    appendNotice: async (text, type) => {
      await $.session.append({ message: { type, content: [{ type: 'text', text }] } })
    },
    readRun: () => read($, run),
    updateRun: async change => {
      await update($, run, change)
    },
    writeLast: async value => {
      await update($, last, () => value)
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
      description: 'Group the current repo’s changes by concern and open them in a local review page',
      argumentHint: '[#pr | --worktree | rev | A...B | A..B]',
    })

    const engine = reviewEngineOf($)
    await resetRun(engine)
    await refreshCandidate(engine)

    $.clock.every(CANDIDATE_REFRESH_MILLISECONDS, () => void refreshCandidate(engine))

    return next(e)
  })

  on('agent.offer', { agent: 'review-changes:analyzer' }, () => ({ isOffered: false }))

  on('turn.complete', ($, e, next) => {
    if (e.agentId) deliver(e.agentId, { answer: e.answer, reason: e.reason })
    else void refreshCandidate(reviewEngineOf($))

    return next(e)
  })

  on('command.run', { command: 'review-changes' }, async ($, e) => {
    const { text } = await startReview(reviewEngineOf($), e.args)

    return { text }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)

    const runningReview = await read($, run)
    const offer = await read($, candidate)
    const lastReview = await read($, last)

    const isRunning = runningReview !== null && runningReview.runId === currentRunId()

    if (!isRunning && offer === null && lastReview === null) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const buttonWidths = [
      HIDE_BUTTON_COLUMNS,
      ...(lastReview ? [OPEN_LAST_BUTTON_COLUMNS] : []),
      ...(!isRunning && offer ? [REVIEW_BUTTON_COLUMNS] : []),
    ]
    const buttonColumns = buttonWidths.reduce((total, width) => total + width + BAND_GAP_COLUMNS, 0)
    const textColumns = Math.max(0, e.props.bodyColumns - buttonColumns)

    return (
      <Box flexDirection="row" marginTop={1} columnGap={BAND_GAP_COLUMNS}>
        {isRunning ? (
          <Text key="progress" dimColor wrap="truncate">
            {truncate(`Reviewing ${runningReview.label}: ${runningReview.phase}…`, textColumns)}
          </Text>
        ) : offer ? (
          <Text key="summary" dimColor wrap="truncate">
            {truncate(offer.summary, textColumns)}
          </Text>
        ) : null}
        {!isRunning && offer ? (
          <Button
            key="review"
            label="Review changes"
            variant="primary"
            hotkey="r"
            onPress={() => void startReviewWithToast(reviewEngineOf($), '')}
          />
        ) : null}
        {lastReview ? (
          <Button
            key="open-last"
            label="Open last review"
            hotkey="o"
            onPress={() => void openInBrowser(
                (commandArguments, options) => $.process.run(commandArguments, options),
                lastReview.htmlPath,
              )}
          />
        ) : null}
        <Button key="hide" label="Hide" dimColor onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })
}
