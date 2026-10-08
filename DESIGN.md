# review-changes: design

A Claude Code mod (a plugin of function hooks, Claude Code 2.1.292) and the local marketplace that lists it. `/review-changes [target]`, or the band's **Review changes** button, collects one diff from the git repo the session runs in. A read-only subagent groups the diff the way pulls.review does, and the mod writes one self-contained HTML file that renders the diff with `@pierre/diffs` and opens it in the browser. The goal and the out-of-scope list are in `CLAUDE.md`. Everything here serves the human's own review. The mod never edits, posts or judges.

Ground truth for the plugin API is the engine's declaration file. When the engine loads the plugin it lays that file at `plugins/review-changes/.claude-plugin/types/claude-code/index.d.ts` (gitignored; a copy is already there for type checking). Grep it; it is about 21k lines, so don't read it whole.

## 1. Repo layout

```
review-changes/                         repo root = the marketplace
  .claude-plugin/marketplace.json       lists ./plugins/review-changes
  package.json                          bun scripts: build:viewer, test, typecheck, validate
  tsconfig.plugin.json                  type-checks the hooks module (outside the plugin folder)
  DESIGN.md  CLAUDE.md  README.md
  viewer/                               the HTML viewer's source, built with bun (never loaded by the engine)
    build.ts                            Bun.build script, writes ../plugins/review-changes/assets/
    shiki-subset.ts                     stands in for `shiki` at build time (section 6.2)
    theming-subset.ts                   stands in for `@pierre/theming/themes`
    shiki-wasm-stub.ts                  stands in for `shiki/wasm`
    tsconfig.json                       DOM lib; includes src, ../plugins/review-changes/hooks/payload.ts and ../plugins/review-changes/hooks/types.ts
    src/main.ts, src/*.ts, src/viewer.css
    src/types.ts                        DiffLayout enum
    dev/                                optional: a fixture payload + dev page for agent-browser checks
  plugins/review-changes/               the plugin (what --plugin-dir and the marketplace point at)
    .claude-plugin/plugin.json
    .claude-plugin/types/               engine-written, gitignored
    agents/analyzer.md                  agent type `review-changes:analyzer`
    assets/viewer.js, assets/viewer.css committed build output, inlined into each review
    hooks/hooks.json                    { "modules": ["./register.tsx"] }
    hooks/register.tsx                  wiring: command, band, agent wait, toast, note
    hooks/payload.ts                    THE shared contract (types only + two constants), imported by viewer too
    hooks/types.ts                      the plugin's string enums (file status, line side, category, target kinds, notice type, git path prefix)
    hooks/target.ts                     argument grammar → TargetRequest (pure)
    hooks/git.ts                        TargetRequest → ReviewSource via git/gh; band candidate
    hooks/patch.ts                      unified patch → ReviewFile[] (pure, async for hashing)
    hooks/analysis.ts                   analyzer prompt + answer parsing/normalisation (pure)
    hooks/html.ts                       payload + bundle → HTML string, size budget (pure)
    hooks/review.ts                     the run: collect → spawn → wait → write → open → note
    types/index.d.ts                    PluginState contract ('review-changes')
    hooks/__test__/*.test.ts(x)         `claude plugin test plugins/review-changes`
```

Rules the engine imposes on `hooks/`: every module is ES, imported by a static `import` (no `import()`), named `.ts/.tsx/...`. The environment has no DOM and no Node: no `process`, `Buffer`, `fs`, `path`. Web APIs exist (`TextEncoder`, `crypto.subtle`, `URL`). Everything else goes through `$`. JSX factory is `h`, and elements come from `$.ui.resolve(e)`.

A review's output never lands in the working tree: `<git-common-dir>/review-changes/<slug>.html` and `<slug>.patch`.

## 2. Verified plugin API facts (2.1.292)

