import { describe, expect, test } from 'bun:test'

import {
  buildAnalyzerPrompt,
  INLINE_DIFF_CHARACTER_LIMIT,
  isGeneratedPath,
  MAXIMUM_VISUAL_LINES,
  extractJsonText,
  normalizeAnalysis,
  selectUserRequests,
  SINGLE_USER_REQUEST_CHARACTER_LIMIT,
  USER_REQUESTS_TOTAL_CHARACTER_LIMIT,
} from '../analysis.ts'
import type { ReviewSource } from '../git.ts'
import type { ReviewFile } from '../payload.ts'
import { ReviewCategory, ReviewFileStatus, ReviewLineSide, ReviewTargetKind, ReviewVisualChange } from '../types.ts'

const appPatch = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -10,4 +10,6 @@ function start',
  ' const port = 3000',
  '-listen(port)',
  '+const host = "0.0.0.0"',
  '+listen(port, host)',
  '+log("started")',
  ' export {}',
  '',
].join('\n')

const lockPatch = [
  'diff --git a/bun.lock b/bun.lock',
  '--- a/bun.lock',
  '+++ b/bun.lock',
  '@@ -1,1 +1,1 @@',
  '-"left-pad": "1.0.0"',
  '+"left-pad": "1.3.0"',
  '',
].join('\n')

const files: ReviewFile[] = [
  {
    path: 'src/app.ts',
    status: ReviewFileStatus.Modified,
    additions: 3,
    deletions: 1,
    isBinary: false,
    hunks: [{ header: '@@ -10,4 +10,6 @@ function start', oldStart: 10, oldLines: 4, newStart: 10, newLines: 6 }],
    patch: appPatch,
    patchHash: 'hash-app',
    isPatchOmitted: false,
  },
  {
    path: 'src/app.test.ts',
    status: ReviewFileStatus.Added,
    additions: 8,
    deletions: 0,
    isBinary: false,
    hunks: [{ header: '@@ -0,0 +1,8 @@', oldStart: 0, oldLines: 0, newStart: 1, newLines: 8 }],
    patch: 'diff --git a/src/app.test.ts b/src/app.test.ts\nnew file mode 100644\n',
    patchHash: 'hash-test',
    isPatchOmitted: false,
  },
  {
    path: 'README.md',
    status: ReviewFileStatus.Modified,
    additions: 1,
    deletions: 0,
    isBinary: false,
    hunks: [{ header: '@@ -1,3 +1,4 @@', oldStart: 1, oldLines: 3, newStart: 1, newLines: 4 }],
    patch: 'diff --git a/README.md b/README.md\n',
    patchHash: 'hash-readme',
    isPatchOmitted: false,
  },
  {
    path: 'bun.lock',
    status: ReviewFileStatus.Modified,
    additions: 1,
    deletions: 1,
    isBinary: false,
    hunks: [{ header: '@@ -1,1 +1,1 @@', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }],
    patch: lockPatch,
    patchHash: 'hash-lock',
    isPatchOmitted: false,
  },
]

const source: ReviewSource = {
  repository: { root: '/repo', name: 'acme/shop' },
  gitCommonDirectory: '/repo/.git',
  target: { kind: ReviewTargetKind.Worktree, key: 'worktree', label: 'Uncommitted changes on main', branch: 'main', base: 'HEAD' },
  slug: 'worktree',
  title: 'Uncommitted changes on main',
  commits: [],
  patch: files.map(file => file.patch).join(''),
}

function parseAnalyzerAnswer(answer: string, reviewFiles: ReviewFile[]) {
  const parsed = JSON.parse(extractJsonText(answer) ?? 'null')

  return { analysis: normalizeAnalysis(parsed.overallSummary, parsed.groups, reviewFiles) }
}

