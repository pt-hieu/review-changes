# review-changes

A Claude Code plugin, and the local marketplace that lists it, that helps you review code changes faster, the way [pulls.review](https://pulls.review) does. It lays a set of changes out for you to read. It never reviews on your behalf and never changes the code under review.

## What it does

Each run:

1. Collects one target from the git repo the Claude Code session runs in: uncommitted changes, a branch, a commit, a range, or a pull request of that same repo.
2. Has a read-only analyzer subagent (`review-changes:analyzer`, tools Read, Grep and Glob) group the changed files by concern. It reads what you asked for in the session, so it can explain why each change exists in your terms. It summarises each group, draws a small tree of how a group's new pieces connect when they span files, notes what changed and why on files and lines, and flags the spots that deserve the closest look. Every changed file lands in exactly one group, and files the analyzer leaves out go to "Uncategorized".
3. Writes one self-contained HTML page and opens it in the default browser. The page renders the diffs with [@pierre/diffs](https://diffs.com) and works offline. It has groups, trees whose lines jump to the code they name, file notes, inline line notes, a split/unified toggle, light and dark themes, and "reviewed" checkboxes that persist per file content.
4. Adds a short note to the session: the overall summary, the "review carefully" items, and the page's path. The model gets the same note fenced off as untrusted data, because a change's author can steer what the analyzer writes. It also asks the model to point you to the page rather than review the change itself.

## What it does not do

- Fix, edit, or commit code in the repo under review. The analyzer has no write tools.
- Post reviews, comments, or approvals to GitHub or anywhere else.
- Give verdicts ("LGTM", "request changes"), scores, or exhaustive bug hunts. The notes point you at what to look at; you decide.
- Review targets outside the session's current repo.

## Install

From any Claude Code session:

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
/review-changes [target]
```

| Target | Reviews |
|---|---|
| (none) | uncommitted changes (tracked and untracked) when there are any, else the current branch against the default branch (`<default>...HEAD`) |
| `--worktree` | uncommitted changes against `HEAD`, including untracked files |
| `#53`, `53`, or `https://github.com/<owner>/<repo>/pull/53` | that pull request of the current repo, via `gh pr diff` and `gh pr view` |
| `A...B` | `B` against its merge base with `A`; an empty side means `HEAD` |
| `A..B` | `B` against `A` directly; an empty side means `HEAD` |
| `<branch>` | that branch against the default branch (`<default>...<branch>`) |
| `<rev>` | that single commit against its parent |

Pull requests need an authenticated `gh`. A pull request URL of another repo is refused.

When the repo has changes worth reviewing (uncommitted files, or commits ahead of the default branch), a band above the prompt shows them with these buttons:

- **Review changes** (`r`): the same as `/review-changes` with no target.
- **Open last review** (`o`): reopens the last page in the browser.
- **Hide**: hides the band.

While a review runs, the band shows its progress, and a toast reports when the page is ready or the run failed.

## Output

Each review is written to `<git-common-dir>/review-changes/<slug>.html`, next to the raw `<slug>.patch` (for example `.git/review-changes/pr-53.html`). That is inside the git directory, so it is never committed and never shows up as a change.

Set `REVIEW_CHANGES_NO_OPEN=1` to write the page without opening a browser, for example in an automated run:

```
REVIEW_CHANGES_NO_OPEN=1 claude -p --plugin-dir plugins/review-changes "/review-changes #53"
```

## Development

```
bun install
bun run build:viewer   # builds the viewer into plugins/review-changes/assets/
bun run typecheck
bun run test           # claude plugin test plugins/review-changes
bun run validate       # validates the marketplace and the plugin
```

The viewer's source lives in `viewer/` and is built with `bun build`. Its output, `plugins/review-changes/assets/viewer.js` and `viewer.css`, is committed, because the plugin inlines it into every page. Rebuild it after any viewer change.

`DESIGN.md` describes the design in detail; `CLAUDE.md` sets the scope.

## Credits

- [pulls.review](https://github.com/antfu/pulls.review) by Anthony Fu (MIT): the analysis schema, the analyzer prompt, and the target logic are adapted from it.
- [@pierre/diffs](https://diffs.com) (Apache-2.0): renders the diffs in the viewer, which bundles it.
