import { ReviewLineSide } from '../review/types.ts'
import type { IndexedGroup } from '../contract.ts'

export type FileNoteEntry = { text: string; isCritical: boolean; groupIndex: number }

export type LineNoteEntry = { side: ReviewLineSide; line: number; text: string; isCritical: boolean; groupIndex: number }

export type JumpTarget = {
  groupIndex: number
  fileIndex: number | undefined
  side: ReviewLineSide | undefined
  line: number | undefined
  isCritical: boolean
}

export class NoteIndex {
  readonly fileNotes = new Map<number, FileNoteEntry[]>()
  readonly lineNotes = new Map<number, LineNoteEntry[]>()
  readonly jumpTargets: JumpTarget[] = []

  constructor(groups: readonly IndexedGroup[]) {
    groups.forEach((group, groupIndex) => {
      const positionOfFile = new Map<number, number>()
      group.fileIndexes.forEach((fileIndex, position) => positionOfFile.set(fileIndex, position))

      if (group.critical === true) {
        this.jumpTargets.push({ groupIndex, fileIndex: undefined, side: undefined, line: undefined, isCritical: true })
      }

      const fileTargets: (JumpTarget & { order: number; lineOrder: number })[] = []

      for (const note of group.fileNotes) {
        const entry: FileNoteEntry = { text: note.text, isCritical: note.critical === true, groupIndex }
        const existing = this.fileNotes.get(note.fileIndex)

        if (existing === undefined) this.fileNotes.set(note.fileIndex, [entry])
        else existing.push(entry)

        fileTargets.push({
          groupIndex,
          fileIndex: note.fileIndex,
          side: undefined,
          line: undefined,
          isCritical: entry.isCritical,
          order: positionOfFile.get(note.fileIndex) ?? Number.MAX_SAFE_INTEGER,
          lineOrder: 0,
        })
      }

      for (const note of group.lineNotes) {
        const entry: LineNoteEntry = { side: note.side, line: note.line, text: note.text, isCritical: note.critical === true, groupIndex }
        const existing = this.lineNotes.get(note.fileIndex)

        if (existing === undefined) this.lineNotes.set(note.fileIndex, [entry])
        else existing.push(entry)

        fileTargets.push({
          groupIndex,
          fileIndex: note.fileIndex,
          side: note.side,
          line: note.line,
          isCritical: entry.isCritical,
          order: positionOfFile.get(note.fileIndex) ?? Number.MAX_SAFE_INTEGER,
          lineOrder: note.line,
        })
      }

      fileTargets.sort((left, right) => left.order - right.order || left.lineOrder - right.lineOrder)

      for (const { order: _order, lineOrder: _lineOrder, ...target } of fileTargets) this.jumpTargets.push(target)
    })
  }
}
