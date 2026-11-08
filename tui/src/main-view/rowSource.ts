import type { DisplayText } from '../text/sanitize.ts'

export type RowSource = {
  rowCount(): number
  materialize(firstRow: number, count: number, width: number): DisplayText[]
}
