import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RowKind } from '../../types.ts'
import { LineIndex, MAXIMUM_ROWS_PER_FILE } from '../lineIndex.ts'
import { PatchReader } from '../patchReader.ts'
import { scanPatch } from '../scanIndex.ts'

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'line-index-test-'))
let counter = 0

afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }))

function open(patch: string) {
  const path = join(temporaryDirectory, `patch-${counter++}.diff`)
  writeFileSync(path, patch)
  const reader = new PatchReader(path)
  const table = scanPatch(reader.descriptor, reader.byteLength, { seed: 1 })

  return { reader, table }
}

const HEADER = 'index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644'

describe('LineIndex', () => {
  test('finds the same hunks in a file large enough to be retained by the scan', () => {
    const longLine = `+${'x'.repeat(1024 * 1024)}\n`
    const { reader, table } = open(`diff --git a/big.ts b/big.ts
${HEADER}
--- a/big.ts
+++ b/big.ts
@@ -1,0 +1,5 @@ first
${longLine.repeat(5)}@@ -90,1 +94,1 @@ second
-old
+new
`)
    const index = new LineIndex(table, reader, 0)

    expect(index.advance(1000)).toBe(true)
    expect(index.rowCount).toBe(9)
    expect(index.hunkIndexOfRow(6)).toBe(1)
    expect(index.rowOfHunk(1)).toBe(6)
    expect(index.lineNumbersAt(7)).toEqual({ oldLine: 90, newLine: 0 })
    reader.close()
  })

  test('classifies rows and numbers lines across two hunks', () => {
    const { reader, table } = open(`diff --git a/a.ts b/a.ts
${HEADER}
--- a/a.ts
+++ b/a.ts
@@ -10,3 +10,3 @@ heading
 keep
-old
+new
@@ -40,2 +40,3 @@
 more
+added
 end
\\ No newline at end of file
`)
    const index = new LineIndex(table, reader, 0)

    expect(index.advance(1000)).toBe(true)
    expect(index.rowCount).toBe(9)
    expect(Array.from({ length: 9 }, (_, row) => index.kindAt(row))).toEqual([
      RowKind.HunkHeader, RowKind.Context, RowKind.Deletion, RowKind.Addition,
      RowKind.HunkHeader, RowKind.Context, RowKind.Addition, RowKind.Context, RowKind.NoNewline,
    ])
    expect(index.lineNumbersAt(1)).toEqual({ oldLine: 10, newLine: 10 })
    expect(index.lineNumbersAt(2)).toEqual({ oldLine: 11, newLine: 0 })
    expect(index.lineNumbersAt(3)).toEqual({ oldLine: 0, newLine: 11 })
    expect(index.lineNumbersAt(6)).toEqual({ oldLine: 0, newLine: 41 })
    expect(index.lineNumbersAt(7)).toEqual({ oldLine: 41, newLine: 42 })
    expect(index.readRow(0, 0, 100).text).toBe('@@ -10,3 +10,3 @@ heading')
    expect(index.readRow(2, 0, 100).text).toBe('old')
    expect(index.readRow(8, 0, 100).text).toBe(' No newline at end of file')
    expect(index.hunkIndexOfRow(5)).toBe(1)
    expect(index.rowOfHunk(1)).toBe(4)
    reader.close()
  })

  test('reads a window of a very long line without loading the rest, on character boundaries', () => {
    const longLine = '漢'.repeat(2_000_000)
    const { reader, table } = open(`diff --git a/min.js b/min.js
${HEADER}
--- a/min.js
+++ b/min.js
@@ -1 +1,2 @@
 context
+${longLine}
diff --git a/b.ts b/b.ts
${HEADER}
--- a/b.ts
+++ b/b.ts
@@ -1 +1 @@
-x
+y
`)
    const index = new LineIndex(table, reader, 0)
    index.advance(1000)
    const window = index.readRow(2, 1, 30)
    const second = new LineIndex(table, reader, 1)
    second.advance(1000)

    expect(index.isComplete).toBe(true)
    expect(window.contentByteLength).toBe(6_000_000)
    expect(window.hasMoreAfter).toBe(true)
    expect(window.text).toBe('漢'.repeat(9))
    expect(second.rowCount).toBe(3)
    expect(second.readRow(2, 0, 10).text).toBe('y')
    reader.close()
  })

  test('indexes in small quanta and resumes where it stopped', () => {
    let body = ''
    for (let line = 0; line < 20000; line++) body += `+line ${line}\n`
    const { reader, table } = open(`diff --git a/a.ts b/a.ts\n${HEADER}\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,20000 @@\n${body}`)
    const index = new LineIndex(table, reader, 0)
    let steps = 0

    while (!index.advance(0)) steps++

    expect(steps).toBeGreaterThanOrEqual(0)
    expect(index.indexedRowCount).toBe(20001)
    expect(index.readRow(20000, 0, 50).text).toBe('line 19999')
    expect(index.lineNumbersAt(12345)).toEqual({ oldLine: 0, newLine: 12345 })
    reader.close()
  })
})

describe('LineIndex on a file with more rows than it will index', () => {
  const EXTRA_ROWS = 5

  test('indexes exactly the maximum and reports the rows it left out', () => {
    const totalRows = MAXIMUM_ROWS_PER_FILE + EXTRA_ROWS
    const { reader, table } = open(`diff --git a/huge.txt b/huge.txt
${HEADER}
--- a/huge.txt
+++ b/huge.txt
@@ -0,0 +1,${totalRows} @@
${'+\n'.repeat(totalRows - 1)}+last
`)
    const index = new LineIndex(table, reader, 0)

    expect(index.advance(60_000)).toBe(true)
    expect(index.totalRowCount).toBe(totalRows + 1)
    expect(index.isTruncated).toBe(true)
    expect(index.rowCount).toBe(MAXIMUM_ROWS_PER_FILE)
    expect(index.indexedRowCount).toBe(MAXIMUM_ROWS_PER_FILE)
    expect(index.kindAt(0)).toBe(RowKind.HunkHeader)
    expect(index.kindAt(MAXIMUM_ROWS_PER_FILE - 1)).toBe(RowKind.Addition)
    expect(index.readRow(MAXIMUM_ROWS_PER_FILE - 1, 0, 100).text).toBe('')
    reader.close()
  })
})
