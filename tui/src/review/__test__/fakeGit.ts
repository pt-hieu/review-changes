import type { RunCommand } from '../git.ts'

export type FakeCommit = { sha: string; parent?: string; subject: string; author: string; patch: string }

export type FakePullRequest = {
  title: string
  body: string
  author: string | null
  baseRefName: string
  headRefName: string
  state: string
  commits: { oid: string; messageHeadline: string; authors: { login?: string; name?: string }[] }[]
  diff: string
}

export type FakeRepository = {
  root: string | null
  remoteUrl?: string
  currentBranch: string | null
  detachedSha?: string
  branches: Record<string, string>
  originHead?: string
  commits: FakeCommit[]
  statusEntries: string[]
  trackedPatch: string
  untrackedPatches: Record<string, string>
  isOutputTruncated?: boolean
}

export type FakeGitHub = {
  repositoryName: string
  pullRequests: Record<number, FakePullRequest>
  failure?: string
}

export type FakeEnvironment = {
  repository: FakeRepository
  gitHub?: FakeGitHub
  isMacOs?: boolean
}

type CommandResult = Awaited<ReturnType<RunCommand>>

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

export function createRepository(overrides: Partial<FakeRepository> = {}): FakeRepository {
  return {
    root: '/work/shop',
    currentBranch: 'main',
    branches: {},
    commits: [],
    statusEntries: [],
    trackedPatch: '',
    untrackedPatches: {},
    ...overrides,
  }
}

function succeed(stdout: string, isStdoutTruncated = false): CommandResult {
  return { exitCode: 0, stdout, stderr: '', isStdoutTruncated }
}

function fail(stderr: string, exitCode = 1): CommandResult {
  return { exitCode, stdout: '', stderr, isStdoutTruncated: false }
}

function positionalArguments(commandArguments: readonly string[]): string[] {
  return commandArguments.filter(argument => !argument.startsWith('-') && !argument.includes('%'))
}

function ancestorsOf(repository: FakeRepository, sha: string): string[] {
  const chain: string[] = []

  for (let current: string | undefined = sha; current !== undefined;) {
    chain.push(current)
    current = repository.commits.find(commit => commit.sha === current)?.parent
  }

  return chain
}

function headSha(repository: FakeRepository): string | undefined {
  return repository.currentBranch === null ? repository.detachedSha : repository.branches[repository.currentBranch]
}

function resolve(repository: FakeRepository, revisionText: string): string | undefined {
  const revision = revisionText.replace(/\^\{commit\}$/, '')
  const parentMatch = /^(.*?)(\^1|\^|~(\d+))$/.exec(revision)
  if (parentMatch) {
    const steps = parentMatch[3] === undefined ? 1 : Number(parentMatch[3])
    const chain = ancestorsOf(repository, resolve(repository, parentMatch[1]!) ?? '')

    return chain[steps]
  }

  const name = revision
  if (name === 'HEAD') return headSha(repository)
  if (repository.branches[name] !== undefined) return repository.branches[name]

  return repository.commits.find(commit => commit.sha === name || commit.sha.startsWith(name))?.sha
}

function commitsBetween(repository: FakeRepository, from: string, to: string): FakeCommit[] {
  const excluded = new Set(ancestorsOf(repository, from))

  return ancestorsOf(repository, to)
    .filter(sha => !excluded.has(sha))
    .reverse()
    .map(sha => repository.commits.find(commit => commit.sha === sha)!)
}

function mergeBase(repository: FakeRepository, left: string, right: string): string | undefined {
  const leftAncestors = new Set(ancestorsOf(repository, left))

  return ancestorsOf(repository, right).find(sha => leftAncestors.has(sha))
}

function runDiff(repository: FakeRepository, commandArguments: readonly string[]): CommandResult {
  const isOutputTruncated = repository.isOutputTruncated === true

  if (commandArguments.includes('--no-index')) {
    const path = commandArguments.at(-1)!

    return { ...succeed(repository.untrackedPatches[path] ?? '', isOutputTruncated), exitCode: 1 }
  }

  const revisions = positionalArguments(commandArguments.slice(commandArguments.indexOf('diff') + 1))

  if (revisions.length === 1 && /\.\.\.?/.test(revisions[0]!)) {
    const [baseText = '', headText = ''] = revisions[0]!.split(/\.\.\.?/)
    const base = resolve(repository, baseText)
    const head = resolve(repository, headText)
    if (base === undefined || head === undefined) return fail('bad revision', 128)

    const from = revisions[0]!.includes('...') ? mergeBase(repository, base, head) ?? base : base

    return succeed(commitsBetween(repository, from, head).map(commit => commit.patch).join(''), isOutputTruncated)
  }

  if (revisions.length === 2) {
    const [baseText, headText] = revisions as [string, string]
    const base = baseText === EMPTY_TREE ? '' : resolve(repository, baseText)
    const head = resolve(repository, headText)
    if (base === undefined || head === undefined) return fail('bad revision', 128)

    return succeed(commitsBetween(repository, base, head).map(commit => commit.patch).join(''), isOutputTruncated)
  }

  return succeed(repository.trackedPatch, isOutputTruncated)
}

