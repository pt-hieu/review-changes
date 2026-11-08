import { afterAll, describe, expect, test } from 'bun:test'
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileFlag, FileStatusCode } from '../../types.ts'
import { scanFileHunks, scanPatch } from '../scanIndex.ts'

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'scan-index-test-'))
let counter = 0

afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }))

function scan(patch: string | Uint8Array, seed: number = 7) {
  const path = join(temporaryDirectory, `patch-${counter++}.diff`)
  writeFileSync(path, patch)
  const fileDescriptor = openSync(path, 'r')

  try {
    return scanPatch(fileDescriptor, Buffer.byteLength(patch as string), { seed })
  } finally {
    closeSync(fileDescriptor)
  }
}

const MODIFIED = `diff --git a/src/app.ts b/src/app.ts
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@ function run
 keep
-old
+new
+extra
 tail
`

describe('scanPatch', () => {
  test('counts files, hunks, additions, deletions and rows of a modified file', () => {
    const table = scan(MODIFIED)

    expect(table.fileCount).toBe(1)
    expect(table.pathOf(0)).toBe('src/app.ts')
    expect(table.status[0]).toBe(FileStatusCode.Modified)
    expect(table.additions[0]).toBe(2)
    expect(table.deletions[0]).toBe(1)
    expect(table.hunkCount).toBe(1)
    expect(table.rowCount[0]).toBe(6)
  })

  test('reads the hunk headers of one file region', () => {
    const path = join(temporaryDirectory, `patch-${counter++}.diff`)
    writeFileSync(path, MODIFIED)
    const fileDescriptor = openSync(path, 'r')

    try {
      const hunks = scanFileHunks(fileDescriptor, 0, Buffer.byteLength(MODIFIED))

      expect(hunks.count).toBe(1)
      expect(hunks.oldStart[0]).toBe(1)
      expect(hunks.newLines[0]).toBe(4)
      expect(hunks.rowCount[0]).toBe(6)
    } finally {
      closeSync(fileDescriptor)
    }
  })

  test('treats a deleted line starting with dashes inside a hunk as a deletion, not a header', () => {
    const table = scan(`diff --git a/notes.md b/notes.md
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
--- a/notes.md
+++ b/notes.md
@@ -1,3 +1,1 @@
 title
--- horizontal rule
-+++ not a header
`)

    expect(table.fileCount).toBe(1)
    expect(table.deletions[0]).toBe(2)
    expect(table.additions[0]).toBe(0)
    expect(table.pathOf(0)).toBe('notes.md')
  })

  test('counts a no-newline marker as a row without changing the counts', () => {
    const table = scan(`diff --git a/a.txt b/a.txt
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-one
\\ No newline at end of file
+two
\\ No newline at end of file
diff --git a/b.txt b/b.txt
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
--- a/b.txt
+++ b/b.txt
@@ -1 +1 @@
-x
+y
`)

    expect(table.fileCount).toBe(2)
    expect(table.rowCount[0]).toBe(5)
    expect(table.rowCount[1]).toBe(3)
    expect(table.pathOf(1)).toBe('b.txt')
  })

  test('reads added, removed, renamed, copied, binary and mode-only entries', () => {
    const table = scan(`diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000000000000000000000000000000000000..3333333333333333333333333333333333333333
--- /dev/null
+++ b/new.ts
@@ -0,0 +1 @@
+hello
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
index 3333333333333333333333333333333333333333..0000000000000000000000000000000000000000
--- a/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/from.ts b/to.ts
similarity index 100%
rename from from.ts
rename to to.ts
diff --git a/orig.ts b/dupe.ts
similarity index 90%
copy from orig.ts
copy to dupe.ts
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
--- a/orig.ts
+++ b/dupe.ts
@@ -1 +1 @@
-a
+b
diff --git a/logo.png b/logo.png
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
Binary files a/logo.png and b/logo.png differ
diff --git a/blob.bin b/blob.bin
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
GIT binary patch
literal 3
Kcmd;hdiff --git x

literal 0
HcmV?d00001

diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
`)

    expect(table.fileCount).toBe(7)
    expect([0, 1, 2, 3, 4, 5, 6].map(index => table.pathOf(index))).toEqual([
      'new.ts', 'gone.ts', 'to.ts', 'dupe.ts', 'logo.png', 'blob.bin', 'run.sh',
    ])
    expect(table.status[0]).toBe(FileStatusCode.Added)
    expect(table.status[1]).toBe(FileStatusCode.Removed)
    expect(table.status[2]).toBe(FileStatusCode.Renamed)
    expect(table.previousPathOf(2)).toBe('from.ts')
    expect(table.status[3]).toBe(FileStatusCode.Copied)
    expect(table.previousPathOf(3)).toBe('orig.ts')
    expect(table.isBinary(4)).toBe(true)
    expect(table.isBinary(5)).toBe(true)
    expect(table.isBinary(6)).toBe(false)
    expect((table.flags[6]! & FileFlag.ModeOnly) !== 0).toBe(true)
    expect(table.hunkCount).toBe(3)
    expect(table.additions[3]).toBe(1)
  })

  test('decodes quoted paths and paths with spaces', () => {
    const table = scan(`diff --git "a/caf\\303\\251 \\"q\\".ts" "b/caf\\303\\251 \\"q\\".ts"
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
--- "a/caf\\303\\251 \\"q\\".ts"
+++ "b/caf\\303\\251 \\"q\\".ts"
@@ -1 +1 @@
-a
+b
diff --git a/with space.txt b/with space.txt
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
--- a/with space.txt\t
+++ b/with space.txt\t
@@ -1 +1 @@
-a
+b
diff --git a/spaced name.bin b/spaced name.bin
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
Binary files a/spaced name.bin and b/spaced name.bin differ
`)

    expect(table.pathOf(0)).toBe('café "q".ts')
    expect(table.pathOf(1)).toBe('with space.txt')
    expect(table.pathOf(2)).toBe('spaced name.bin')
  })

  test('keeps an escape character in a quoted path as data for the caller to sanitize', () => {
    const table = scan(`diff --git "a/x\\033]52;c;AAAA\\007.ts" "b/x\\033]52;c;AAAA\\007.ts"
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
Binary files a/x and b/x differ
`)

    expect(table.pathOf(0)).toBe('x\u001b]52;c;AAAA\u0007.ts')
  })

  test('finds every file when lines straddle the read buffer boundary', () => {
    const filler = 'z'.repeat(997)
    let patch = ''
    const expectedPaths: string[] = []

    for (let index = 0; index < 1500; index++) {
      const path = `dir/file-${String(index).padStart(4, '0')}.ts`
      expectedPaths.push(path)
      patch += `diff --git a/${path} b/${path}\nindex 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,2 @@\n-${filler}\n+${filler}\n`
    }

    const table = scan(patch)

    expect(table.fileCount).toBe(1500)
    expect(table.hunkCount).toBe(1500)
    expect(table.additions.every(count => count === 1)).toBe(true)
    expect(table.pathOf(0)).toBe(expectedPaths[0]!)
    expect(table.pathOf(777)).toBe(expectedPaths[777]!)
    expect(table.pathOf(1499)).toBe(expectedPaths[1499]!)
    expect(table.patchByteLength).toBe(Buffer.byteLength(patch))
  })

  test('scans past a line longer than the read buffer and still finds the next file', () => {
    const longLine = 'a'.repeat(3 * 1024 * 1024 + 123)
    const table = scan(`diff --git a/min.js b/min.js
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
--- a/min.js
+++ b/min.js
@@ -1 +1,2 @@
 context
+${longLine}
diff --git a/after.ts b/after.ts
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
--- a/after.ts
+++ b/after.ts
@@ -1 +1 @@
-old
+new
`)

    expect(table.fileCount).toBe(2)
    expect(table.additions[0]).toBe(1)
    expect(table.rowCount[0]).toBe(3)
    expect(table.pathOf(1)).toBe('after.ts')
    expect(table.additions[1]).toBe(1)
    expect(table.deletions[1]).toBe(1)
  })

  test('handles a final line without a trailing newline', () => {
    const table = scan(MODIFIED.trimEnd())

    expect(table.fileCount).toBe(1)
    expect(table.rowCount[0]).toBe(6)
    expect(table.patchByteLength).toBe(MODIFIED.length - 1)
  })

  test('ignores text before the first file header and an empty patch', () => {
    expect(scan('').fileCount).toBe(0)
    expect(scan('From abc\nSubject: hi\n\n' + MODIFIED).fileCount).toBe(1)
  })

  test('orders paths bytewise even when a rename sorts by its source', () => {
    const table = scan(`diff --git a/b0 b/z9
similarity index 100%
rename from b0
rename to z9
diff --git a/c1 b/c1
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
Binary files a/c1 and b/c1 differ
diff --git a/e2 b/a0
similarity index 100%
rename from e2
rename to a0
`)

    expect(table.isPathOrdered()).toBe(false)
    expect(Array.from(table.sortedOrder())).toEqual([2, 1, 0])
  })

  test('review key survives shifted line numbers and changes when a blob changes', () => {
    const shifted = MODIFIED.replace('@@ -1,3 +1,4 @@', '@@ -11,3 +11,4 @@')
    const otherBlob = MODIFIED.replace('2222222222222222222222222222222222222222', '4444444444444444444444444444444444444444')

    const original = scan(MODIFIED)
    const keyOf = (table: ReturnType<typeof scan>) => table.reviewKey[0]!

    expect(keyOf(scan(shifted))).toBe(keyOf(original))
    expect(keyOf(scan(otherBlob))).not.toBe(keyOf(original))
    expect(keyOf(scan(MODIFIED, 8))).not.toBe(keyOf(original))
    expect(Number.isSafeInteger(keyOf(original))).toBe(true)
  })

  test('flags an abbreviated index line', () => {
    const table = scan(`diff --git a/a b/a
index 980a0d5f1..621178578 100644
--- a/a
+++ b/a
@@ -1 +1 @@
-x
+y
`)

    expect((table.flags[0]! & FileFlag.AbbreviatedIndex) !== 0).toBe(true)
    expect((scan(MODIFIED).flags[0]! & FileFlag.AbbreviatedIndex) !== 0).toBe(false)
  })
})
