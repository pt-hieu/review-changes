import { describe, expect, test } from 'bun:test'
import { ReviewCategory, ReviewLineSide } from '../../review/types.ts'
import type { IndexedGroup } from '../../contract.ts'
import { NoteIndex } from '../noteIndex.ts'

function group(overrides: Partial<IndexedGroup>): IndexedGroup {
  return { key: 'g', label: 'g', category: ReviewCategory.Core, summary: '', fileIndexes: [], fileNotes: [], lineNotes: [], ...overrides }
}

describe('NoteIndex', () => {
  test('an empty analysis has no notes and nothing to jump to', () => {
    const index = new NoteIndex([])

    expect(index.jumpTargets).toEqual([])
    expect(index.fileNotes.size).toBe(0)
    expect(index.lineNotes.size).toBe(0)
  })

  test('collects file and line notes by file, across groups, flagging critical ones', () => {
    const index = new NoteIndex([
      group({
        fileIndexes: [4],
        fileNotes: [{ fileIndex: 4, text: 'file note', critical: true }],
        lineNotes: [{ fileIndex: 4, side: ReviewLineSide.Additions, line: 7, text: 'line note' }],
      }),
      group({ fileIndexes: [4], fileNotes: [{ fileIndex: 4, text: 'second group' }] }),
    ])

    expect(index.fileNotes.get(4)).toEqual([
      { text: 'file note', isCritical: true, groupIndex: 0 },
      { text: 'second group', isCritical: false, groupIndex: 1 },
    ])
    expect(index.lineNotes.get(4)).toEqual([{ side: ReviewLineSide.Additions, line: 7, text: 'line note', isCritical: false, groupIndex: 0 }])
    expect(index.fileNotes.get(5)).toBeUndefined()
  })

  test('orders jump targets by group, then by the file order inside the group, then by line', () => {
    const index = new NoteIndex([
      group({
        critical: true,
        fileIndexes: [9, 3],
        lineNotes: [
          { fileIndex: 3, side: ReviewLineSide.Additions, line: 40, text: 'late' },
          { fileIndex: 9, side: ReviewLineSide.Deletions, line: 12, text: 'second on first file' },
          { fileIndex: 9, side: ReviewLineSide.Additions, line: 2, text: 'first on first file' },
        ],
        fileNotes: [{ fileIndex: 3, text: 'about the file' }],
      }),
      group({ fileIndexes: [1], fileNotes: [{ fileIndex: 1, text: 'next group', critical: true }] }),
    ])

    expect(index.jumpTargets.map(target => [target.groupIndex, target.fileIndex, target.line, target.isCritical])).toEqual([
      [0, undefined, undefined, true],
      [0, 9, 2, false],
      [0, 9, 12, false],
      [0, 3, undefined, false],
      [0, 3, 40, false],
      [1, 1, undefined, true],
    ])
  })

  test('a note on a file the group does not list still gets a target, after the listed files', () => {
    const index = new NoteIndex([
      group({
        fileIndexes: [2],
        fileNotes: [
          { fileIndex: 8, text: 'stray' },
          { fileIndex: 2, text: 'listed' },
        ],
      }),
    ])

    expect(index.jumpTargets.map(target => target.fileIndex)).toEqual([2, 8])
  })
})
