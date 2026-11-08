import { afterAll, describe, expect, test } from 'bun:test'
import { ReviewCategory } from '../../review/types.ts'
import type { IndexedGroup } from '../../contract.ts'
import { binaryFileSection, fileSection } from '../../__test__/reviewDirectory.ts'
import { closeScannedPatches, scanText } from '../../__test__/scannedPatch.ts'
import { buildManifest } from '../manifest.ts'

afterAll(closeScannedPatches)

function seed(key: string, fileIndexes: number[]): IndexedGroup {
  return { key, label: key, category: ReviewCategory.Core, summary: '', fileIndexes, fileNotes: [], lineNotes: [] }
}

describe('buildManifest', () => {
  test('lists each file with its status, counts, seed group, first line, line count and byte count', () => {
    const first = fileSection('src/a.ts', 2, 1)
    const second = fileSection('src/b.ts', 1, 0)
    const { table } = scanText(first + second)

    const manifest = buildManifest(table, [seed('seed-1', [0]), seed('seed-2', [1])])

    expect(manifest).toBe(
      [
        ['"src/a.ts"', 'M', 2, 1, 'seed-1', 1, first.split('\n').length - 1, Buffer.byteLength(first)].join('\t'),
        ['"src/b.ts"', 'M', 1, 0, 'seed-2', first.split('\n').length, second.split('\n').length - 1, Buffer.byteLength(second)].join('\t'),
        '',
      ].join('\n'),
    )
  })

  test('leaves the seed column empty for a file no seed group holds', () => {
    const { table } = scanText(fileSection('lonely.ts', 1, 1))

    expect(buildManifest(table, []).split('\t')[4]).toBe('')
  })

  test('marks a binary file and keeps one line per file', () => {
    const { table } = scanText(binaryFileSection('logo.png') + fileSection('b.ts', 1, 0))

    const lines = buildManifest(table, []).trimEnd().split('\n')

    expect(lines).toHaveLength(2)
    expect(lines[0]!.split('\t').slice(0, 4)).toEqual(['"logo.png"', 'M', '0', '0'])
  })

  test('a path with a tab or a quote is JSON-escaped so it cannot add columns or lines', () => {
    const tabbed = 'diff --git "a/we\\tird.txt" "b/we\\tird.txt"\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ "b/we\\tird.txt"\n@@ -0,0 +1 @@\n+x\n'
    const { table } = scanText(tabbed)

    const manifest = buildManifest(table, [])

    expect(manifest.trimEnd().split('\n')).toHaveLength(1)
    expect(manifest.split('\t')[0]).toBe('"we\\tird.txt"')
    expect(manifest.split('\t')).toHaveLength(8)
  })

  test('an empty patch gives a manifest of one blank line', () => {
    expect(buildManifest(scanText('').table, [])).toBe('\n')
  })
})
