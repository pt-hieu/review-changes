import { forgetBunPath } from '../bun.ts'
import { SessionMessageRole } from '../types.ts'
import type { CollectedReview, ReviewChangesEngine, RexEnvironment } from '../run.ts'

type Reply = { exitCode: number; stdout?: string; stderr?: string }

export const BUN_PATH = '/opt/bun/bin/bun'
export const APP_PATH = '/plugin/assets/review-changes.js'
export const REVIEW_DIRECTORY = '/repo/.git/review-changes/sessions/pr-12-1a2b3c4d'

export const COLLECTED: CollectedReview = {
  isCollected: true,
  reviewId: 'review-1',
  reviewDirectory: REVIEW_DIRECTORY,
  repositoryRoot: '/repo',
  label: '#12 evil-branch → main',
  modelLabel: 'pull request #12',
  fileCount: 4200,
  additions: 91000,
  deletions: 3000,
  isAnalysisCurrent: false,
  analyzerPrompt: 'the analyzer prompt',
}

export const IN_REX: RexEnvironment = { block: 'block-1', session: 'session-1', binaryDirectory: '/rex/bin', home: '/home/ada' }
export const OUTSIDE_REX: RexEnvironment = { home: '/home/ada' }

export const EXPECTED_SPLIT = [
  '/rex/bin/rex', 'split', '-s', 'session-1', '-b', 'block-1',
  '--split=right', '--ratio', '70', '--label', 'review-changes',
  '--shell=none', '-c', '/plugin', '--json',
  '--', BUN_PATH, '--no-env-file', APP_PATH, 'open', REVIEW_DIRECTORY,
]

export function createWorld(options: {
  environment: RexEnvironment
  collected?: unknown
  replies?: Record<string, Reply>
  hasBun?: boolean
  hasBundle?: boolean
}) {
  forgetBunPath()

  const world = {
    commands: [] as string[][],
    bunWorkingDirectories: [] as Array<string | undefined>,
    stdinOf: new Map<string, string>(),
    toasts: [] as string[],
    prompts: [] as string[],
    timers: [] as Array<() => void>,
    run: null as Awaited<ReturnType<ReviewChangesEngine['readRun']>>,
    pane: null as Awaited<ReturnType<ReviewChangesEngine['readPane']>>,
    candidate: null as Awaited<ReturnType<ReviewChangesEngine['readCandidate']>>,
  }
  const replies: Record<string, Reply> = {
    'bun --no-env-file -e console.log(process.execPath)': { exitCode: options.hasBun === false ? 127 : 0, stdout: `${BUN_PATH}\n` },
    [`test -f ${APP_PATH}`]: { exitCode: options.hasBundle === false ? 1 : 0 },
    [`${BUN_PATH} --no-env-file ${APP_PATH} collect --cwd /repo`]: { exitCode: 0, stdout: `${JSON.stringify(options.collected ?? COLLECTED)}\n` },
    [`${BUN_PATH} --no-env-file ${APP_PATH} candidate --cwd /repo`]: { exitCode: 0, stdout: 'null\n' },
    '/rex/bin/rex block inspect block-9 -s session-1': { exitCode: 3 },
    [EXPECTED_SPLIT.join(' ')]: { exitCode: 0, stdout: '{"anchor_id":"a","block_ids":["block-2"],"split_ids":["s"],"revision":4}\n' },
    ...options.replies,
  }
  const engine: ReviewChangesEngine = {
    pluginDirectory: '/plugin',
    runCommand: async (argv, init) => {
      world.commands.push([...argv])
      if (argv[0] === BUN_PATH || argv[0] === 'bun') world.bunWorkingDirectories.push(init?.cwd)
      if (init?.stdin !== undefined) world.stdinOf.set(argv.join(' '), init.stdin)

      const reply = replies[argv.join(' ')] ?? (argv[3] === 'ingest' ? { exitCode: 0 } : undefined)

      if (reply === undefined) throw new Error(`no such command: ${argv.join(' ')}`)

      return { exitCode: reply.exitCode, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' }
    },
    readEnvironment: async () => options.environment,
    sessionWorkingDirectory: async () => '/repo',
    readSessionMessages: async () => [
      { role: SessionMessageRole.User, text: 'please review the search work' },
      { role: SessionMessageRole.Assistant, text: 'sure' },
    ],
    spawnAnalyzer: async request => {
      world.prompts.push(request.prompt)

      return { agentId: 'agent-1', model: 'sonnet' }
    },
    after: (_milliseconds, callback) => {
      world.timers.push(callback)

      return { cancel: () => world.timers.splice(world.timers.indexOf(callback), 1) }
    },
    toast: text => {
      world.toasts.push(text)
    },
    readRun: async () => world.run,
    updateRun: async change => {
      world.run = change(world.run)
    },
    readPane: async () => world.pane,
    writePane: async value => {
      world.pane = value
    },
    readCandidate: async () => world.candidate,
    writeCandidate: async value => {
      world.candidate = value
    },
  }

  return { engine, world }
}