| Need | API (exact) |
|---|---|
| plugin root (assets) | `$.plugin.root` (absolute dir holding `.claude-plugin/`), so `$.fs.read(`${$.plugin.root}/assets/viewer.js`)` |
| session cwd | `await $.session.cwd()` (absolute). `$.session.repo()` → `{ root, remote, internal, name }` or null (root is the MAIN worktree's; use git for the current worktree) |
| command | in `session.start`: `await $.command.register({ name: 'review-changes', description, argumentHint: '[#pr | --worktree | rev | A...B | A..B]' })`, then `on('command.run', { command: 'review-changes' }, async ($, e) => ({ text }))`, with `e.args` = everything after the name. Answering without `next` = "answers its own command" (not a gate). |
| band | `on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => ...)`. `e.props`: `hasSurvey`, `isWorking`, `maxRows`, `bodyColumns`, `scroll`, `view`. Yield with `return next(e)` when `e.props.hasSurvey` or nothing to show. `const { Box, Text, Button } = $.ui.resolve(e)`. |
| Button | props `key`, `label`, `hotkey` (one digit/lowercase letter), `variant: 'primary'`, `dimColor`, `onPress: (pressEvent) => void` (runs in plugin env; do not await long work in it, start it with `void`). |
| state | `import { atom, read, update } from 'claude-code'`; `const candidate = atom({ plugin: 'review-changes', key: 'candidate' } as const, null)`; read while drawing with `await read($, candidate)` (subscribes); write from handlers/events with `await update($, candidate, () => value)`. Never `$.state.set` while drawing (denied). |
| process | `$.process.run(argv, { cwd?, env?, stdin?, timeoutMs? })` → `{ exitCode, stdout, stderr, isStdoutTruncated, isStderrTruncated }`. No shell; any exit code resolves; rejects only when it cannot start or times out (default 30 s, max 600 000). stdout capped at 4 MiB. Git runs with repo hooks off. |
| fs | `$.fs.read(path)` → text (`{ as: 'bytes' }` → `{ base64 }`); `$.fs.write(path, text)` creates parent dirs; `$.fs.exists`, `$.fs.list`, `$.fs.stat`. **No mkdir and no delete.** **Read/write over 4 MiB rejects.** |
| agent type | `agents/analyzer.md` declares `review-changes:analyzer` (frontmatter as an agent file; `$.agent.register(spec)` is the programmatic twin with the same fields: `name, description, prompt, tools, model, maxTurns, omitClaudeMd, permissionMode, ...`). Hide it from the main model: `on('agent.offer', { agent: 'review-changes:analyzer' }, () => ({ isOffered: false }))`. The plugin's own spawn still runs. |
| spawn | `$.agent.spawn({ prompt, description, subagentType: 'review-changes:analyzer', cwd? , model? })` resolves once STARTED with `{ model, agentId }` or `{ deny }`. A plugin's spawn always runs in the background. The answer arrives as that agent's `turn.complete`: `on('turn.complete', ($, e, next) => ...)` with `e.agentId === agentId`, `e.answer` (final text), `e.reason: 'answer'|'aborted'|'refusal'|'error'`. Always `return next(e)`. There is no structured output: parse JSON out of `e.answer`. |
| note in session | `$.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } })` is a notice the person sees and the model never reads (exactly one text block). `type: 'user'` is a hidden row the model reads. Text blocks only. |
| toast | `$.ui.toast(text, { timeoutMs })`: default 4000. The mod never calls `$.ui.status`: the band already shows the run. |
| timers | `$.clock.every(ms, fn)` / `$.clock.after(ms, fn)` return `{ cancel() }`; dropped on hot reload. `$` captured by a hook stays usable after the hook returns (timers and continuations use it). |
| budget | 10 s per hook dispatch, **excluding time awaiting `$` calls**. Awaiting a plain promise (the agent's answer) counts, so the command hook must not await the analysis: it returns after the spawn and the rest continues in the background. |
| reload | Module variables are lost on hot reload; `$.state` values survive. A `session.start` hook runs once per session. |
| tools on this build | Native macOS build registers `Read` but **not `Grep`/`Glob`**. List all three; the analyzer reads files by path where search is missing. |
| tests | `claude plugin test <dir>` runs `*.test.ts(x)` with `import { test, describe, expect, mock } from 'claude-code/testing'`. Body `($, on)`: `on(...)` hooks sit BENEATH the plugin and stand for the engine. Op events answer `{ value }`: `on('process.run', ($, e) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))`, `on('session.cwd', () => ({ value: '/repo' }))`, `on('fs.write', ($, e) => { written.set(e.path, e.text); return { value: undefined } })`, `on('fs.read', ...)`, `on('command.register', ($, e) => ({ value: { command: e.name } }))`. Event hooks answer their result: `on('session.start', ($, e) => ({ cwd: e.cwd }))`, `on('turn.complete', ($, e) => ({ text: e.answer }))`. Drive with `await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })`, then `await $.command.run({ command: 'review-changes', args: '', origin: { kind: 'composer' } as never, presentation: { isFullscreen: false, columns: 80 } })`. A UI test mounts: `await $.ui.mount({ plugin: 'review-changes', surface, component: 'AbovePrompt', props })`, then `ui.find({ key })` / `ui.press({ key })`. Loop over `['terminal', 'desktop'] as const`. The harness has no real fs/process/network, so test pure modules by importing them directly (`import { parseTargetArgument } from '../hooks/target.ts'`). **Verified gotcha:** a test's `agent.spawn` hook cannot hand an `agentId` up (the plugin receives `{ model: 'inherit' }` only), so the spawn→answer path is not testable in the harness. Keep it a thin shell around pure functions. |
| validate | `claude plugin validate .` (marketplace) and `claude plugin validate plugins/review-changes` (manifest, `types` contract, hooks, calls). Both verified working on a sample. |

## 3. Target grammar and exact commands

All git runs are `$.process.run(['git', ...], { cwd: repositoryRoot, env: { LC_ALL: 'C' } })`, except the first `rev-parse`, which runs at the session cwd. Every diff uses these shared flags:

```
DIFF_FLAGS = ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '-M', '--src-prefix=a/', '--dst-prefix=b/']
```
(`-c` precedes `diff`; build argv as `['git', '-c', 'core.quotePath=false', 'diff', ...rest]`.) `EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'`.

### 3.1 Grammar (`hooks/target.ts`, pure)

```ts
export type TargetRequest =
  | { kind: TargetRequestKind.Auto }                   // "" (whitespace only)
  | { kind: TargetRequestKind.Worktree }               // "--worktree"
  | { kind: TargetRequestKind.PullRequest; number: number; url?: { owner: string; name: string } }
  | { kind: TargetRequestKind.Range; base: string; head: string; isMergeBase: boolean }
  | { kind: TargetRequestKind.Revision; revision: string } // a branch or a single commit; git.ts tells which
export function parseTargetArgument(text: string): TargetRequest   // throws TargetError (message for the person)
export class TargetError extends Error {}
```

Rules, in order, on `text.trim()`:
1. `""` → `auto`.
2. `--worktree` → `worktree`. Any other token starting with `-` → `TargetError('Unknown option "<token>". ...usage')`.
3. `^#?(\d+)$` → `pull-request` with that number (a positive integer).
4. `^https?://github\.com/([^/]+)/([^/]+)/pull/(\d+)(?:[/?#].*)?$` → `pull-request` with `url: { owner, name }` (name without a trailing `.git`).
5. Contains `...` → `range`, `isMergeBase: true`. Else contains `..` → `range`, `isMergeBase: false`. An empty side means `HEAD`. A side starting with `-` → `TargetError`.
6. More than one whitespace-separated token → `TargetError` (usage).
7. Otherwise → `revision`.

### 3.2 Resolution (`hooks/git.ts`)

```ts
export type RunCommand = (argv: readonly string[], init?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number })
  => Promise<{ exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean }>
// `$.process.run` satisfies it structurally; tests pass a fake keyed by argv.

export type ReviewSource = {
  repository: ReviewRepository          // from payload.ts
  gitCommonDirectory: string            // absolute
  target: ReviewTarget                  // from payload.ts, key + label filled
  slug: string                          // file-name-safe, from target.key: [^A-Za-z0-9._-]+ → '-', max 80 chars
  title: string
  description?: string
  commits: ReviewCommit[]
  patch: string                         // the whole unified diff
}
export async function resolveReviewSource(runCommand: RunCommand, sessionCwd: string, request: TargetRequest): Promise<ReviewSource>
export async function findReviewCandidate(runCommand: RunCommand, sessionCwd: string): Promise<{ summary: string } | null>
export class ReviewSourceError extends Error {}   // message is shown to the person as is
```

Steps:

- **Repo**: `git rev-parse --show-toplevel` at `sessionCwd`. A non-zero exit throws `ReviewSourceError('Not inside a git repository: <cwd>')`. Then at the root: `git rev-parse --path-format=absolute --git-common-dir`. `repository.name` is `owner/name` parsed from `git remote get-url origin` when that is a github.com URL (https or `git@github.com:`), else the root's basename.
- **HEAD**: `git rev-parse --verify --quiet HEAD`. A non-zero exit means an unborn branch, so the base is `EMPTY_TREE`. Branch: `git symbolic-ref --quiet --short HEAD` (non-zero → detached, `null`).
- **Default branch**: `git symbolic-ref --quiet --short refs/remotes/origin/HEAD` (e.g. `origin/main`). Otherwise the first of `main`, `master`, `origin/main`, `origin/master` for which `git rev-parse --verify --quiet <name>^{commit}` exits 0. Otherwise none.
- **auto**: worktree if `git status --porcelain=v1 -z --untracked-files=all` prints anything (`all`, so the band's count is of files, not of new directories). Otherwise, with a default branch and `git rev-list --count <default>..HEAD` > 0, the range `<default>...HEAD`. Otherwise `ReviewSourceError('Nothing to review: no uncommitted changes, and <branch> is not ahead of <default>.')`.
- **worktree**:
  - tracked changes (staged and unstaged): `git DIFF_FLAGS <base>`, where base is `HEAD` or `EMPTY_TREE`;
  - untracked files: `git ls-files --others --exclude-standard -z`; for each path (at most 200, sorted; past that, add one line to the description saying how many were left out) `git DIFF_FLAGS --no-index -- /dev/null <path>` (exit 0 or 1 both succeed);
  - patch = the tracked output followed by each untracked file's output.
  - key `worktree`, label `Uncommitted changes on <branch|detached HEAD>`, title = label, commits [].
- **range** `A...B` / `A..B`: `git DIFF_FLAGS A...B` or `A..B`. Each side must verify with `git rev-parse --verify --quiet <side>^{commit}`, else `ReviewSourceError('Unknown revision "<side>"')`. Commits: `git log --reverse --format=%H%x1f%s%x1f%an%x1e <from>..B`, where `<from>` is `git merge-base A B` for `...` and A for `..`. Key `range-A...B`, label `B vs A`; title is the single commit's subject when there is one commit, else the label.
- **revision**: if `git show-ref --verify --quiet refs/heads/<rev>` or `refs/remotes/<rev>` exits 0, it is a branch: resolve as range `<default>...<rev>`, and with no default branch throw `ReviewSourceError`. Otherwise it must verify as `^{commit}`. Then sha = `git rev-parse <rev>^{commit}`; parent = `git rev-parse --verify --quiet <sha>^1`, and with none use `EMPTY_TREE`; patch = `git DIFF_FLAGS <parent> <sha>`; commits = that one (`git log -1 --format=%H%x1f%s%x1f%an <sha>`). Key `commit-<sha first 12>`, label `<rev> (<sha first 7>)`, title = subject.
- **pull-request**: `gh repo view --json nameWithOwner --jq .nameWithOwner` at the root. If the request carries `url` and its `owner/name` differs (case-insensitively), throw `ReviewSourceError('That pull request belongs to <owner/name>; this session is in <repo>.')`. Then `gh pr view <n> --json number,title,body,url,author,baseRefName,headRefName,state,commits` and `gh pr diff <n> --color=never` (timeoutMs 120000). Commits come from `commits[].oid`, `messageHeadline`, `authors[0].name ?? login`. Key `pr-<n>`, label `#<n> <headRef> → <baseRef>`, title = PR title, description = body. If `gh` cannot start, or exits non-zero, throw `ReviewSourceError` carrying gh's first stderr line (e.g. not authenticated).
- **Truncation**: any diff stdout with `isStdoutTruncated` throws `ReviewSourceError('The diff is larger than 4 MiB; review a narrower target.')`. An empty patch throws `ReviewSourceError('No changes in <label>.')`.
- **findReviewCandidate**: never throws (null on any failure). It returns `"<n> uncommitted file(s)"` from the status entries. Otherwise, when ahead of the default branch, `"<n> commit(s) ahead of <default>"`. Otherwise null.

## 4. Patch → files (`hooks/patch.ts`, pure)

```ts
export async function buildReviewFiles(patch: string): Promise<ReviewFile[]>
```
Split at `^diff --git ` (multiline). Per chunk:
- path: from `+++ b/<p>`, or from `rename to`/`copy to`, or from the `diff --git a/x b/y` header when there are no `---/+++` lines (binary, mode-only, pure rename). For a removed file it is the `--- a/<p>` path. Unquote C-style quoted paths (see pulls.review `patch-parser.ts` `unquoteGitPath`).
- status: `new file mode` → added; `deleted file mode` → removed; `rename from` → renamed; `copy from` → copied; else modified. `previousPath` for rename/copy.
- `isBinary`: a `Binary files ... differ` or `GIT binary patch` line.
- hunks: every `^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@` (a missing count means 1). additions/deletions count body lines starting `+`/`-`, excluding the `+++`/`---` headers.
- `patch` = the chunk text, ending in exactly one `\n`. `patchHash` = hex SHA-256 via `crypto.subtle.digest('SHA-256', new TextEncoder().encode(patch))`. `isPatchOmitted: false`.

## 5. Analysis

### 5.1 Agent (`agents/analyzer.md`)

```
---
name: analyzer
description: Groups a diff of the current repository into review groups for review-changes. Used only by the review-changes plugin.
tools: Read, Grep, Glob
model: sonnet
---
<system prompt>
```
The system prompt adapts pulls.review's `ROLE_SECTION` + `grouping_principles` + `OUTPUT_SECTION` (MIT, credit in README), with these changes:
- No `children` (groups are flat).
- The workflow: (1) read the manifest and form a grouping hypothesis; (2) Read files of the repository only where the hunks are not enough, and the patch file only when the diffs are not inline; never read `[generated]`/`[binary]` paths; never modify anything; (3) answer with ONE fenced ```json block holding the analysis and nothing else.
- It writes notes that explain what changed and why, and sets `critical` only where the human should look most carefully. **No verdicts, no scores, no approval language, no fix suggestions written as patches.**
- It embeds the JSON shape below verbatim (types + field rules + the category guide from pulls.review `types/analyze.ts` `CATEGORY_GUIDE`).

The answer shape the agent must produce:
```json
{
  "overallSummary": "string, Markdown, 1-3 sentences, why over what",
  "groups": [{
    "key": "kebab-case, unique",
    "label": "<= 4 words",
    "category": "ui|api|core|data|cli|security|tests|docs|examples|deps|build|scripts|config|i18n|assets|other",
    "summary": "Markdown, 1-3 sentences, why over what",
    "filePaths": ["every manifest path in exactly one group"],
    "fileNotes": [{ "path": "...", "text": "...", "critical": true }],
    "lineNotes": [{ "path": "...", "side": "additions|deletions", "line": 12, "text": "...", "critical": true }],
    "critical": true
  }]
}
```
`fileNotes`, `lineNotes` and `critical` are optional and used sparingly.

### 5.2 Prompt and parsing (`hooks/analysis.ts`, pure)

```ts
export const ANALYZER_AGENT = 'review-changes:analyzer'
export const INLINE_DIFF_CHARACTER_LIMIT = 200_000
export function buildAnalyzerPrompt(source: ReviewSource, files: ReviewFile[], patchPath: string): string
export function parseAnalyzerAnswer(answer: string, files: ReviewFile[]): { analysis: ReviewAnalysis; error?: string }
export function fallbackAnalysis(files: ReviewFile[], reason: string): ReviewAnalysis
```
- **Prompt** (pulls.review `buildAnalysisPrompt` adapted): `Title:`, `Target: <label>`, PR URL, `---DESCRIPTION---`, `---COMMITS---` (only if > 1), `---MANIFEST--- (N files, +A/-D)` grouped by directory, with lines `basename (from old)  A|D|M|R|C  +a/-d  [generated]|[binary]|@@ ctx / @@ ctx` (generated = lockfiles, `dist/`, `*.min.*`, `*.snap`, a short glob list), then either `---DIFFS--- (all diffs included)` with each file's hunks (`### path [status, +a/-d]`, generated/binary bodies omitted) when ≤ `INLINE_DIFF_CHARACTER_LIMIT`, or `The full patch is at <patchPath>; Read the parts you need.` It closes with `The repository is checked out at the working directory; Read files there when the hunks are not enough. Answer with one fenced json block.`
- **Parsing**: take the last fenced ```json block, else the substring from the first `{` to the last `}`, and `JSON.parse`. Not an object with `groups` array → `{ analysis: fallbackAnalysis(files, reason), error: reason }`.
- **Normalisation** (always applied):
  - `overallSummary` not a string → "".
  - Each group: a non-string key/label → derive (`group-<i>`, `Group <i>`); key kebab-cased and de-duplicated with `-2`, `-3`; category outside the list → `other`; summary not a string → "".
  - `filePaths`: keep only paths of `files`, first occurrence across groups wins.
  - fileNotes/lineNotes: keep only those whose path is in THAT group's kept `filePaths` and whose `text` is a non-empty string. A note pointing at a file of another group moves to that group. `critical` kept only when `=== true`.
  - lineNote: `line` must be an integer inside a hunk of its side (additions: `newStart ≤ line < newStart + newLines`; deletions: same with old). Otherwise it becomes a fileNote `"(line <n>) <text>"`.
  - Drop groups left with no files.
  - Files in no group → a final group `{ key: 'uncategorized', label: 'Uncategorized', category: 'other', summary: '', filePaths: [...in patch order], fileNotes: [], lineNotes: [] }`.
- **fallbackAnalysis**: overallSummary = `Automatic grouping failed: <reason>. All files are listed below.`; one Uncategorized group with all files.

## 6. Viewer

### 6.1 Payload in the page

The HTML file (assembled by `hooks/html.ts`):
```html
<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>{escapeHtml(title)} · review-changes</title>
<style>{viewer.css}</style></head>
<body><div id="app"></div>
<script type="application/json" id="review-payload">{JSON with every "<" written as <}</script>
<script type="module">{viewer.js with "</script" → "<\/script" and "<!--" → "<\!--"}</script>
</body></html>
```
The viewer reads it with `JSON.parse(document.getElementById(REVIEW_PAYLOAD_ELEMENT_ID)!.textContent!) as ReviewPayload`. If `schemaVersion` is unknown it shows a one-line error. The page works from `file://`, offline (an inline module script was verified to run there).

### 6.2 Building with bun

`bun run build:viewer` → `viewer/build.ts`:
```ts
await Bun.build({ entrypoints: ['viewer/src/main.ts'], target: 'browser', format: 'esm', minify: true,
  outdir: 'plugins/review-changes/assets', naming: 'viewer.[ext]', plugins: [subsetPlugin] })
```
- One JS file with no chunks (no `splitting`). CSS imported from `main.ts` lands as `viewer.css`. If bun emits CSS under another name, rename it in the script.
- **Size is a hard constraint.** `$.fs.read`/`$.fs.write` reject above 4 MiB, and the HTML holds the bundle plus the diff. A plain build of `@pierre/diffs` is **10.75 MB**, because it pulls in every Shiki grammar, every theme and the Oniguruma wasm. A bun plugin with three `onResolve` redirects brings it to **~1.86 MB** with 15 grammars (verified, and it renders with highlighting and annotations):
  - `/^shiki$/` → `viewer/shiki-subset.ts`: `export * from 'shiki/core'`, `export { createJavaScriptRegexEngine } from 'shiki/engine/javascript'`, `export const createOnigurumaEngine = () => { throw new Error('...') }`, a curated `bundledLanguages` record of `() => import('@shikijs/langs/<lang>')` (typescript, tsx, javascript, jsx, json, css, html, markdown, yaml, shellscript, python, go, rust, sql, toml; add a few more only if size allows: target ≤ 2.5 MB), `bundledThemes = {}`, and `createHighlighter = createBundledHighlighter({ langs: bundledLanguages, themes: bundledThemes, engine: () => createJavaScriptRegexEngine() })`. Pierre also imports `codeToHtml`, `createCssVariablesTheme`, `getTokenStyleObject`, `stringifyTokenStyle` from `shiki`, and these come from `shiki/core` via the `export *` (check the build log for missing exports).
  - `/^@pierre\/theming\/themes$/` → `viewer/theming-subset.ts`: re-export `pierreThemes` and `createTheme` from `@pierre/theming`'s `dist/collections/pierre.js` and `dist/modules/createTheme.js` (resolve the absolute paths with `import.meta.resolve`/`Bun.resolveSync` from `@pierre/theming`'s package.json), and `export const shikiThemes = { getTheme: () => undefined, getThemes: () => [] }`.
  - `/^shiki\/wasm$/` → `viewer/shiki-wasm-stub.ts` (`export default undefined`).
- Themes: `{ dark: 'pierre-dark', light: 'pierre-light' }` with `themeType: 'system'` (prefers-color-scheme). Always `preferredHighlighter: 'shiki-js'`.
- `@shikijs/langs` is a transitive dependency. Import it as is; add it to devDependencies only if bun cannot resolve it from `viewer/`.
- The build prints the output sizes, and fails if `viewer.js` + `viewer.css` exceed 3 MiB.
- The output is committed. Rebuild after any viewer change.

### 6.3 @pierre/diffs vanilla API used (v1.5.2, verified from dist .d.ts)

- `import { FileDiff, getSingularPatch, parsePatchFiles } from '@pierre/diffs'`. The import also registers the `<diffs-container>` custom element, which draws in a shadow root with its own CSS.
- `getSingularPatch(filePatch: string): FileDiffMetadata` parses one file's section, which is what `ReviewFile.patch` holds. (`parsePatchFiles(whole)` → `ParsedPatch[]` with `.files` exists too.)
- `new FileDiff<NoteMetadata>(options).render({ fileDiff, containerWrapper: element, lineAnnotations })`. Re-render with new options via `instance.setOptions({...}); instance.rerender()`, or `setLineAnnotations([...])`. Free it with `cleanUp()`.
- Options (`FileDiffOptions` ⊇ `BaseDiffOptions` ⊇ `BaseCodeOptions`): `diffStyle: 'unified' | 'split'`, `theme: { dark, light }`, `themeType: 'system' | 'light' | 'dark'`, `overflow: 'scroll' | 'wrap'`, `diffIndicators: 'classic' | 'bars' | 'none'`, `lineDiffType: 'word-alt' | 'word' | 'char' | 'none'`, `hunkSeparators: 'simple' | 'metadata' | 'line-info' | 'line-info-basic'`, `collapsed`, `disableFileHeader`, `stickyHeader`, `expandUnchanged`, `renderHeaderMetadata(fileDiff) => Element | string | null` (put the reviewed checkbox here or in your own header with `disableFileHeader: true`), `renderAnnotation(annotation) => HTMLElement | undefined`.
- Annotations: `DiffLineAnnotation<T> = { side: 'additions' | 'deletions'; lineNumber: number; metadata: T }`. `lineNumber: 0` draws above the first hunk on that side. A `ReviewLineNote` maps 1:1 (`side`, `line` → `lineNumber`). The element `renderAnnotation` returns lives in light DOM (slotted), so viewer CSS styles it. Give it explicit colours: an unstyled one rendered with invisible text on the probe.
- A patch-parsed diff is partial (`isPartial: true`), so hunk expansion is unavailable. That is expected.

### 6.4 UI (vanilla TS, modelled on pulls.review; dense, quiet)

- **Header**: title; target label + repo name; commit count; `+A −D` totals; `R / M reviewed`; unified/split toggle (persisted in localStorage `review-changes:layout`); "collapse reviewed" toggle.
- **Overall summary** (Markdown) under the header. Commit list collapsible. PR description collapsible.
- **Left sidebar**: groups in analysis order, each with category chip, label, file count, a reviewed count, and a critical marker. Under the active group, its file tree (directories folded into paths) with a reviewed checkbox per file. A filter box narrows the list by path.
- **Main**: the active group's summary + "review carefully" callouts (critical group/notes), then each file of the group. A file header has the path (old → new for renames), status, `+a −d`, a reviewed checkbox, and the file notes (critical ones highlighted) above the diff. The diff renders with line notes as annotations. Files with `isPatchOmitted` or `isBinary` show a one-line placeholder instead.
- **Reviewed state**: localStorage key `review-changes:v1:<repository.root>:<target.key>:<file.path>:<file.patchHash>` = `"1"`. Checking a file collapses it when "collapse reviewed" is on, and updates the counters live.
- **Markdown**: a tiny safe renderer (escape HTML first; then code spans, fenced code, bold/italic, links with http(s) only, paragraphs, lists). No dependency, no innerHTML of unescaped text.
- Light/dark from `prefers-color-scheme` via CSS variables; the diff follows with `themeType: 'system'`.
- Keyboard: `j`/`k` next/previous file, `[`/`]` previous/next group, `x` toggle reviewed on the focused file, `s` toggle layout.
- Render lazily: create a `FileDiff` when its container nears the viewport (IntersectionObserver), so a 200-file review opens fast.

## 7. Mod flow (`hooks/review.ts` + `hooks/register.tsx`)

The engine follows `$` only into functions declared in the same file as the hook, never across an import. So `review.ts` never takes `$`: it drives a `ReviewEngine` of closures (process runner, session cwd, file read/write, analyzer spawn, clock, toast, notices, state reads and writes, `shouldOpenBrowser`) that `reviewEngineOf($)` in `register.tsx` builds. The `$`-shaped signatures below stand for that engine. Tests drive `review.ts` through an in-memory `ReviewEngine`.

State atoms (contract in `types/index.d.ts`):
```ts
const candidate = atom({ plugin: 'review-changes', key: 'candidate' } as const, null)
const run = atom({ plugin: 'review-changes', key: 'run' } as const, null)
const last = atom({ plugin: 'review-changes', key: 'last' } as const, null)
const isHidden = atom({ plugin: 'review-changes', key: 'isHidden' } as const, false)
```
Module variables: `activeRunId: string | null`, `answerWaiters: Map<agentId, (input: { answer: string; reason: string }) => void>`, `earlyAnswers: Map<agentId, {...}>` (an answer that arrives before its waiter is registered).

### register.tsx
1. `on('session.start')`: register the command; `update(run, () => null)`; refresh the candidate; start `$.clock.every(20_000, () => void refreshCandidate($))`; `return next(e)`.
2. `on('agent.offer', { agent: 'review-changes:analyzer' }, () => ({ isOffered: false }))`.
3. `on('turn.complete', ($, e, next) => { if (e.agentId) deliver(e.agentId, { answer: e.answer, reason: e.reason }); else void refreshCandidate($); return next(e) })`.
4. `on('command.run', { command: 'review-changes' }, async ($, e) => { const outcome = await startReview($, e.args); return { text: outcome.text } })`.
5. `on('ui.render', { component: 'AbovePrompt' })`: yield (`next(e)`) when `e.props.hasSurvey`, when hidden, or when there is no run, candidate or last. Otherwise draw one row:
   - while `run` is set and `run.runId === activeRunId`: `<Text dimColor>Reviewing {label}: {phase}…</Text>`;
   - otherwise, when a candidate exists: `<Text dimColor>{candidate.summary} </Text><Button key="review" label="Review changes" variant="primary" hotkey="r" onPress={() => void startReviewWithToast($, '')} />`;
   - when `last` exists: `<Button key="open-last" label="Open last review" hotkey="o" onPress={() => void openInBrowser($, last.htmlPath)} />`;
   - always: `<Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />`.
   Keep it to one row of `e.props.bodyColumns` (truncate the summary).

### review.ts
```ts
export async function startReview($: EngineInterface, argumentText: string): Promise<{ text: string }>
```
1. If a run is active, return `{ text: 'A review is already running: <label>.' }`.
2. `parseTargetArgument(argumentText)`. On `TargetError`, return `{ text: '<message>\nUsage: /review-changes [--worktree | #<pr> | <pr url> | <branch> | <rev> | A...B | A..B]' }`.
3. `runId = crypto.randomUUID()`, `activeRunId = runId`, `update(run, { runId, label: 'current changes', phase: 'collecting' })`.
4. `source = await resolveReviewSource($.process.run, await $.session.cwd(), request)`, then `files = await buildReviewFiles(source.patch)`. On `ReviewSourceError`, clear the run and return `{ text: message }`.
5. `outputDirectory = <source.gitCommonDirectory>/review-changes`; `patchPath = <outputDirectory>/<slug>.patch`; `await $.fs.write(patchPath, source.patch)`.
6. `spawned = await $.agent.spawn({ subagentType: ANALYZER_AGENT, description: 'Group changes for review', prompt: buildAnalyzerPrompt(source, files, patchPath), cwd: source.repository.root })`. If `deny` or no `agentId`, continue with `fallbackAnalysis(files, deny ?? 'the analyzer did not start')`. Do not stop: the page is still useful.
7. Phase `analyzing`. Start `void finishReview($, ...)`, then return `{ text: 'Reviewing <label> (<N> files, +A/−D). The page opens when the analysis is done.' }`.

```ts
async function finishReview($, { runId, source, files, agentId, model, outputDirectory })
```
1. `answer = await waitForAnswer($, agentId, 15 * 60_000)`: a promise resolved by `deliver`, rejected by `$.clock.after(timeout)`. Settle `reason !== 'answer'` as failure `the analyzer ended (<reason>)`.
2. `{ analysis, error } = parseAnalyzerAnswer(answer.answer, files)`, or `fallbackAnalysis(files, <failure>)` with `error`.
3. Phase `writing`. Read `${$.plugin.root}/assets/viewer.js` and `viewer.css`. `payload: ReviewPayload = { schemaVersion: 1, generatedAt: new Date(await $.clock.now()).toISOString(), ...source fields, files, analysis, analysisModel: model, analysisError: error }`.
4. `html = assembleReviewHtml({ payload, viewerScript, viewerStyle })` (`hooks/html.ts`). It fits the payload under `MAX_HTML_BYTES = 4 * 1024 * 1024 - 64 * 1024` by blanking the largest `patch`es (setting `isPatchOmitted: true`) until the UTF-8 byte length fits, and throws `HtmlBudgetError` if even no patches would not fit.
5. `htmlPath = <outputDirectory>/<slug>.html`; `$.fs.write(htmlPath, html)`; unless `$.env.get('REVIEW_CHANGES_NO_OPEN')` is set, `openInBrowser($, htmlPath)`: `uname -s` → `Darwin` uses `['open', htmlPath]`, otherwise `['xdg-open', htmlPath]`. A non-zero exit is not fatal: the toast and note carry the path.
6. `update(last, { label, htmlPath })`. Session note via `$.session.append({ message: { type: 'system', content: [{ type: 'text', text: note }] } })`, and `buildModelNote(payload, htmlPath)` as `type: 'user'` so the model knows the review exists. The model note's own words are only the counts and the page path; the session note follows inside `<review-changes-analysis>` markers (any copy of the markers in it removed), labelled as untrusted data, because the analyzer read text the change's author controls. A last line, outside the markers, asks the model to reply with at most two sentences pointing the user to the page and not to review the change itself unless asked. Every analyzer-written field is collapsed to one line with control and bidirectional-override characters removed. `note` (built by a pure `buildSessionNote(payload, htmlPath)` in analysis.ts):
   ```
   review-changes: <title> (<N> files, +A/−D, <G> groups)
   <overallSummary>
   Review carefully:
   - <group label> — <group summary first sentence>        (critical groups)
   - <path>:<line> — <note text>                            (critical file/line notes, at most 8)
   Page: <htmlPath>
   ```
   Leave out "Review carefully:" when nothing is critical. Add `Analysis failed: <error>` when `analysisError` is set.
7. `$.ui.toast('Review ready: <label>', { timeoutMs: 6000 })`.
8. `finally`: clear `run`, `activeRunId`, the waiter; `refreshCandidate`.
9. Any throw in finishReview → `$.ui.toast('review-changes failed: <message>', { timeoutMs: 8000 })` + a system notice with the same text.

`startReviewWithToast($, args)` (for the button) runs `startReview` and toasts its `text`.

`refreshCandidate($)`: `update(candidate, () => findReviewCandidate($.process.run, cwd))`, writing only when the summary changed (to avoid redraws).

## 8. Error handling summary

| Situation | What the person sees |
|---|---|
| bad argument | command output: message + usage |
| not a repo / unknown rev / nothing to review / PR of another repo / gh missing or unauthenticated / diff > 4 MiB | command output (or toast from the button): the `ReviewSourceError` message |
| spawn denied / analyzer error / aborted / timeout / unparseable answer | page still written with the fallback grouping; note says `Analysis failed: …`; toast "Review ready" |
| HTML over budget even without patches | toast + notice `review-changes failed: …` |
| browser open fails | toast/note still give the path |
| a second run while one runs | "A review is already running" |

## 9. Tests (behaviours only; no change detectors)

Every expected value is written out by hand. The fakes are a `RunCommand` keyed by argv joined with spaces, and harness hooks beneath the plugin. Nothing asserts that "X was called".

- `hooks/__test__/target.test.ts`: `""` → auto; `--worktree`; `#53`, `53`, `https://github.com/example/notes/pull/53/files` → PR 53 (+ url owner/name); `main...feature`, `main..feature`, `...feature` (base HEAD); `HEAD~2`; `-x`, `a b`, `main...-x` → TargetError.
- `hooks/__test__/patch.test.ts`: a hand-written patch with a modified file (2 hunks), a new file, a deleted file, a rename with changes, a pure rename, a binary file, and a quoted path with a space/UTF-8. Assert path, previousPath, status, additions/deletions, hunks, `isBinary`. Assert that `patch` sections joined reproduce the input, that the same section gives the same `patchHash`, and that a different section gives a different one.
- `hooks/__test__/git.test.ts` (fake runner): auto picks the worktree when status is non-empty; auto picks `origin/main...HEAD` when clean and ahead, and gives the "Nothing to review" message when clean and level. The worktree includes an untracked file's section after the tracked diff. A PR URL of another repo is refused with the message naming both. A truncated stdout gives the 4 MiB message. A branch name resolves to `<default>...branch`, and a commit resolves to `<parent> <sha>`, with the root commit compared with the empty tree. Slugs are file-name safe.
- `hooks/__test__/analysis.test.ts`: a valid fenced answer is kept as given (hand-written expected analysis). Unknown paths are dropped, a duplicate path stays in its first group, leftovers land in Uncategorized, an unknown category becomes `other`, and duplicate keys get suffixes. A line note outside every hunk becomes a `(line n)` file note, and a note on another group's file moves to that group. Prose with no JSON gives the fallback + error. Covers `buildSessionNote` (critical items listed, "Review carefully" absent when none) and the prompt (inline diffs below the limit; patch path above it; generated files' bodies omitted).
- `hooks/__test__/html.test.ts`: a payload whose strings contain `</script><script>alert(1)</script>` and `<!--` survives a round trip. Extract the JSON between the payload tags, `JSON.parse` it, and it deep-equals the input. The page has exactly two `<script` openings and the escaped title. An oversized payload drops the largest patches first, marks them omitted, and fits the byte budget. An impossible budget throws `HtmlBudgetError`.
- `hooks/__test__/register.test.tsx` (harness): after `session.start` with a fake `process.run`, `/review-changes -x` answers the usage text; `/review-changes` outside a repo (`rev-parse` exits 128) answers "Not inside a git repository". The band, mounted on `terminal` and `desktop` with a candidate in state, shows a `review` button and the summary text, and draws nothing (engine's own) when the candidate is null. Pressing `hide` hides it.
- Viewer: no unit tests required. Check the built page with agent-browser on a fixture payload (`viewer/dev/fixture.json`, a made-up pull request) in light and dark; screenshots are a manual check, not committed tests.

## 10. Checks (run once, before handing back)

```
bun install
bun run build:viewer            # writes plugins/review-changes/assets/viewer.{js,css}; prints sizes
bun run typecheck               # tsc -p tsconfig.plugin.json && tsc -p viewer/tsconfig.json
bun run test                    # claude plugin test plugins/review-changes
bun run validate                # claude plugin validate . && claude plugin validate plugins/review-changes
```
`tsconfig.plugin.json` (root, outside the plugin) has the header's options + `allowImportingTsExtensions` and includes the plugin's `.claude-plugin/types`, `hooks`, `types` and `tests`. `viewer/tsconfig.json`: `lib: ["es2023", "dom", "dom.iterable"]`, `moduleResolution: "bundler"`, `strict`, `noUncheckedIndexedAccess`, `allowImportingTsExtensions`, `noEmit`, `types: ["bun"]` for build.ts. Include `viewer/**/*.ts`, `plugins/review-changes/hooks/payload.ts` and `plugins/review-changes/hooks/types.ts`.

E2E (manual): from a repo with an open pull request, `claude --plugin-dir <path to this repo>/plugins/review-changes`, then `/review-changes #<number>`. Expect the page in `.git/review-changes/pr-<number>.html`, a toast and a note.

## 11. Install

```
/plugin install review-changes --marketplace pt-hieu/review-changes
```
(`y` to add the marketplace, then a scope.) A local clone works as a folder marketplace too: `--marketplace <path to this repo>`. A folder marketplace with a relative `source` is read from the folder itself, so after edits `/reload-plugins` picks them up. While developing, use `claude --plugin-dir plugins/review-changes`.
