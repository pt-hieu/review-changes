# review-changes

A Claude Code plugin, and the local marketplace that lists it, that helps you review code changes faster, the way [pulls.review](https://pulls.review) does. It lays a set of changes out for you in a terminal app that opens in a Rex split pane next to your Claude Code session, and it handles thousands of files. It never reviews on your behalf and never changes the code under review.

It replaces an earlier version that rendered the review as a page in the browser. Rex has no web or diff block, so a terminal app is the way to review inside Rex.

## What it does

Each run:

1. Collects one target from the git repo the Claude Code session runs in: uncommitted changes, a branch, a commit, a range, or a pull request of that same repo. The diff goes to a file on disk, so the plugin engine's size caps do not limit it.
2. Has a read-only analyzer subagent (`review-changes:analyzer`, tools Read, Grep and Glob) group the changed files by concern. It reads what you asked for in the session, so it can explain why each change exists in your terms. It summarises each group, draws a small tree of how a group's new pieces connect when they span files, notes what changed and why on files and lines, and flags the spots that deserve the closest look. Every changed file lands in exactly one group, and files the analyzer leaves out go to "Uncategorized".
3. Opens the terminal app in a Rex split pane to the right of the session. It has four lazygit-style panels: a summary, the analyzer's groups, a file tree with reviewed marks, and the diff with word-level highlighting, syntax colours and the analyzer's notes. The pane shows a grouping by directory at once, and the analyzer's groups and notes appear in it when the analyzer finishes.
4. Tells the model, in a short note, how many files changed and which target was opened. The note carries counts and a generic label, never text from the change, because a change's author can steer what the analyzer writes and what paths and branch names say. The analyzer's own finished-notification reaches the model as a fixed one-line message that asks it only to acknowledge the run, so the analysis never lands in the conversation.

## What it does not do

- Fix, edit, or commit code in the repo under review. The analyzer has no write tools.
- Post reviews, comments, or approvals to GitHub or anywhere else.
- Give verdicts ("LGTM", "request changes"), scores, or exhaustive bug hunts. The notes point you at what to look at; you decide.
- Review targets outside the session's current repo.
- Take mouse or wheel input. The app is keyboard-driven.

## Install

The plugin needs [bun](https://bun.sh) on the machine, and Rex for the split pane. From any Claude Code session:

```
/plugin install review-changes --marketplace pt-hieu/review-changes
```

Answer `y` to add the marketplace, then pick a scope.

For development, clone this repo and load the plugin straight from its folder for one session, run from the repo you want to review:

```
claude --plugin-dir <path to this repo>/plugins/review-changes
```

## Usage

```
/review-changes [#pr | --worktree | rev | A...B | A..B]
```

| Target | Reviews |
|---|---|
| (none) | uncommitted changes (tracked and untracked) when there are any, else the current branch against the default branch (`<default>...HEAD`) |
| `--worktree` | uncommitted changes against `HEAD`, including untracked files |
| `#53`, `53`, or `https://github.com/<owner>/<repo>/pull/53` | that pull request of the current repo, via `gh` |
| `A...B` | `B` against its merge base with `A`; an empty side means `HEAD` |
| `A..B` | `B` against `A` directly; an empty side means `HEAD` |
| `<branch>` | that branch against the default branch (`<default>...<branch>`) |
| `<rev>` | that single commit against its parent |

Pull requests need an authenticated `gh`. A pull request URL of another repo is refused. A target of more than 50,000 changed files is refused with a request to narrow it.

Inside a Rex pane, the command opens the review in a split. Running it again when the pane for that target is open and its analysis is current focuses the pane. Outside Rex there is no pane to open, so the command prints the command line to run in another terminal.

When the repo has changes worth reviewing (uncommitted files, or commits ahead of the default branch), a band above the prompt shows them with these buttons:

- **Review in pane** (`v`; **Review** outside Rex): the same as `/review-changes` with no target.
- **Open pane** (`p`): reopens the last review's pane in Rex.
- **Hide**: hides the band.

While a review runs, the band shows its progress, and a toast reports when the analysis landed or the run failed.

### From a shell

Without Claude Code, run the app from the plugin's folder and point it at the repo:

```
cd plugins/review-changes
bun --no-env-file assets/review-changes.js --cwd /path/to/repo [target]
```

Don't run bun from inside a repo you're reviewing. Bun loads `bunfig.toml` and `.env` from the current directory before the app starts, so a malicious change could run code on your machine.

A shell launch has no session behind it, so it has no analyzer groups or notes: the app shows the grouping by directory and says why. To reopen a review the plugin saved, pass its session directory:

```
bun --no-env-file assets/review-changes.js open <session dir>
```

The app needs an interactive terminal.

### Moving around

`1` (summary), `2` (groups) and `3` (diff, the file list with its diff) jump between the panels, and the footer always shows them. The keys you will use most:

| Key | Does |
|---|---|
| `j` / `k`, `g` / `G` | move or scroll, jump to the first or last |
| `ctrl+d` / `ctrl+u` | half page down or up |
| `tab` | switch between the side panels and the diff |
| `enter` | open the selected group or file; in the diff, jump to the code a tree line names |
| `space` | mark a file reviewed or not |
| `u` | next unreviewed file |
| `c` / `C` | next or previous "look closely" spot |
| `m` / `M` | next or previous note |
| `[` / `]` | previous or next group |
| `{` / `}` | previous or next hunk in the diff |
| `J` / `K` | next or previous file in the diff |
| `/` | filter the file list, or search the diff; `n` / `N` step through matches |
| `i` | show or hide notes in the diff |
| `z` | zoom the diff to the full pane |
| `esc` | back |
| `q` | quit |

`?` lists every key for the panel you are in.

## Output

Each review is a session directory at `<git-common-dir>/review-changes/sessions/<slug>/` (for example `.git/review-changes/sessions/pr-53-1a2b3c4d/`) holding the raw `patch.diff`, the analysis, and the session metadata. That is inside the git directory, so it is never committed and never shows up as a change. Reviewed marks live in `<git-common-dir>/review-changes/reviewed/` and follow the file's diff, so they carry over to a re-run on an unchanged file. The app keeps the five most recent sessions of a repo and removes older ones.

## Development

```
bun install
bun run build:tui      # bundles tui/ into plugins/review-changes/assets/
bun run typecheck
bun run test           # plugin tests and tui tests
bun run test:tui       # the app's tests alone
bun run bench:tui      # builds, then measures launch, key latency and memory in a pseudo-terminal
bun run validate       # validates the marketplace and the plugin
```

The app's source lives in `tui/` and is built with `bun build`. Its output, `plugins/review-changes/assets/review-changes.js` and `highlight-worker.js`, is committed, because the plugin runs the bundle directly. Rebuild it after any change under `tui/`.

`DESIGN.md` describes the design in detail; `CLAUDE.md` sets the scope.

## Credits

- [pulls.review](https://github.com/antfu/pulls.review) by Anthony Fu (MIT): the analysis schema, the analyzer prompt, and the target logic are adapted from it.
