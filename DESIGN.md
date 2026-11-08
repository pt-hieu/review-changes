# review-changes: design

A Claude Code mod (a plugin of function hooks, Claude Code 2.1.292) and the local marketplace that lists it. `/review-changes [target]`, or the band's **Review in pane** button, collects one diff from the git repo the session runs in. A read-only subagent groups the diff the way pulls.review does, and the mod opens a lazygit-style terminal app in a Rex split pane that shows the groups and the diff. The goal and the out-of-scope list are in `CLAUDE.md`. Everything here serves the human's own review. The mod never edits, posts or judges.

The app replaced a browser viewer that wrote one HTML page. Rex has no web or diff block type, so a terminal app is the only way to put a review inside Rex. The terminal app also removed the page's size ceiling, which the rest of this document builds on: a diff of tens of thousands of files never passes through the engine's capped calls.

Ground truth for the plugin API is the engine's declaration file. When the engine loads the plugin it lays that file at `plugins/review-changes/.claude-plugin/types/claude-code/index.d.ts` (gitignored; a copy is already there for type checking). Grep it; it is about 21k lines, so don't read it whole.

## 1. Repo layout

```
review-changes/                         repo root = the marketplace
  .claude-plugin/marketplace.json       lists ./plugins/review-changes
  package.json                          bun scripts: build:tui, test, test:tui, bench:tui, typecheck, validate
  tsconfig.plugin.json                  type-checks the hooks module (outside the plugin folder)
  DESIGN.md  CLAUDE.md  CODING_STANDARDS.md  README.md
  tui/                                  the terminal app's source, built with bun (never loaded by the engine)
    build.ts                            Bun.build script, writes ../plugins/review-changes/assets/; fails on stray stream writes
    tsconfig.json                       type-checks the app
    src/main.ts                         entry: open, stat, collect, ingest, candidate, or a direct launch
    src/collect/                        target → patch file on disk; hardened git runner; pull request fetch; session retention
    src/analysis/                       seed groups, manifest, large-diff prompt, answer ingest, note index
    src/patch/                          patch reader, file and hunk scan, per-file line index
    src/highlight/                      worker client, worker, language table
    src/main-view/                      rows for the diff pane: diff rows, word diff, search, text rows
    src/panels/                         summary, groups and file panels, file tree, filter, key bar
    src/view/                           app state, keymap, layout, frame writer, runtime loop
    src/terminal/                       raw mode and alt-screen lifecycle, input parser, the one output module
    src/text/                           the sanitizer, width tables, wrapping, plain Markdown
    src/store/                          reviewed marks
    src/session/                        loads a saved review
    src/review/                         target grammar, repository lookups, patch parsing, analyzer prompt and answer normalizer, shared types
    dev/                                fixture generator and the benchmarks
    src/**/__test__/*.test.ts           `bun run test:tui`
  plugins/review-changes/               the plugin (what --plugin-dir and the marketplace point at)
    .claude-plugin/plugin.json
    .claude-plugin/types/               engine-written, gitignored
    agents/analyzer.md                  agent type `review-changes:analyzer`
    assets/review-changes.js            committed build output: the app
    assets/highlight-worker.js          committed build output: the highlighting worker
    hooks/hooks.json                    { "modules": ["./register.tsx"] }
    hooks/register.tsx                  wiring: command, band, agent wait, toast, hand-back handling
    hooks/run.ts                        the run: collect → pane → spawn → wait → ingest
    hooks/bun.ts                        finds bun; builds the app's argv
    hooks/rex.ts                        builds the rex split, focus, inspect and close argv
    hooks/types.ts                      the plugin's string enums
    types/index.d.ts                    PluginState contract ('review-changes')
    hooks/__test__/*.test.ts(x)         `claude plugin test plugins/review-changes`
```

Rules the engine imposes on `hooks/`: every module is ES, imported by a static `import` (no `import()`), named `.ts/.tsx/...`. The environment has no DOM and no Node: no `process`, `Buffer`, `fs`, `path`. Web APIs exist (`TextEncoder`, `crypto.subtle`, `URL`). Everything else goes through `$`. JSX factory is `h`, and elements come from `$.ui.resolve(e)`.

`hooks/` never reads a diff. It starts the app's CLI and hands text between the engine and the app (section 3.1). Code that has to know git, targets, patches or the analysis shape lives in `tui/`, where it runs in bun with the full runtime.

Everything a review writes lands in `<git-common-dir>/review-changes/`: `sessions/<slug>/` (the patch, the session metadata, the analysis, and a manifest for large diffs), `reviewed/` (reviewed marks) and `tmp/` (scratch for a run in flight). It never lands in the working tree.

## 2. Verified plugin API facts (2.1.292)

