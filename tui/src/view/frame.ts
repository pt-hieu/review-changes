import type { DisplayText } from '../text/sanitize.ts'
import { STYLE_RESET } from '../terminal/styles.ts'
import { BEGIN_FRAME, END_FRAME, cursorTo } from '../terminal/lifecycle.ts'

export type Segment = { column: number; text: DisplayText }

export type FrameRow = Segment[]

function sameSegments(left: FrameRow | undefined, right: FrameRow, count: number): number {
  if (left === undefined) return 0

  for (let index = 0; index < count; index++) {
    const previous = left[index]
    const current = right[index]!

    if (previous === undefined || previous.column !== current.column || previous.text !== current.text) return index
  }

  return count
}

export class FrameWriter {
  private previous: FrameRow[] = []

  invalidate(): void {
    this.previous = []
  }

  render(rows: readonly FrameRow[]): string {
    let body = ''

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex]!
      const previousRow = this.previous[rowIndex]
      const firstChanged = previousRow !== undefined && previousRow.length === row.length ? sameSegments(previousRow, row, row.length) : 0

      for (let segmentIndex = firstChanged; segmentIndex < row.length; segmentIndex++) {
        const segment = row[segmentIndex]!
        body += cursorTo(rowIndex + 1, segment.column + 1) + segment.text + STYLE_RESET
      }
    }

    this.previous = rows.map(row => row.slice())

    return body === '' ? '' : BEGIN_FRAME + body + END_FRAME
  }
}
