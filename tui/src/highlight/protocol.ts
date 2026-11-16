import { isRecord } from '../json.ts'
import { WorkerMessageType } from '../types.ts'

export type HighlightRequest = {
  id: number
  language: string
  offset: number
  length: number
  firstRow: number
  rowCount: number
}

export type WorkerInput = { type: WorkerMessageType.Init; patchPath: string; patchInode: number } | ({ type: WorkerMessageType.Highlight } & HighlightRequest)

export type HighlightReply = {
  type: WorkerMessageType.Highlighted
  id: number
  firstRow: number
  rowCount: number
  offsets: Uint32Array
  runs: Uint32Array
}

export type WorkerOutput = HighlightReply | { type: WorkerMessageType.Failed; id: number }

export function parseWorkerOutput(value: unknown): WorkerOutput | undefined {
  if (!isRecord(value) || typeof value.id !== 'number') return undefined

  if (value.type === WorkerMessageType.Failed) return { type: WorkerMessageType.Failed, id: value.id }

  if (value.type !== WorkerMessageType.Highlighted) return undefined
  if (typeof value.firstRow !== 'number' || typeof value.rowCount !== 'number') return undefined
  if (!(value.offsets instanceof Uint32Array) || !(value.runs instanceof Uint32Array)) return undefined

  return { type: WorkerMessageType.Highlighted, id: value.id, firstRow: value.firstRow, rowCount: value.rowCount, offsets: value.offsets, runs: value.runs }
}
