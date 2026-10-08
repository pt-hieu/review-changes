import { NoticeType } from '../types.ts'
import type { SessionMessageText } from '../analysis.ts'
import type { ReviewEngine } from '../review.ts'
import { createFakeRunCommand, createRepository } from './fakeGit.ts'
import type { FakeEnvironment } from './fakeGit.ts'

export const REPOSITORY_ROOT = '/repo'

export const WORKTREE_PATCH = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,2 +1,2 @@',
  ' const port = 3000',
  '-listen(port)',
  '+listen(port, "0.0.0.0")',
  '',
].join('\n')

export function worktreeEnvironment(): FakeEnvironment {
  return {
    repository: createRepository({
      root: REPOSITORY_ROOT,
      remoteUrl: 'https://github.com/acme/shop.git',
      branches: { main: 'a'.repeat(40) },
      commits: [{ sha: 'a'.repeat(40), subject: 'Start', author: 'Ada Lovelace', patch: '' }],
      statusEntries: [' M src/app.ts'],
      trackedPatch: WORKTREE_PATCH,
    }),
  }
}

export const VIEWER_ASSETS: Record<string, string> = {
  '/plugin/assets/viewer.js': 'console.log("viewer")',
  '/plugin/assets/viewer.css': 'body {}',
}

export function fakeEngine(
  spawned: Awaited<ReturnType<ReviewEngine['spawnAnalyzer']>>,
  {
    assets = VIEWER_ASSETS,
    shouldOpenBrowser = true,
    environment = worktreeEnvironment(),
    sessionMessages = [],
  }: { assets?: Record<string, string>; shouldOpenBrowser?: boolean; environment?: FakeEnvironment; sessionMessages?: SessionMessageText[] } = {},
) {
  const world = {
    written: new Map<string, string>(),
    openedInBrowser: [] as string[],
    notices: [] as Array<{ type: NoticeType; text: string }>,
    toasts: [] as string[],
    run: null as Awaited<ReturnType<ReviewEngine['readRun']>>,
    last: null as Parameters<ReviewEngine['writeLast']>[0] | null,
    candidate: null as Awaited<ReturnType<ReviewEngine['readCandidate']>>,
    pendingTimers: [] as Array<() => void>,
    analyzerPrompts: [] as string[],
  }
  const engine: ReviewEngine = {
    pluginDirectory: '/plugin',
    runCommand: createFakeRunCommand(environment, world.openedInBrowser),
    shouldOpenBrowser: async () => shouldOpenBrowser,
    sessionWorkingDirectory: async () => '/repo',
    readSessionMessages: async () => sessionMessages,
    readFile: async path => {
      const text = assets[path]
      if (text === undefined) throw new Error('ENOENT')
      return text
    },
    writeFile: async (path, text) => {
      world.written.set(path, text)
    },
    spawnAnalyzer: async request => {
      world.analyzerPrompts.push(request.prompt)
      return spawned
    },
    now: async () => Date.UTC(2026, 9, 7, 12),
    after: (milliseconds, callback) => {
      world.pendingTimers.push(callback)
      return { cancel: () => world.pendingTimers.splice(world.pendingTimers.indexOf(callback), 1) }
    },
    toast: text => {
      world.toasts.push(text)
    },
    appendNotice: async (text, type) => {
      world.notices.push({ type, text })
    },
    readRun: async () => world.run,
    updateRun: async change => {
      world.run = change(world.run)
    },
    writeLast: async value => {
      world.last = value
    },
    readCandidate: async () => world.candidate,
    writeCandidate: async value => {
      world.candidate = value
    },
  }
  return { engine, world }
}
