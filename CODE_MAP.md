# Code map

## Areas

- `.claude-plugin/marketplace.json` is the local marketplace that lists `./plugins/review-changes`; open it for the marketplace version.
- `plugins/review-changes/` is the plugin the engine loads (what `--plugin-dir` and the marketplace point at).
- `plugins/review-changes/.claude-plugin/plugin.json` holds the plugin's name, version, and its `types` contract path.
- `plugins/review-changes/agents/analyzer.md` declares the read-only agent type `review-changes:analyzer`; open it to change the analyzer's instructions or tools.
- `plugins/review-changes/hooks/` is the engine-side hooks module, and it never reads a diff.
- `plugins/review-changes/hooks/__test__/` holds the hook tests, run by `claude plugin test plugins/review-changes`.
- `plugins/review-changes/types/index.d.ts` declares the plugin's `PluginState` contract.
- `plugins/review-changes/assets/` holds the committed build output of the terminal app.
- `tui/` is the terminal app's source, built with bun and never loaded by the engine.
- `tui/src/collect/` turns a target into a patch file on disk: hardened git runner, pull request fetch, session retention.
- `tui/src/analysis/` holds seed groups, the manifest, the large-diff prompt, answer ingest, and the note index.
- `tui/src/patch/` holds the patch reader, the file and hunk scan, and the per-file line index.
- `tui/src/highlight/` holds the highlighting worker, its client, and the language table.
- `tui/src/main-view/` builds the rows of the diff pane: diff rows, word diff, search, text rows.
- `tui/src/panels/` holds the summary, groups, and files panels, the file tree, the filter, and the key bar.
- `tui/src/view/` holds app state, the keymap, layout, the frame writer, and the runtime loop.
- `tui/src/terminal/` holds raw mode and alt-screen lifecycle, the input parser, and the one output module.
- `tui/src/text/` holds the sanitizer, width tables, word wrapping, and plain Markdown.
- `tui/src/store/` holds reviewed marks.
- `tui/src/session/` loads a saved review.
- `tui/src/review/` holds the target grammar, repository lookups, patch parsing, the analyzer prompt and answer normalizer, and shared review types.
- `tui/dev/` holds the fixture generator and the benchmarks.
- `DESIGN.md` is the design of the mod, with the verified plugin API facts.
- `README.md` is the user-facing description and install guide.

## Entry points

- `plugins/review-changes/hooks/hooks.json` lists the hooks modules the engine loads.
- `plugins/review-changes/hooks/register.tsx` wires the command, band, agent wait, toast, and hand-back handling.
- `plugins/review-changes/hooks/run.ts` runs a review: collect, pane, spawn, wait, ingest.
- `plugins/review-changes/hooks/bun.ts` finds bun and builds the app's argv.
- `plugins/review-changes/hooks/rex.ts` builds the rex split, focus, inspect, and close argv.
- `plugins/review-changes/hooks/types.ts` holds the plugin's string enums.
- `tui/src/main.ts` is the app's entry: open, stat, collect, ingest, candidate, or a direct launch.
- `tui/src/contract.ts` defines the session file contract shared by the app and its callers.
- `tui/src/types.ts` holds the app-level enums.
- `tui/build.ts` is the Bun.build script that writes `plugins/review-changes/assets/`.
- `package.json` holds the bun scripts: build:tui, test, test:tui, typecheck, validate, bench:tui, bench:tui:data.
- `tsconfig.plugin.json` type-checks the hooks module.
- `plugins/review-changes/tsconfig.json` extends the engine-written types config.
- `tui/tsconfig.json` type-checks the app.

## Where to go for a task

- Change what the analyzer is told: `tui/src/review/analysis.ts` builds the prompt and normalizes the answer.
- Change how the app is launched from the engine: `plugins/review-changes/hooks/run.ts` and `plugins/review-changes/hooks/bun.ts`.
- Change the Rex pane behavior: `plugins/review-changes/hooks/rex.ts`.
- Add a review target form: `tui/src/review/target.ts` parses it and `tui/src/collect/resolveTarget.ts` resolves it.
- Change a panel: the file in `tui/src/panels/`, wired through `tui/src/view/`.
- Change a key binding: `tui/src/view/keymap.ts`.
- Change the diff pane's rows: `tui/src/main-view/`.
- Change a version: `plugins/review-changes/.claude-plugin/plugin.json`, the plugin entry in `.claude-plugin/marketplace.json`, and its `metadata.version`.
- After any change under `tui/`, run `bun run build:tui` and commit the rebuilt `plugins/review-changes/assets/`.

## Paths you can predict

- A test sits in a `__test__` folder beside the file it tests and is named after it, as `CODING_STANDARDS.md` states.
- Test helpers sit in the same `__test__` folders, such as `tui/src/review/__test__/fakeGit.ts`.
- A `tui/src/` source file is named in camelCase after what it holds, inside the folder of its area.
- `<git-common-dir>/review-changes/` holds what a review writes, never the working tree.

## Places to skip

- `bun.lock` is written by `bun install`; a search finds it only with `--no-ignore`.
- `plugins/review-changes/assets/review-changes.js` is written by `bun run build:tui` from `tui/src/main.ts`; a search finds it only with `--no-ignore`.
- `plugins/review-changes/assets/highlight-worker.js` is written by `bun run build:tui` from `tui/src/highlight/worker.ts`; a search finds it only with `--no-ignore`.
- `plugins/review-changes/.claude-plugin/types/` is written by the engine and gitignored; read the engine's declaration file only by grep, it is about 21k lines.