describe('normalizeAnalysis', () => {
  test('keeps a valid fenced answer as given', () => {
    const answer = [
      'I read the server entry point.',
      '```json',
      JSON.stringify({
        overallSummary: 'Lets the server listen on every interface.',
        groups: [
          {
            key: 'server-host',
            label: 'Server host',
            category: ReviewCategory.Core,
            summary: 'Binds to all interfaces so containers can reach it.',
            filePaths: ['src/app.ts', 'src/app.test.ts'],
            fileNotes: [{ path: 'src/app.test.ts', text: 'Covers the new host argument.' }],
            lineNotes: [{ path: 'src/app.ts', side: ReviewLineSide.Additions, line: 11, text: 'Exposes the port publicly.', critical: true }],
            critical: true,
          },
          {
            key: 'docs-and-deps',
            label: 'Docs and deps',
            category: ReviewCategory.Docs,
            summary: 'Mentions the host and bumps left-pad.',
            filePaths: ['README.md', 'bun.lock'],
          },
        ],
      }),
      '```',
    ].join('\n')

    expect(parseAnalyzerAnswer(answer, files)).toStrictEqual({
      analysis: {
        overallSummary: 'Lets the server listen on every interface.',
        groups: [
          {
            key: 'server-host',
            label: 'Server host',
            category: ReviewCategory.Core,
            summary: 'Binds to all interfaces so containers can reach it.',
            filePaths: ['src/app.ts', 'src/app.test.ts'],
            fileNotes: [{ path: 'src/app.test.ts', text: 'Covers the new host argument.' }],
            lineNotes: [{ path: 'src/app.ts', side: ReviewLineSide.Additions, line: 11, text: 'Exposes the port publicly.', critical: true }],
            critical: true,
          },
          {
            key: 'docs-and-deps',
            label: 'Docs and deps',
            category: ReviewCategory.Docs,
            summary: 'Mentions the host and bumps left-pad.',
            filePaths: ['README.md', 'bun.lock'],
            fileNotes: [],
            lineNotes: [],
          },
        ],
      },
    })
  })

  test('repairs paths, keys, categories and notes so every file lands in exactly one group', () => {
    const answer = JSON.stringify({
      overallSummary: 42,
      groups: [
        {
          key: 'Core Logic',
          label: 'Core',
          category: 'business',
          summary: 'Host binding.',
          filePaths: ['src/app.ts', 'src/missing.ts'],
          lineNotes: [
            { path: 'src/app.ts', side: ReviewLineSide.Additions, line: 40, text: 'Far from any hunk.' },
            { path: 'README.md', side: ReviewLineSide.Additions, line: 2, text: 'Documents the host.' },
            { path: 'src/app.ts', side: ReviewLineSide.Deletions, line: 11, text: '' },
          ],
        },
        {
          key: 'core-logic',
          label: 'Readme',
          category: ReviewCategory.Docs,
          filePaths: ['README.md', 'src/app.ts'],
          fileNotes: [{ path: 'src/missing.ts', text: 'Not in the diff.' }],
          critical: 'yes',
        },
        { key: 'empty', label: 'Empty', category: ReviewCategory.Other, summary: '', filePaths: ['src/missing.ts'] },
      ],
    })

    expect(parseAnalyzerAnswer(`Here it is: ${answer} Done.`, files)).toStrictEqual({
      analysis: {
        overallSummary: '',
        groups: [
          {
            key: 'core-logic',
            label: 'Core',
            category: ReviewCategory.Other,
            summary: 'Host binding.',
            filePaths: ['src/app.ts'],
            fileNotes: [{ path: 'src/app.ts', text: '(line 40) Far from any hunk.' }],
            lineNotes: [],
          },
          {
            key: 'core-logic-2',
            label: 'Readme',
            category: ReviewCategory.Docs,
            summary: '',
            filePaths: ['README.md'],
            fileNotes: [],
            lineNotes: [{ path: 'README.md', side: ReviewLineSide.Additions, line: 2, text: 'Documents the host.' }],
          },
          {
            key: 'uncategorized',
            label: 'Uncategorized',
            category: ReviewCategory.Other,
            summary: '',
            filePaths: ['src/app.test.ts', 'bun.lock'],
            fileNotes: [],
            lineNotes: [],
          },
        ],
      },
    })
  })

  test('reads a group’s picture into depth, change and a link to the code', () => {
    const answer = JSON.stringify({
      overallSummary: '',
      groups: [
        {
          key: 'server-host',
          label: 'Server host',
          category: ReviewCategory.Core,
          summary: '',
          filePaths: ['src/app.ts', 'src/app.test.ts', 'README.md', 'bun.lock'],
          visual: {
            caption: '  Where the host goes  ',
            lines: [
              ' start (src/app.ts)',
              '-    listen(port) (src/app.ts:11)',
              '+    listen(port, host) (src/app.ts:12)',
              '+        log("started") (src/app.ts:14)',
              '     documented (README.md)',
            ],
          },
        },
      ],
    })

    expect(parseAnalyzerAnswer(answer, files).analysis.groups[0]?.visual).toStrictEqual({
      caption: 'Where the host goes',
      lines: [
        { text: 'start', depth: 0, change: ReviewVisualChange.Unchanged, anchor: { path: 'src/app.ts' } },
        {
          text: 'listen(port)',
          depth: 1,
          change: ReviewVisualChange.Removed,
          anchor: { path: 'src/app.ts', side: ReviewLineSide.Deletions, line: 11 },
        },
        {
          text: 'listen(port, host)',
          depth: 1,
          change: ReviewVisualChange.Added,
          anchor: { path: 'src/app.ts', side: ReviewLineSide.Additions, line: 12 },
        },
        {
          text: 'log("started")',
          depth: 2,
          change: ReviewVisualChange.Added,
          anchor: { path: 'src/app.ts', side: ReviewLineSide.Additions, line: 14 },
        },
        { text: 'documented', depth: 1, change: ReviewVisualChange.Unchanged, anchor: { path: 'README.md' } },
      ],
    })
  })

  test('degrades a picture’s bad lines instead of dropping the picture', () => {
    const answer = JSON.stringify({
      overallSummary: '',
      groups: [
        {
          key: 'server-host',
          label: 'Server host',
          category: ReviewCategory.Core,
          summary: '',
          filePaths: ['src/app.ts', 'src/app.test.ts', 'README.md', 'bun.lock'],
          visual: {
            lines: [
              '+ outside every hunk (src/app.ts:99)',
              42,
              '   ',
              '+ unknown file (src/missing.ts:3)',
              '+ listen(port)',
            ],
          },
        },
      ],
    })

    expect(parseAnalyzerAnswer(answer, files).analysis.groups[0]?.visual).toStrictEqual({
      caption: '',
      lines: [
        { text: 'outside every hunk', depth: 0, change: ReviewVisualChange.Added, anchor: { path: 'src/app.ts' } },
        { text: 'unknown file (src/missing.ts:3)', depth: 0, change: ReviewVisualChange.Added },
        { text: 'listen(port)', depth: 0, change: ReviewVisualChange.Added },
      ],
    })
  })

  test('keeps at most the line limit of a picture, and no picture without lines', () => {
    const manyLines = Array.from({ length: MAXIMUM_VISUAL_LINES + 5 }, (_, index) => `+ step ${index}`)
    const answer = JSON.stringify({
      overallSummary: '',
      groups: [
        { key: 'long', label: 'Long', category: ReviewCategory.Core, summary: '', filePaths: ['src/app.ts'], visual: { lines: manyLines } },
        { key: 'empty', label: 'Empty', category: ReviewCategory.Docs, summary: '', filePaths: ['README.md'], visual: { lines: ['  ', 7] } },
      ],
    })

    const [longGroup, emptyGroup] = parseAnalyzerAnswer(answer, files).analysis.groups

    expect(longGroup?.visual?.lines).toHaveLength(40)
    expect(longGroup?.visual?.lines.at(-1)?.text).toBe('step 39')
    expect(emptyGroup).not.toHaveProperty('visual')
  })
})

