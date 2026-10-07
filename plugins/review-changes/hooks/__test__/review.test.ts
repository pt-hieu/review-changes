import { describe, expect, test } from 'claude-code/testing'

import type { RunCommand } from '../git.ts'
import { currentRunId, deliver, openInBrowser, refreshCandidate, resetRun, startReview, startReviewWithToast } from '../review.ts'
import type { AnalyzerAnswer } from '../review.ts'
import { createRepository } from './fakeGit.ts'
import { fakeEngine, REPOSITORY_ROOT, worktreeEnvironment } from './fakeEngine.ts'

enum Platform {
  MacOs = 'Darwin',
  Linux = 'Linux',
}

function platformWithOpeners(platform: Platform, availableOpeners: string[], openedPages: string[]): RunCommand {
  return async commandArguments => {
    const [executable = '', argument = ''] = commandArguments

    if (executable === 'uname') return { exitCode: 0, stdout: `${platform}\n`, stderr: '', isStdoutTruncated: false }

    if (!availableOpeners.includes(executable)) return { exitCode: 127, stdout: '', stderr: 'not found', isStdoutTruncated: false }

    openedPages.push(argument)
    return { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false }
  }
}

async function untilNoRunIsInFlight(): Promise<void> {
  while (currentRunId() !== null) await Promise.resolve()
}

const ABORTED_ANSWER: AnalyzerAnswer = { reason: 'aborted', answer: '' }

describe('openInBrowser', () => {
  test('opens the page with the macOS opener on macOS', async () => {
    const openedPages: string[] = []

    const opened = await openInBrowser(platformWithOpeners(Platform.MacOs, ['open'], openedPages), '/repo/page.html')

    expect(opened).toBe(true)
    expect(openedPages).toEqual(['/repo/page.html'])
  })

  test('opens the page with the desktop opener on Linux', async () => {
    const openedPages: string[] = []

    const opened = await openInBrowser(platformWithOpeners(Platform.Linux, ['xdg-open'], openedPages), '/repo/page.html')

    expect(opened).toBe(true)
    expect(openedPages).toEqual(['/repo/page.html'])
  })

  test('does not reach for the Linux opener on macOS', async () => {
    const openedPages: string[] = []

    const opened = await openInBrowser(platformWithOpeners(Platform.MacOs, ['xdg-open'], openedPages), '/repo/page.html')

    expect(opened).toBe(false)
    expect(openedPages).toEqual([])
  })

  test('reports false when the opener cannot run at all', async () => {
    const failing: RunCommand = async () => {
      throw new Error('spawn failed')
    }

    expect(await openInBrowser(failing, '/repo/page.html')).toBe(false)
  })
})

describe('refreshCandidate', () => {
  test('offers the uncommitted files of the session’s repository', async () => {
    const { engine, world } = fakeEngine({})

    await refreshCandidate(engine)

    expect(world.candidate).toEqual({ summary: '1 uncommitted file' })
  })

  test('withdraws an offer once the repository is clean', async () => {
    const clean = { repository: createRepository({ root: REPOSITORY_ROOT, branches: {}, statusEntries: [] }) }
    const { engine, world } = fakeEngine({}, { environment: clean })
    world.candidate = { summary: '3 uncommitted files' }

    await refreshCandidate(engine)

    expect(world.candidate).toBeNull()
  })

  test('replaces an out-of-date offer', async () => {
    const { engine, world } = fakeEngine({}, { environment: worktreeEnvironment() })
    world.candidate = { summary: '9 uncommitted files' }

    await refreshCandidate(engine)

    expect(world.candidate).toEqual({ summary: '1 uncommitted file' })
  })

  test('leaves the offer alone when the session’s directory cannot be read', async () => {
    const { engine, world } = fakeEngine({})
    world.candidate = { summary: '3 uncommitted files' }
    engine.sessionWorkingDirectory = async () => {
      throw new Error('session gone')
    }

    await refreshCandidate(engine)

    expect(world.candidate).toEqual({ summary: '3 uncommitted files' })
  })
})

describe('a run in flight', () => {
  test('is known while the analyzer works and forgotten once the page is written', async () => {
    const { engine } = fakeEngine({ agentId: 'agent-flight', model: 'claude-sonnet' })
    expect(currentRunId()).toBeNull()

    const started = await startReview(engine, '--worktree')
    expect(currentRunId()).not.toBeNull()

    deliver('agent-flight', ABORTED_ANSWER)
    await started.completion

    expect(currentRunId()).toBeNull()
  })

  test('is dropped by a reset, which lets a new review start', async () => {
    const stuck = fakeEngine({ agentId: 'agent-stuck', model: 'claude-sonnet' })
    await startReview(stuck.engine, '--worktree')
    expect(currentRunId()).not.toBeNull()

    await resetRun(stuck.engine)

    expect(currentRunId()).toBeNull()
    expect(stuck.world.run).toBeNull()

    const next = fakeEngine({ deny: 'denied' })
    const restarted = await startReview(next.engine, '--worktree')
    expect(restarted.text).toContain('Reviewing')
    await restarted.completion
  })
})

describe('deliver', () => {
  test('ignores an answer that arrives while no review runs', async () => {
    deliver('agent-orphan', { reason: 'answer', answer: '```json\n{"overallSummary":"Stale","groups":[]}\n```' })

    const { engine, world } = fakeEngine({ agentId: 'agent-orphan', model: 'claude-sonnet' })
    const started = await startReview(engine, '--worktree')
    for (const fire of world.pendingTimers.splice(0)) fire()
    await started.completion

    expect(world.notices[0]?.text).toContain('Analysis failed')
    expect(world.notices[0]?.text).not.toContain('Stale')
  })
})

describe('startReviewWithToast', () => {
  test('announces the review it started', async () => {
    const { engine, world } = fakeEngine({ deny: 'denied' })

    await startReviewWithToast(engine, '--worktree')
    await untilNoRunIsInFlight()

    expect(world.toasts[0]).toContain('Reviewing Uncommitted changes on main')
  })

  test('answers a bad argument with the usage', async () => {
    const { engine, world } = fakeEngine({ deny: 'denied' })

    await startReviewWithToast(engine, '-x')

    expect(world.toasts).toHaveLength(1)
    expect(world.toasts[0]).toContain('Unknown option "-x".')
    expect(world.toasts[0]).toContain('Usage: /review-changes')
  })

  test('reports an unexpected failure instead of throwing', async () => {
    const { engine, world } = fakeEngine({ deny: 'denied' })
    engine.updateRun = async () => {
      throw new Error('state store offline')
    }

    await startReviewWithToast(engine, '--worktree')

    expect(world.toasts).toEqual(['review-changes failed: state store offline'])
  })

  test('lets the next review start after a failure before the analyzer answers', async () => {
    const failing = fakeEngine({ deny: 'denied' })
    failing.engine.updateRun = async () => {
      throw new Error('state store offline')
    }
    await startReviewWithToast(failing.engine, '--worktree')

    const next = fakeEngine({ deny: 'denied' })
    const restarted = await startReview(next.engine, '--worktree')

    expect(currentRunId()).not.toBeNull()
    expect(restarted.text).toContain('Reviewing')
    await restarted.completion
    expect(currentRunId()).toBeNull()
  })
})
