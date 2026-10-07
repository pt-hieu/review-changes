# review-changes

## Goal

review-changes is a Claude Code plugin that helps a human review code changes faster, the way https://pulls.review does. It analyzes a set of changes and lays them out for the human. **It never reviews on the human's behalf and never changes the code under review.**

## Out of scope

Anything that drifts from the goal:

- Fixing, editing, or committing code in the repo under review. The analyzer has no write tools.
- Posting reviews, comments, or approvals to GitHub, or anywhere else.
- Producing verdicts ("LGTM", "request changes"), scores, or exhaustive bug hunts. Notes point the human at what to look at; the human decides.
- Targets outside the session's current repo.

When a feature request or design choice does not make the human's own review faster or clearer, it does not belong here.

Every coding rule is in `CODING_STANDARDS.md`.

## Before committing

**Version bumps** — in the same commit as any change to `plugins/review-changes/`:

1. `plugins/review-changes/.claude-plugin/plugin.json` — the plugin's `version`.
2. `.claude-plugin/marketplace.json` — the matching per-plugin `version` entry.
3. `.claude-plugin/marketplace.json` — the top-level `metadata.version`.

**Viewer bundle** — after any change under `viewer/`, run `bun run build:viewer` and commit the rebuilt `plugins/review-changes/assets/`.