describe('buildAnalyzerPrompt', () => {
  const patchPath = '/repo/.git/review-changes/worktree.patch'

  test('lists the user’s requests in order, and no request section without any', () => {
    const withRequests = buildAnalyzerPrompt(source, files, patchPath, ['Bind to every interface.', 'Also log on start.'])
    const withoutRequests = buildAnalyzerPrompt(source, files, patchPath, [])

    expect(withRequests).toContain('---USER REQUESTS--- (2, oldest first)\n[1]\nBind to every interface.\n\n[2]\nAlso log on start.')
    expect(withoutRequests).not.toContain('USER REQUESTS')
  })

  test('inlines the diffs below the limit, leaving out generated files’ bodies', () => {
    const prompt = buildAnalyzerPrompt(source, files, patchPath)

    expect(prompt).toContain('Uncommitted changes on main')
    for (const file of files) expect(prompt).toContain(file.path.slice(file.path.lastIndexOf('/') + 1))
    expect(prompt).toContain('4 files')
    expect(prompt).toContain('+13/-2')
    expect(prompt).toContain('+listen(port, host)')
    expect(prompt).toContain('@@ function start')
    expect(prompt).not.toContain('left-pad')
    expect(prompt).not.toContain(patchPath)
  })

  test('names the patch file instead when the diffs exceed the limit', () => {
    const hugeLine = `+${'x'.repeat(INLINE_DIFF_CHARACTER_LIMIT)}`
    const hugeFile: ReviewFile = {
      path: 'src/data.ts',
      status: ReviewFileStatus.Added,
      additions: 1,
      deletions: 0,
      isBinary: false,
      hunks: [{ header: '@@ -0,0 +1,1 @@', oldStart: 0, oldLines: 0, newStart: 1, newLines: 1 }],
      patch: `diff --git a/src/data.ts b/src/data.ts\n@@ -0,0 +1,1 @@\n${hugeLine}\n`,
      patchHash: 'hash-data',
      isPatchOmitted: false,
    }

    const prompt = buildAnalyzerPrompt(source, [...files, hugeFile], patchPath)

    expect(prompt).toContain(patchPath)
    expect(prompt).not.toContain(hugeLine)
    expect(prompt).not.toContain('+listen(port, host)')
    expect(prompt).toContain('data.ts')
  })

  test('lists a binary file and an omitted patch without a body', () => {
    const binaryFile: ReviewFile = { ...files[0]!, path: 'assets/logo.png', isBinary: true, hunks: [], patch: 'Binary files differ\n', patchHash: 'hash-logo' }
    const omittedFile: ReviewFile = { ...files[0]!, path: 'src/huge.ts', patch: 'SECRET-BODY', patchHash: 'hash-huge', isPatchOmitted: true }

    const prompt = buildAnalyzerPrompt(source, [binaryFile, omittedFile], patchPath)

    expect(prompt).toContain('logo.png')
    expect(prompt).toContain('huge.ts')
    expect(prompt).not.toContain('Binary files differ')
    expect(prompt).not.toContain('SECRET-BODY')
  })

  test('shows a renamed file with the path it came from', () => {
    const renamedFile: ReviewFile = { ...files[0]!, path: 'lib/after.ts', previousPath: 'lib/before.ts', status: ReviewFileStatus.Renamed }

    const prompt = buildAnalyzerPrompt(source, [renamedFile], patchPath)

    expect(prompt).toContain('lib/before.ts')
    expect(prompt).toContain('after.ts')
  })

  test('carries a pull request’s link, description and commits', () => {
    const pullRequestSource: ReviewSource = {
      ...source,
      target: {
        kind: ReviewTargetKind.PullRequest,
        key: 'pr-5',
        label: '#5 feature → main',
        number: 5,
        url: 'https://github.com/acme/shop/pull/5',
        baseRef: 'main',
        headRef: 'feature',
        author: 'ada',
        state: 'OPEN',
      },
      description: 'Why this change exists',
      commits: [
        { sha: 'abcdef1234567890', subject: 'First step', author: 'Ada Lovelace' },
        { sha: '1234567abcdef890', subject: 'Second step', author: 'Ada Lovelace' },
      ],
    }

    const prompt = buildAnalyzerPrompt(pullRequestSource, files, patchPath)

    expect(prompt).toContain('https://github.com/acme/shop/pull/5')
    expect(prompt).toContain('Why this change exists')
    expect(prompt).toContain('abcdef1 First step')
    expect(prompt).toContain('1234567 Second step')
  })
})

