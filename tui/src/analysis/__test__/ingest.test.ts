import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReviewCategory } from '../../review/types.ts'
import type { IndexedGroup } from '../../contract.ts'
import { PatchReader } from '../../patch/patchReader.ts'
import { scanPatch } from '../../patch/scanIndex.ts'
import { analyzeAnswer } from '../ingest.ts'

const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,3 +10,4 @@ function handle',
  ' const one = 1',
  '+const two = 2',
  ' const three = 3',
  ' const four = 4',
  'diff --git a/src/b.ts b/src/b.ts',
  'index 3333333..4444444 100644',
  '--- a/src/b.ts',
  '+++ b/src/b.ts',
  '@@ -1,2 +1,2 @@',
  '-old',
  '+new',
  ' same',
  'diff --git a/docs/readme.md b/docs/readme.md',
  'index 5555555..6666666 100644',
  '--- a/docs/readme.md',
  '+++ b/docs/readme.md',
  '@@ -1 +1 @@',
  '-before',
  '+after',
  '',
].join('\n')

const directory = mkdtempSync(join(tmpdir(), 'ingest-test-'))
writeFileSync(join(directory, 'patch.diff'), PATCH)

const reader = new PatchReader(join(directory, 'patch.diff'))
const table = scanPatch(reader.descriptor, reader.byteLength, { seed: 1 })

afterAll(() => {
  reader.close()
  rmSync(directory, { recursive: true, force: true })
})

function seed(key: string, fileIndexes: number[]): IndexedGroup {
  return { key, label: `label ${key}`, category: ReviewCategory.Core, summary: `${fileIndexes.length} files`, fileIndexes, fileNotes: [], lineNotes: [] }
}

const SEEDS = [seed('seed-1', [0, 1]), seed('seed-2', [2])]

function answer(json: unknown): string {
  return ['Here is the analysis.', '```json', JSON.stringify(json), '```'].join('\n')
}

describe('analyzeAnswer', () => {
  test('expands seeds into files and gives a seed the analyzer left out its own group', () => {
    const result = analyzeAnswer(
      answer({ overallSummary: 'Search work', groups: [{ key: 'core', label: 'Core', category: 'core', summary: 'Why', seeds: ['seed-1'] }] }),
      table,
      reader,
      SEEDS,
    )

    expect(result).toMatchObject({
      overallSummary: 'Search work',
      groups: [
        { key: 'core', label: 'Core', fileIndexes: [0, 1] },
        { key: 'seed-2', label: 'label seed-2', fileIndexes: [2] },
      ],
    })
  })

  test('moves single files out of their seed when a group lists them first', () => {
    const result = analyzeAnswer(
      answer({
        groups: [
          { key: 'risky', label: 'Risky', summary: 's', filePaths: ['src/b.ts'] },
          { key: 'rest', label: 'Rest', summary: 's', seeds: ['seed-1', 'seed-2'] },
        ],
      }),
      table,
      reader,
      SEEDS,
    )

    expect(result).toMatchObject({ groups: [{ key: 'risky', fileIndexes: [1] }, { key: 'rest', fileIndexes: [0, 2] }] })
  })

  test('keeps a line note that lies in a hunk and turns one that does not into a file note', () => {
    const result = analyzeAnswer(
      answer({
        groups: [
          {
            key: 'core',
            label: 'Core',
            summary: 's',
            seeds: ['seed-1', 'seed-2'],
            lineNotes: [
              { path: 'src/a.ts', side: 'additions', line: 11, text: 'inside the hunk', critical: true },
              { path: 'src/a.ts', side: 'additions', line: 99, text: 'outside every hunk' },
            ],
          },
        ],
      }),
      table,
      reader,
      SEEDS,
    )

    expect(result).toMatchObject({
      groups: [
        {
          lineNotes: [{ fileIndex: 0, side: 'additions', line: 11, text: 'inside the hunk', critical: true }],
          fileNotes: [{ fileIndex: 0, text: '(line 99) outside every hunk' }],
        },
      ],
    })
  })

  test('turns a visual anchor path into a file index', () => {
    const result = analyzeAnswer(
      answer({
        groups: [
          { key: 'core', label: 'Core', summary: 's', seeds: ['seed-1', 'seed-2'], visual: { caption: 'flow', lines: ['+ handle (src/a.ts:11)', '  readme (docs/readme.md)'] } },
        ],
      }),
      table,
      reader,
      SEEDS,
    )

    expect(result).toMatchObject({
      groups: [
        {
          visual: {
            caption: 'flow',
            lines: [
              { text: 'handle', anchor: { fileIndex: 0, side: 'additions', line: 11 } },
              { text: 'readme', anchor: { fileIndex: 2 } },
            ],
          },
        },
      ],
    })
  })

  test('ignores unknown seeds and paths', () => {
    const result = analyzeAnswer(
      answer({ groups: [{ key: 'core', label: 'Core', summary: 's', seeds: ['seed-9'], filePaths: ['nope.ts'] }] }),
      table,
      reader,
      SEEDS,
    )

    expect(result).toMatchObject({ groups: [{ key: 'seed-1', fileIndexes: [0, 1] }, { key: 'seed-2', fileIndexes: [2] }] })
  })

  test('reports an answer with no JSON, bad JSON, or no groups', () => {
    expect(analyzeAnswer('I could not do it.', table, reader, SEEDS)).toStrictEqual({ error: 'the answer held no JSON' })
    expect(analyzeAnswer('```json\n{oops\n```', table, reader, SEEDS)).toMatchObject({ error: expect.stringContaining('did not parse') })
    expect(analyzeAnswer(answer({ overallSummary: 'x' }), table, reader, SEEDS)).toStrictEqual({ error: 'the answer has no "groups" list' })
  })
})