| Need | API (exact) |
|---|---|
| plugin root (assets) | `$.plugin.root` (absolute dir holding `.claude-plugin/`; the plugin directory is that path without the `.claude-plugin` suffix) |
| session cwd | `await $.session.cwd()` (absolute). `$.session.repo()` → `{ root, remote, internal, name }` or null (root is the MAIN worktree's; use git for the current worktree) |
| command | in `session.start`: `await $.command.register({ name: 'review-changes', description, argumentHint: '[#pr | --worktree | rev | A...B | A..B]' })`, then `on('command.run', { command: 'review-changes' }, async ($, e) => ({ text }))`, with `e.args` = everything after the name. Answering without `next` = "answers its own command" (not a gate). |
| band | `on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => ...)`. `e.props`: `hasSurvey`, `isWorking`, `maxRows`, `bodyColumns`, `scroll`, `view`. Yield with `return next(e)` when `e.props.hasSurvey` or nothing to show. `const { Box, Text, Button } = $.ui.resolve(e)`. |
| Button | props `key`, `label`, `hotkey` (one digit/lowercase letter), `variant: 'primary'`, `dimColor`, `onPress: (pressEvent) => void` (runs in plugin env; do not await long work in it, start it with `void`). |
| state | `import { atom, read, update } from 'claude-code'`; `const candidate = atom({ plugin: 'review-changes', key: 'candidate' } as const, null)`; read while drawing with `await read($, candidate)` (subscribes); write from handlers/events with `await update($, candidate, () => value)`. Never `$.state.set` while drawing (denied). |
| process | `$.process.run(argv, { cwd?, env?, stdin?, timeoutMs? })` → `{ exitCode, stdout, stderr, isStdoutTruncated, isStderrTruncated }`. No shell; any exit code resolves; rejects only when it cannot start or times out (default 30 s, max 600 000). stdout capped at 4 MiB. |
| env | `await $.env.get('REX_BLOCK')`, `REX_SESSION`, `REX_BIN_DIR`, `HOME`: how the mod learns it runs inside Rex. |
| fs | `$.fs.read(path)` → text, `$.fs.write(path, text)`, `exists`, `list`, `stat`. **No mkdir and no delete.** **Read/write over 4 MiB rejects.** The mod does not use `$.fs` for review data. |
| agent type | `agents/analyzer.md` declares `review-changes:analyzer` (frontmatter as an agent file). Hide it from the main model: `on('agent.offer', { agent: 'review-changes:analyzer' }, () => ({ isOffered: false }))`. The plugin's own spawn still runs. |
| spawn | `$.agent.spawn({ prompt, description, subagentType: 'review-changes:analyzer', cwd? , model? })` resolves once STARTED with `{ model, agentId }` or `{ deny }`. A plugin's spawn always runs in the background. The answer arrives as that agent's `turn.complete`: `on('turn.complete', ($, e, next) => ...)` with `e.agentId === agentId`, `e.answer` (final text), `e.reason: 'answer'|'aborted'|'refusal'|'error'`. Always `return next(e)`. There is no structured output: parse JSON out of `e.answer`. |
| hand-back | When the subagent ends, the engine delivers a peer message to the main conversation. `on('session.receive', ...)` can answer `{ consumed: reason }` for it, and `on('session.append', ...)` can rewrite its content before it is stored. The mod uses the second to replace the analysis text with a fixed acknowledgement request (section 12). |
| toast | `$.ui.toast(text, { timeoutMs })`: default 4000. The mod never calls `$.ui.status`: the band already shows the run. |
| timers | `$.clock.every(ms, fn)` / `$.clock.after(ms, fn)` return `{ cancel() }`; dropped on hot reload. `$` captured by a hook stays usable after the hook returns. |
| budget | 10 s per hook dispatch, **excluding time awaiting `$` calls**. Awaiting a plain promise (the agent's answer) counts, so the command hook must not await the analysis: it returns after the spawn and the rest continues in the background. |
| reload | Module variables are lost on hot reload; `$.state` values survive. A `session.start` hook runs once per session. |
| tools on this build | Native macOS build registers `Read` but **not `Grep`/`Glob`**. List all three; the analyzer reads files by path where search is missing. |
| tests | `claude plugin test <dir>` runs `*.test.ts(x)` with `import { test, describe, expect, mock } from 'claude-code/testing'`. Body `($, on)`: `on(...)` hooks sit BENEATH the plugin and stand for the engine. Op events answer `{ value }`: `on('process.run', ($, e) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))`, `on('session.cwd', () => ({ value: '/repo' }))`, `on('command.register', ($, e) => ({ value: { command: e.name } }))`. Drive with `await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })`, then `await $.command.run({ command: 'review-changes', args: '', origin: { kind: 'composer' } as never, presentation: { isFullscreen: false, columns: 80 } })`. A UI test mounts: `await $.ui.mount({ plugin: 'review-changes', surface, component: 'AbovePrompt', props })`, then `ui.find({ key })` / `ui.press({ key })`. **Verified gotcha:** a test's `agent.spawn` hook cannot hand an `agentId` up (the plugin receives `{ model: 'inherit' }` only), so the spawn→answer path is not testable in the harness. Keep it a thin shell around functions that take their effects as closures. |
| validate | `claude plugin validate .` (marketplace) and `claude plugin validate plugins/review-changes` (manifest, `types` contract, hooks, calls). |

## 3. Targets and collection

### 3.1 Why collection goes through the app's CLI

The engine caps what a plugin can move: `$.process.run` keeps 4 MiB of stdout, and `$.fs.read` and `$.fs.write` reject above 4 MiB. A diff of thousands of files is hundreds of megabytes, so the mod never sees one. Collection runs inside the app's own CLI, which the mod starts with `$.process.run`:

```
bun --no-env-file <plugin>/assets/review-changes.js collect --cwd <session cwd>
    stdin: { "target": "<argument text>", "messages": [ { "role", "text" } ] }
    stdout: one JSON line, the result
```

- The CLI runs git with its stdout pointed at a file, so the diff streams to disk without passing through a pipe the engine reads. The mod receives only the result line: the review directory, the review id, counts, labels, and the analyzer prompt.
- The analysis returns the same way. When the analyzer finishes, the mod pipes its answer to `review-changes.js ingest <review dir> --review-id <id>` on stdin (or passes `--failed <reason>` when the analyzer gave none), and the CLI validates and stores it. The mod never parses it.
- The pane process reads everything from the review directory, so nothing else crosses the engine.
- The mod runs the CLI with the plugin's own directory as cwd and a 600 000 ms timeout (the maximum). Its other calls, `candidate` for the band and the rex commands, are short.

`candidate --cwd <dir>` prints the band's one-line summary, or `null`.

### 3.2 Grammar (pure)

```ts
export type TargetRequest =
  | { kind: TargetRequestKind.Auto }                   // "" (whitespace only)
  | { kind: TargetRequestKind.Worktree }               // "--worktree"
  | { kind: TargetRequestKind.PullRequest; number: number; url?: { owner: string; name: string } }
  | { kind: TargetRequestKind.Range; base: string; head: string; isMergeBase: boolean }
  | { kind: TargetRequestKind.Revision; revision: string } // a branch or a single commit; resolution tells which
```

Rules, in order, on `text.trim()`:
1. `""` → `auto`.
2. `--worktree` → `worktree`. Any other token starting with `-` → `TargetError` (message and usage for the person).
3. `^#?(\d+)$` → `pull-request` with that number (a positive integer).
4. `^https?://github\.com/([^/]+)/([^/]+)/pull/(\d+)(?:[/?#].*)?$` → `pull-request` with `url: { owner, name }` (name without a trailing `.git`).
5. Contains `...` → `range`, `isMergeBase: true`. Else contains `..` → `range`, `isMergeBase: false`. An empty side means `HEAD`. A side starting with `-` → `TargetError`.
6. More than one whitespace-separated token → `TargetError`.
7. Otherwise → `revision`.

### 3.3 Resolution and the diff command

Git runs through a hardened runner (section 12): its environment is scrubbed of the caller's git variables, hooks and the filesystem monitor are off, and prompts are off. A diff command writes to a file:

```
git -c core.quotePath=false diff --no-color --no-ext-diff --no-textconv --full-index -M -l1000 -O/dev/null
    --submodule=short --ignore-submodules=none --no-relative --src-prefix=a/ --dst-prefix=b/
    --end-of-options <revisions>
```

`--no-textconv` and `--no-ext-diff` keep repo-configured programs from running; `--end-of-options` keeps a revision from being read as a flag. A diff over 4 GiB is killed and refused, and a diff of more than 50,000 changed files is refused with a request to narrow the target.

- **Repo**: `git rev-parse --show-toplevel` at the session cwd. A non-zero exit refuses with `Not inside a git repository`. `repository.name` is `owner/name` parsed from `git remote get-url origin` when that is a github.com URL, else the root's basename.
- **Default branch**: `refs/remotes/origin/HEAD`, else the first of `main`, `master`, `origin/main`, `origin/master` that verifies as a commit.
- **auto**: worktree if `git status --porcelain=v1 -z --untracked-files=all` prints anything. Otherwise, with a default branch and commits ahead of it, the range `<default>...HEAD`. Otherwise refuse with `Nothing to review`.
- **worktree**: copies the repo's index to a scratch file, points the object directory at a scratch directory (with the repo's objects as an alternate), and runs `git add --intent-to-add -- .` against that copy. The diff against `HEAD` (or the empty tree when HEAD is unborn) then holds tracked and untracked files alike, and the repo's own index and object store are untouched. Key `worktree`, label `Uncommitted changes on <branch|detached HEAD>`.
- **range** `A...B` / `A..B`: each side must verify as a commit. The commit list is `git log --reverse` from the merge base (for `...`) or from `A` (for `..`) to `B`. Key `range-A...B`, label `B vs A`.
- **revision**: a name that is a local or remote branch resolves as the range `<default>...<rev>` (no default branch refuses). Anything else must verify as a commit and is diffed against its first parent, or the empty tree for a root commit. Key `commit-<sha first 12>`, label `<rev> (<sha first 7>)`.
- **pull-request**: `gh repo view` names the repo, and a URL of another repo is refused. `gh pr view <n> --json ...` supplies the title, body, author, refs, commits, both head and base object ids and the changed-file count. Then the diff comes from the first route that applies:
  1. both commits exist locally: `git diff <base>...<head>`;
  2. the pull request has at most 300 changed files: `gh pr diff <n> --color=never`, streamed to the file;
  3. otherwise (GitHub refuses large diffs with a 406): in a non-shallow clone with a remote that points at the repo, fetch the base and `refs/pull/<n>/head` into a scratch object directory that borrows the repo's objects, diff there, and delete the scratch. A shallow clone, or a clone with no matching remote, refuses with a message that says what to fix.
  Key `pr-<n>`, label `#<n> <headRef> → <baseRef>`. `gh` failures carry gh's first stderr line.
- Title and description are cut to 300 and 20 000 characters, and the label to 80 characters with invisible characters removed.

A review's slug is the key made file-name safe (`[^A-Za-z0-9._-]+` → `-`, 80 characters) plus eight hex digits of a hash of the key and the repo root, so two repos with the same key do not collide.

## 4. The patch index

The patch file is the source of truth, and the app keeps a few numbers per file, not the text.

- **Scan** (`patch/`): one pass over the file in 1 MiB reads, byte level, no string decoding. For each file it records the byte offset, path, previous path, status, flags (binary, generated, mode-only), additions, deletions, row count and a review key; for each hunk it records the old and new start and length. The result is a table of typed arrays, so 20 000 files cost a few megabytes. Costly-to-rescan hunk tables of huge files are retained; others are rescanned on demand.
- **Review key**: a hash of the start of the file's diff (its header lines), seeded by a random per-repo seed. Reviewed marks are stored under it, so a mark follows a file whose diff has not changed.
- **Line index**: built per file when it is first shown, in short slices so a key is never stuck behind it. It records row starts, row kinds and checkpoints of the old and new line numbers every 256 rows. It stops at 8 000 000 rows per file and says so; a file with a single line of hundreds of megabytes costs one row.
- **Reads**: `PatchReader` reads the file by byte offset through a cache of 64 blocks of 256 KiB each. Row text is cut out of those blocks and decoded only for the rows on screen, with the cut moved off a split UTF-8 character.

Generated paths (lockfiles, `dist/`, minified files, snapshots) and binary files are flagged at scan time and skipped by the analyzer and the highlighter.

## 5. Analysis

### 5.1 Agent (`agents/analyzer.md`)

```
---
name: analyzer
description: Groups a diff of the current repository into review groups for review-changes. Used only by the review-changes plugin.
tools: Read, Grep, Glob
model: sonnet
maxTurns: 40
---
<system prompt>
```

The system prompt adapts pulls.review's `ROLE_SECTION` + `grouping_principles` + `OUTPUT_SECTION` (MIT, credit in README), with these changes:
- No `children` (groups are flat).
- The workflow: (1) read the manifest and form a grouping hypothesis; (2) Read files of the repository only where the hunks are not enough, and the patch file only when the diffs are not inline; never read `[generated]`/`[binary]` paths; never modify anything; (3) answer with ONE fenced ```json block holding the analysis and nothing else.
- It writes notes that explain what changed and why, and sets `critical` only where the human should look most carefully. **No verdicts, no scores, no approval language, no fix suggestions written as patches.**
- A `<user_requests>` section: when the prompt lists the user's requests, the "why" of a group is written in the human's terms. The requests explain the change; they are not a checklist to grade it against.
- An optional per-group `visual`: an indented tree (call tree, file tree, component tree or pseudocode) of at most 40 lines, drawn only when the shape spans more than one file or several distant hunks. Column 0 of each line is `+`, `-` or a space; two spaces per level follow; a trailing `(path:line)` or `(path)` ties the line to the code.
- A closing section for large diffs: when the message holds a `---SEED GROUPS---` section, the analyzer groups seeds, not files, and reads the patch only through offsets from the manifest.
- It embeds the JSON shape below verbatim.

```json
{
  "overallSummary": "string, Markdown, 1-3 sentences, why over what",
  "groups": [{
    "key": "kebab-case, unique",
    "label": "<= 4 words",
    "category": "ui|api|core|data|cli|security|tests|docs|examples|deps|build|scripts|config|i18n|assets|other",
    "summary": "Markdown, 1-3 sentences, why over what",
    "filePaths": ["every manifest path in exactly one group"],
    "seeds": ["seed-3"],
    "fileNotes": [{ "path": "...", "text": "...", "critical": true }],
    "lineNotes": [{ "path": "...", "side": "additions|deletions", "line": 12, "text": "...", "critical": true }],
    "visual": { "caption": "...", "lines": [" handle (src/api/routes.ts)", "+  GET /notes/search → searchNotes (src/api/routes.ts:7)"] },
    "critical": true
  }]
}
```

`seeds`, `fileNotes`, `lineNotes`, `visual` and `critical` are optional and used sparingly. The model writes `visual.lines` as indented text because it indents reliably and counts depth poorly; ingest turns them into structured lines, so the prompt syntax can change without a stored-schema change.

### 5.2 Two prompt tiers

`collect` builds the analyzer prompt:

- **Small** (at most 1 000 files and 4 MiB of patch, and a prompt of at most 256 KiB characters): `Title:`, `Target: <label>`, PR URL, `---DESCRIPTION---`, `---USER REQUESTS--- (N, oldest first)` (only when there are requests), `---COMMITS---` (only when more than one), `---MANIFEST--- (N files, +A/-D)` grouped by directory with a status, counts and a `[generated]`/`[binary]` mark per file, then `---DIFFS---` with every file's hunks, and a closing instruction to answer with one fenced json block.
- **Large** (anything bigger): the files are first bucketed into **seed groups** by directory, with tests, docs, assets and generated files split out and each seed capped at 200 files (at most 40 seeds). The prompt lists the seeds with counts and their top files, and points at `manifest.tsv`, one JSON-quoted path per row with its patch line start, patch line count and patch byte count. The analyzer groups seeds, reads at most 30 slices of the patch by offset and limit, and skips any entry over 262 144 bytes.

User requests come from the session's user-role messages, oldest first. `<system-reminder>` blocks and the plugin's own command invocations are stripped, each request is cut to 4 000 characters, and past 12 000 in total the first request and as many of the newest as fit are kept.

### 5.3 Ingest

`ingest` reads the analyzer's answer on stdin:

- Take the last fenced ```json block, else the substring from the first `{` to the last `}`, and `JSON.parse`. Not an object with a `groups` array → the review keeps the seed grouping and records the failure reason.
- **Normalisation** (always applied):
  - `overallSummary` not a string → "".
  - Each group: a non-string key/label → derive (`group-<i>`, `Group <i>`); key kebab-cased and de-duplicated with `-2`, `-3`; category outside the list → `other`; summary not a string → "".
  - `filePaths`: keep only paths of the patch, first occurrence across groups wins. A listed seed brings its files, and a path moved out with `filePaths` leaves its seed.
  - fileNotes/lineNotes: keep only those whose path is in THAT group's kept files and whose `text` is a non-empty string. A note pointing at a file of another group moves to that group. `critical` kept only when `=== true`.
  - lineNote: `line` must be an integer inside a hunk of its side (additions: `newStart ≤ line < newStart + newLines`; deletions: same with old). Otherwise it becomes a fileNote `"(line <n>) <text>"`. Hunks are read from the patch only for the paths that lineNotes and visuals name.
  - `visual`: kept only with a `lines` array. Non-string and blank lines are dropped, at most 40 are kept. Per line: tabs become two spaces; column 0 gives `change` (`+` added, `-` removed, anything else unchanged); depth is the indentation minus the smallest one, divided by the smallest non-zero step. A trailing `(path:line)` or `(path)` whose path is in the patch becomes `anchor` and leaves the text. A token naming no changed file stays in the text.
  - Drop groups left with no files. Files in no group → a final group `Uncategorized` (`other`), in patch order.
- The result is written to `analysis.json` through a temporary file and a rename. The `--review-id` must match the session's, so a late answer for an older run is refused.

Before an analysis lands, `analysis.json` holds the seed grouping with status `pending`. A failure leaves the seed grouping in place, with the reason shown in the summary panel. The pane notices when the file changes and loads the analysis, and it stops showing the pending state after 16 minutes.

## 6. The app

### 6.1 Data pipeline

```
git diff ──► patch.diff (file) ──► scan ──► file table + hunk tables (typed arrays)
                                     │
analyzer answer ──► ingest ──► analysis.json (groups, notes, visuals)
                                     │
pane process: load table + analysis ──► per-file line index (on demand)
                                     ──► rows for the viewport (materialised on demand)
                                     ──► sanitizer ──► frame writer ──► terminal
                                     └─► highlight worker (colours, off the input path)
```

### 6.2 Lazy reads and viewport-only rows

- The pane process opens the patch by file descriptor and never holds the diff in memory. A frame asks the main view for a window of rows; the view reads those rows' bytes from the patch (section 4), builds display text for them alone, and drops them after the frame.
- The file list, the group list and the tree are views over the typed tables. A list of 20 000 files draws the rows on screen, and the filter works on the table's paths without building a row for every file.
- Word-level diffs are computed for the visible changed rows only.
- The frame writer keeps the last frame and writes only the parts that changed, inside synchronised-output markers so the terminal presents a frame at once.

### 6.3 Highlighting off the input path

Syntax colour comes from a worker (`assets/highlight-worker.js`) that opens the patch itself by path and inode, so no text crosses the thread boundary. The main thread requests a window of rows for a file; the worker returns colour runs as typed arrays, and the main thread repaints when they arrive. Keys never wait for it: a row with no runs yet draws plain.

- Chunks of 256 rows, queued by recency, cached up to 8 MiB.
- Binary, generated, unknown-language and over-8-MiB files are never sent.
- The client stops a job that runs over a second, restarts the worker when its memory passes 220 MiB, and turns highlighting off for the session after two worker failures.

### 6.4 The sanitizer choke point

All text on the screen comes from `sanitizeLine`, which returns a branded display type. The row source, the frame writer and the width helpers accept only that type, so a raw string cannot be drawn: the compiler refuses it. A literal with fixed text goes through `trustedLiteral`, which throws on any control or invisible character. See section 12 for what the sanitizer neutralises.

### 6.5 Interaction

Panels: summary (`1`), groups (`2`), files and diff (`3`, `0` focuses the diff). The keymap is a table of bindings per panel; the footer shows the highest-priority bindings of the focused panel, with `1`, `2`, `3` always first, and `?` lists them all. Review marks are appended to a per-repo log under `reviewed/` and loaded at launch.

The app uses the alternate screen with raw mode and bracketed paste, and turns line wrap off. It does not enable mouse reporting. It handles the resize, suspend and continue signals. `Z` runs `rex zoom` for the pane when `REX_BIN_DIR` is set.

## 7. Mod flow (`hooks/run.ts` + `hooks/register.tsx`)

The engine follows `$` only into functions declared in the same file as the hook, never across an import. So `run.ts` never takes `$`: it drives an engine object of closures (process runner, environment, session cwd and messages, analyzer spawn, clock, toast, state reads and writes) that `register.tsx` builds. Tests drive `run.ts` through an in-memory engine.

State atoms (contract in `types/index.d.ts`): `candidate` (the band's summary), `run` (id, label, phase `collecting` or `analyzing`), `pane` (review directory, repo root, label, Rex block id) and `isHidden`.

### register.tsx
1. `session.start`: register the command, reset `run`, refresh the candidate (the CLI's `candidate`, written only when the summary changed), and refresh it every 20 s.
2. `agent.offer` for `review-changes:analyzer` → not offered.
3. `session.receive` and `session.append`: the analyzer's hand-back (section 12).
4. `turn.complete`: deliver an agent's answer to its waiter, or refresh the candidate for the main conversation.
5. `command.run`: `startReview(args)`; the toast carries the person-facing message and the command answer carries the model-facing text.
6. `ui.render` for `AbovePrompt`: yields when there is a survey or the band is hidden. Otherwise one row: progress while a run is active, else the candidate's summary with **Review in pane** (`v`; **Review** outside Rex), **Open pane** (`p`, when a pane is known and the session is in Rex) and **Hide**.

### run.ts
1. A second run while one is active answers `A review is already running`.
2. Read the user-role messages of the session (each cut to 4 001 characters), find bun, check that the app bundle exists, and call `collect` (section 3.1). If bun fails to start, forget the cached path and look once more.
3. A result that is not collected answers with its message. The person sees the detailed one; the model gets a generic one.
4. Show the pane (below). Then, if the analysis is already current (same patch digest, ready analysis), stop: the run is done.
5. Otherwise spawn the analyzer with the prompt `collect` returned, `cwd` the repo root. A denied or failed spawn goes straight to the failure path. Phase `analyzing`, and the command returns; the rest continues in the background.
6. Wait up to 15 minutes for the answer, then call `ingest` with it (or with `--failed <reason>` when the analyzer ended without an answer). Toast `Analysis landed for <label>` or the failure. Clear the run and refresh the candidate.

Showing the pane:
- Outside Rex (no `REX_BLOCK` or `REX_SESSION`): remember the review and put the open command line in the answer.
- Inside Rex: if a pane from an earlier run is alive (`rex block inspect`), focus it when it shows this review with a current analysis, and close it otherwise. Then `rex split -s <session> -b <block> --split=right --ratio 70 --label review-changes --shell=none -c <plugin directory> --json -- bun --no-env-file <bundle> open <review dir>`, and keep the block id it returns. A failure to split falls back to the command line.

The answer to the model is built from counts and the generic label only (section 12). **Open pane** focuses the stored block, or splits a new one for the stored review.

## 8. Error handling summary

| Situation | What the person sees |
|---|---|
| bad argument | command output: message + usage |
| not a repo / unknown rev / nothing to review / PR of another repo / gh missing or unauthenticated / more than 50 000 files / diff over 4 GiB | command output (or toast from the button): the message |
| bun missing | command output with where to get bun |
| app bundle missing | command output asking for `bun run build:tui` |
| no Rex around, or the split fails | command output with the line to run in another terminal |
| spawn denied / analyzer error / aborted / timeout / unparseable answer | the pane keeps the grouping by directory and shows the reason in the summary panel; toast with the failure |
| a second run while one runs | "A review is already running" |
| the app crashes | the screen is restored; the error text is in `crash.log` in the review directory |

## 9. Tests (behaviours only; no change detectors)

Every expected value is written out by hand. The fakes are a command runner keyed by argv and harness hooks beneath the plugin. Nothing asserts that "X was called". `CODING_STANDARDS.md` has the rules.

- `plugins/review-changes/hooks/__test__/` (`claude plugin test`): the run's phases through an in-memory engine (collect refusal, Rex and no-Rex outcomes, analysis already current, answer to ingest, failure to ingest), the Rex argv, the bun lookup, and the harness test of the command, the band on `terminal` and `desktop`, and the hand-back handling.
- `tui/src/**/__test__/` (`bun run test:tui`, bun's runner): target grammar and git resolution against a fake runner; the command runner's environment scrubbing and size caps; pull request routing; the patch scan against hand-written patches (modified, new, deleted, renamed, binary, quoted paths, a huge line); the line index and its row cap; ingest normalisation (unknown paths, duplicates, leftovers, notes outside hunks, visuals); the large prompt; the sanitizer (escape sequences, bidirectional controls, joiners, combining marks, width); the input parser (split sequences, paste); word diff; the filter; the frame writer's diff of frames.
- The viewport, the worker and the full UI have no unit tests; `bun run bench:tui` drives the real bundle in a pseudo-terminal (section 13).

## 10. Checks (run once, before handing back)

```
bun install
bun run build:tui               # writes plugins/review-changes/assets/review-changes.js and highlight-worker.js; fails over 3 MiB
bun run typecheck               # the plugin's hooks and the app, each with its own tsconfig
bun run test                    # claude plugin test plugins/review-changes && bun run test:tui
bun run validate                # claude plugin validate . && claude plugin validate plugins/review-changes
bun run bench:tui               # when the app's drawing, scanning or highlighting changed
```

`build:tui` also fails when any file under `tui/src` other than the output module and the entry writes to a stream, so the sanitizer's choke point stays the only way to the screen.

`tsconfig.plugin.json` (root, outside the plugin) has the header's options + `allowImportingTsExtensions` and includes the plugin's `.claude-plugin/types`, `hooks` and `types`. `tui/tsconfig.json`: `lib: ["es2023"]`, `moduleResolution: "bundler"`, `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `types: ["bun"]`.

E2E (manual): inside a Rex pane, from a repo with an open pull request, `claude --plugin-dir <path to this repo>/plugins/review-changes`, then `/review-changes #<number>`. Expect a split pane, the groups appearing when the analyzer finishes, and a session directory under `.git/review-changes/sessions/`.

## 11. Install

```
/plugin install review-changes --marketplace pt-hieu/review-changes
```
(`y` to add the marketplace, then a scope.) A local clone works as a folder marketplace too: `--marketplace <path to this repo>`. A folder marketplace with a relative `source` is read from the folder itself, so after edits `/reload-plugins` picks them up. While developing, use `claude --plugin-dir plugins/review-changes`. The plugin needs bun on the machine; it looks for `bun` on the path, then `~/.bun/bin/bun`, `/opt/homebrew/bin/bun` and `/usr/local/bin/bun`.

## 12. Security model

Everything in a diff is chosen by the author of the change: file contents, paths, branch names, commit messages, the pull request title and body. The analyzer reads it, so what the analyzer writes is chosen by the author too. The reviewer is the one person who must never be surprised by it.

- **Terminal escapes.** Raw escape sequences in a diff could move the cursor, rewrite the screen, set the title, or ask the terminal to answer with text. The sanitizer (section 6.4) turns every C0 control and DEL into its visible control picture, shows invisible, bidirectional-override and other format characters as `<U+XXXX>` (bidirectional ones highlighted as warnings), caps combining marks per base character, expands tabs, and keeps the width tables the layout uses in step with what it emits. A joiner between two pictographs is the one invisible character that passes. Input has the same care: a paste is cut at 4 096 characters, an escape sequence at 64 bytes.
- **Where bun reads configuration.** Bun loads `.env` and `bunfig.toml` from the current directory. The mod therefore never runs the app with the repo as its cwd: every launch uses the plugin directory (the app receives the repo through `--cwd`), and every launch passes `--no-env-file`. The bun lookup runs in the plugin directory too. A shell launch is the user's own command, so bun can't be protected from inside the app: running it in the repo lets that repo's `bunfig.toml` preload run. The README therefore tells users to start it from the plugin directory with `--no-env-file` and `--cwd <repo>`.
- **Git.** A repo can configure hooks, a filesystem monitor, external diff drivers, text conversion and pagers. The runner drops the inherited `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, object-directory, config, external-diff, exec-path, template, attribute and pager variables, then sets `GIT_CONFIG_*` to turn `core.hooksPath` to `/dev/null` and `core.fsmonitor` off, turns off optional locks and terminal prompts, and sets `LC_ALL=C`. Diffs use `--no-ext-diff`, `--no-textconv` and `--end-of-options`. The worktree and pull request routes work on scratch copies of the index and object store, so a review never writes to the repo's own.
- **Files.** Session, reviewed and scratch directories are created with mode `0700`. A session's patch file name is checked against a strict pattern when loaded. Pruning removes only direct children of the sessions directory, checked by real path. Reviewed-mark lines are length-checked and parsed as exact shapes; the store is capped at 256 MiB.
- **What the main model sees.** The model gets the command's answer, built from the file count, the additions and deletions, and a generic label (`uncommitted changes`, `pull request #12`, `commit abc1234`, `the requested range`), never a branch name, title or path. It never sees the analysis. The analyzer is hidden from the model (`agent.offer`), its hand-back message is consumed in the main conversation when it arrives as a user turn and rewritten to a fixed sentence when it is stored, and that sentence asks the model to acknowledge in one line. The person-facing toast may carry the full label and error text, cut to one line of at most 120 characters with invisible characters removed.
- **The analyzer.** It has Read, Grep and Glob and no write tools, so a diff that tries to steer it can only change what it writes. Its answer is validated and normalised before anything uses it, and every text field of it goes through the sanitizer when drawn.

## 13. Performance

The app aims to answer a key before the next frame at 60 Hz, to open fast, and to stay inside a fixed memory ceiling however large the diff. `bun run bench:tui` builds the bundle, generates fixture diffs, drives the real bundle in a 140x40 pseudo-terminal, and prints each measurement with its budget and `ok` or `FAIL`. It exits non-zero when any budget fails.

| Measurement | Budget |
|---|---|
| launch to first frame | 300 ms for the baseline fixture, 1 000 ms for the others |
| key to frame in the diff or the list, p95 / p99 | 16 ms / 33 ms |
| jump to the last or the first file | 50 ms |
| one filter keystroke, worst | 16 ms |
| resident memory | 250 MiB |
| keys that got no frame, of 300 | at most 15 (baseline and stress only) |

Fixtures: `baseline` (5 000 files, about 100 MiB of patch), `stress` (20 000 files, about 500 MiB), `short-lines`, `big-file` (one file of 200 000 changed lines), `long-line` (1 MiB on a line), `huge-line` (300 MiB on a line) and `entries` (50 000 changed files). `bun run bench:tui:data` measures the scan, the line index and the reviewed store without a terminal, against a similar set of budgets. Generating the larger fixtures takes a while.

Measured on 2026-11-08, in a 140x40 pseudo-terminal with a warm page cache: `baseline` launched in 102 ms and `stress` in 328 ms, scroll key latency at p95 was about 5 ms, and resident memory was about 196 MiB. Those are one run on one machine; re-measure before relying on them.

What keeps the numbers flat is that no cost grows with the diff after launch except the scan itself: a frame touches the rows on screen, a file switch reads one file's index, and highlighting runs elsewhere.

## 14. Known limits

- The app takes no mouse or wheel input.
- A file indexes at most 8 000 000 rows; the diff pane says when rows were cut.
- More than 50 000 changed files, or a diff over 4 GiB, is refused.
- The app restores the terminal on every signal it can catch, and on a crash. A signal that cannot be caught (SIGKILL) leaves the terminal in the alternate screen with raw mode on; `reset` or closing the pane fixes it.
- Highlighting skips files over 8 MiB of patch and unknown languages.

## 15. Not yet verified

- The pull request routes against a real remote: the large-diff fetch path, and the shallow and no-matching-remote refusals, have only run against fakes.
- The analyzer path ran live once, on 2026-11-08: a real session produced groups and a summary. The failure and timeout paths have run only against fakes.
- Behaviour on terminals other than Rex's.