describe('selectUserRequests', () => {
  test('keeps only what the user typed, oldest first', () => {
    const requests = selectUserRequests([
      { role: 'user', text: 'Add search.<system-reminder>Today is Monday.</system-reminder>' },
      { role: 'assistant', text: 'Adding search now.' },
      { role: 'user', text: '' },
      { role: 'user', text: 'review-changes wrote a review page for 2 files (+3 −1) in 1 group: /repo/.git/review-changes/worktree.html' },
      { role: 'user', text: '<command-name>/review-changes</command-name>' },
      { role: 'user', text: 'Make the query case-insensitive.' },
    ])

    expect(requests).toEqual(['Add search.', 'Make the query case-insensitive.'])
  })

  test('keeps the first request and the newest ones when the session is long', () => {
    const middleRequest = 'm'.repeat(SINGLE_USER_REQUEST_CHARACTER_LIMIT)
    const messages = [
      { role: 'user' as const, text: 'First request.' },
      ...Array.from({ length: 5 }, () => ({ role: 'user' as const, text: middleRequest })),
      { role: 'user' as const, text: 'Newest request.' },
    ]

    const requests = selectUserRequests(messages)

    expect(requests[0]).toBe('First request.')
    expect(requests.at(-1)).toBe('Newest request.')
    expect(requests.join('').length).toBeLessThanOrEqual(USER_REQUESTS_TOTAL_CHARACTER_LIMIT)
    expect(requests.length).toBeLessThan(messages.length)
  })

  test('cuts one very long message short', () => {
    const [request] = selectUserRequests([{ role: 'user', text: 'x'.repeat(SINGLE_USER_REQUEST_CHARACTER_LIMIT + 100) }])

    expect(request).toBe(`${'x'.repeat(SINGLE_USER_REQUEST_CHARACTER_LIMIT)}…`)
  })
})

describe('isGeneratedPath', () => {
  test('recognises lock files by name, at any depth', () => {
    for (const path of ['bun.lock', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'go.sum', 'apps/web/Cargo.lock', 'Gemfile.lock', 'tools/custom.lock']) {
      expect(isGeneratedPath(path)).toBe(true)
    }
  })

  test('recognises minified, generated and snapshot files, and build output folders', () => {
    for (const path of ['public/app.min.js', 'src/schema.generated.ts', 'src/__snapshots__/app.test.ts.snap', 'dist/index.js', 'packages/ui/dist/index.js']) {
      expect(isGeneratedPath(path)).toBe(true)
    }
  })

  test('leaves hand-written files alone', () => {
    for (const path of ['src/app.ts', 'README.md', 'src/distance.ts', 'src/lockfile.ts', 'docs/minimal.md', 'src/generated-notes.md']) {
      expect(isGeneratedPath(path)).toBe(false)
    }
  })
})