function runLog(repository: FakeRepository, commandArguments: readonly string[]): CommandResult {
  const format = commandArguments.find(argument => argument.startsWith('--format='))!
  const lastArgument = commandArguments.at(-1)!
  const selected = lastArgument.includes('..')
    ? commitsBetween(repository, resolve(repository, lastArgument.split('..')[0]!) ?? '', resolve(repository, lastArgument.split('..')[1]!) ?? '')
    : [repository.commits.find(commit => commit.sha === resolve(repository, lastArgument))!]
  const recordEnd = format.includes('%x1e') ? '\x1e\n' : '\n'

  return succeed(selected.map(commit => `${commit.sha}\x1f${commit.subject}\x1f${commit.author}${recordEnd}`).join(''))
}

function runGit(repository: FakeRepository, commandArguments: readonly string[]): CommandResult {
  const subcommandIndex = commandArguments.findIndex((argument, index) => index > 0 && !argument.startsWith('-') && commandArguments[index - 1] !== '-c')
  const subcommand = commandArguments[subcommandIndex]
  const rest = commandArguments.slice(subcommandIndex + 1)
  const operands = positionalArguments(rest)

  if (repository.root === null) return fail('fatal: not a git repository', 128)

  switch (subcommand) {
    case 'rev-parse': {
      if (rest.includes('--show-toplevel')) return succeed(`${repository.root}\n`)
      if (rest.includes('--git-common-dir')) return succeed(`${repository.root}/.git\n`)

      const sha = resolve(repository, operands[0] ?? '')

      return sha === undefined ? fail('', 1) : succeed(`${sha}\n`)
    }
    case 'remote':
      return repository.remoteUrl === undefined ? fail('error: No such remote', 2) : succeed(`${repository.remoteUrl}\n`)
    case 'symbolic-ref': {
      if (operands[0] === 'HEAD') return repository.currentBranch === null ? fail('', 1) : succeed(`${repository.currentBranch}\n`)

      return repository.originHead === undefined ? fail('', 1) : succeed(`${repository.originHead}\n`)
    }
    case 'show-ref': {
      const branchName = (operands[0] ?? '').replace(/^refs\/(heads|remotes)\//, '')

      return repository.branches[branchName] === undefined ? fail('', 1) : succeed('')
    }
    case 'status':
      return succeed(repository.statusEntries.map(entry => `${entry}\0`).join(''))
    case 'ls-files':
      return succeed(Object.keys(repository.untrackedPatches).map(path => `${path}\0`).join(''))
    case 'diff':
      return runDiff(repository, commandArguments)
    case 'merge-base': {
      const base = mergeBase(repository, resolve(repository, operands[0] ?? '') ?? '', resolve(repository, operands[1] ?? '') ?? '')

      return base === undefined ? fail('', 1) : succeed(`${base}\n`)
    }
    case 'rev-list': {
      const [baseText = '', headText = ''] = (operands[0] ?? '').split('..')
      const base = resolve(repository, baseText)
      const head = resolve(repository, headText)
      if (base === undefined || head === undefined) return fail('', 128)

      return succeed(`${commitsBetween(repository, base, head).length}\n`)
    }
    case 'log':
      return runLog(repository, commandArguments)
    default:
      return fail(`unsupported git command ${subcommand}`, 1)
  }
}

function runGitHub(gitHub: FakeGitHub | undefined, commandArguments: readonly string[]): CommandResult {
  if (gitHub === undefined || gitHub.failure !== undefined) return fail(gitHub?.failure ?? 'gh: command not found', 4)
  if (commandArguments[1] === 'repo') return succeed(`${gitHub.repositoryName}\n`)

  const pullRequestNumber = Number(commandArguments[3])
  const pullRequest = gitHub.pullRequests[pullRequestNumber]
  if (pullRequest === undefined) return fail(`no pull request found for #${pullRequestNumber}`)

  if (commandArguments[2] === 'diff') return succeed(pullRequest.diff)

  return succeed(JSON.stringify({
    number: pullRequestNumber,
    title: pullRequest.title,
    body: pullRequest.body,
    url: `https://github.com/${gitHub.repositoryName}/pull/${pullRequestNumber}`,
    author: pullRequest.author === null ? null : { login: pullRequest.author },
    baseRefName: pullRequest.baseRefName,
    headRefName: pullRequest.headRefName,
    state: pullRequest.state,
    commits: pullRequest.commits,
  }))
}

export function createFakeRunCommand(environment: FakeEnvironment, openedPaths: string[] = []): RunCommand {
  return async commandArguments => {
    const executable = commandArguments[0]

    if (executable === 'git') return runGit(environment.repository, commandArguments)
    if (executable === 'gh') return runGitHub(environment.gitHub, commandArguments)
    if (executable === 'uname') return succeed(environment.isMacOs === false ? 'Linux\n' : 'Darwin\n')

    if (executable === 'open' || executable === 'xdg-open') {
      openedPaths.push(commandArguments[1] ?? '')
      return succeed('')
    }

    return fail(`unsupported command ${executable}`, 127)
  }
}
