import { describe, expect, test } from 'claude-code/testing'
import { buildReviewFiles } from '../patch.ts'
import { ReviewFileStatus } from '../types.ts'

const modifiedSection = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,3 @@',
  " import { start } from './start'",
  '-start(1)',
  '+start(2)',
  ' export {}',
  '@@ -10 +10,2 @@ function stop() {',
  '-  return',
  '+  cleanUp()',
  '+  return true',
  '',
].join('\n')

const addedSection = [
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1,2 @@',
  '+export const answer = 42',
  '+++ a line that looks like a header',
  '',
].join('\n')

const removedSection = [
  'diff --git a/src/old.ts b/src/old.ts',
  'deleted file mode 100644',
  'index 4444444..0000000',
  '--- a/src/old.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-export const old = true',
  '--- a line that looks like a header',
  '',
].join('\n')

const renamedSection = [
  'diff --git a/lib/before.ts b/lib/after.ts',
  'similarity index 90%',
  'rename from lib/before.ts',
  'rename to lib/after.ts',
  'index 5555555..6666666 100644',
  '--- a/lib/before.ts',
  '+++ b/lib/after.ts',
  '@@ -2 +2 @@',
  "-const name = 'before'",
  "+const name = 'after'",
  '',
].join('\n')

const pureRenameSection = [
  'diff --git a/docs/a.md b/docs/b.md',
  'similarity index 100%',
  'rename from docs/a.md',
  'rename to docs/b.md',
  '',
].join('\n')

const binarySection = [
  'diff --git a/assets/logo.png b/assets/logo.png',
  'index 7777777..8888888 100644',
  'Binary files a/assets/logo.png and b/assets/logo.png differ',
  '',
].join('\n')

const quotedSection = [
  'diff --git "a/docs/caf\\303\\251 \\"menu\\".md" "b/docs/caf\\303\\251 \\"menu\\".md"',
  'index 9999999..aaaaaaa 100644',
  '--- "a/docs/caf\\303\\251 \\"menu\\".md"',
  '+++ "b/docs/caf\\303\\251 \\"menu\\".md"',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  '',
].join('\n')

const spacedSection = [
  'diff --git a/my notes.txt b/my notes.txt',
  'new file mode 100644',
  'index 0000000..bbbbbbb',
  '--- /dev/null',
  '+++ b/my notes.txt\t',
  '@@ -0,0 +1 @@',
  '+hello',
  '',
].join('\n')

const wholePatch = [
  modifiedSection,
  addedSection,
  removedSection,
  renamedSection,
  pureRenameSection,
  binarySection,
  quotedSection,
  spacedSection,
].join('')

describe('buildReviewFiles', () => {
  test('reads each file’s path, status, counts and hunks', async () => {
    const files = await buildReviewFiles(wholePatch)
    const summaries = files.map(file => ({
      path: file.path,
      previousPath: file.previousPath,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      isBinary: file.isBinary,
      hunkHeaders: file.hunks.map(hunk => hunk.header),
    }))
    expect(summaries).toEqual([
      { path: 'src/app.ts', status: ReviewFileStatus.Modified, additions: 3, deletions: 2, isBinary: false, hunkHeaders: ['@@ -1,3 +1,3 @@', '@@ -10 +10,2 @@ function stop() {'] },
      { path: 'src/new.ts', status: ReviewFileStatus.Added, additions: 2, deletions: 0, isBinary: false, hunkHeaders: ['@@ -0,0 +1,2 @@'] },
      { path: 'src/old.ts', status: ReviewFileStatus.Removed, additions: 0, deletions: 2, isBinary: false, hunkHeaders: ['@@ -1,2 +0,0 @@'] },
      { path: 'lib/after.ts', previousPath: 'lib/before.ts', status: ReviewFileStatus.Renamed, additions: 1, deletions: 1, isBinary: false, hunkHeaders: ['@@ -2 +2 @@'] },
      { path: 'docs/b.md', previousPath: 'docs/a.md', status: ReviewFileStatus.Renamed, additions: 0, deletions: 0, isBinary: false, hunkHeaders: [] },
      { path: 'assets/logo.png', status: ReviewFileStatus.Modified, additions: 0, deletions: 0, isBinary: true, hunkHeaders: [] },
      { path: 'docs/café "menu".md', status: ReviewFileStatus.Modified, additions: 1, deletions: 1, isBinary: false, hunkHeaders: ['@@ -1 +1 @@'] },
      { path: 'my notes.txt', status: ReviewFileStatus.Added, additions: 1, deletions: 0, isBinary: false, hunkHeaders: ['@@ -0,0 +1 @@'] },
    ])
  })

  test('reads hunk ranges, a missing count meaning one line', async () => {
    const [modified] = await buildReviewFiles(modifiedSection)
    expect(modified!.hunks).toEqual([
      { header: '@@ -1,3 +1,3 @@', oldStart: 1, oldLines: 3, newStart: 1, newLines: 3 },
      { header: '@@ -10 +10,2 @@ function stop() {', oldStart: 10, oldLines: 1, newStart: 10, newLines: 2 },
    ])
  })

  test('the sections joined reproduce the patch', async () => {
    const files = await buildReviewFiles(wholePatch)
    expect(files.map(file => file.patch).join('')).toBe(wholePatch)
    expect(files.every(file => !file.isPatchOmitted)).toBe(true)
  })

  test('a section ends in exactly one newline', async () => {
    const [binary] = await buildReviewFiles(`${binarySection}\n\n`)
    expect(binary!.patch).toBe(binarySection)
  })

  test('the same section hashes the same wherever it appears; different sections differ', async () => {
    const [alone] = await buildReviewFiles(modifiedSection)
    const files = await buildReviewFiles(wholePatch)
    expect(alone!.patchHash).toBe(files[0]!.patchHash)
    expect(new Set(files.map(file => file.patchHash)).size).toBe(files.length)
  })

  test('a patch with no file sections gives no files', async () => {
    expect(await buildReviewFiles('')).toEqual([])
  })
})
