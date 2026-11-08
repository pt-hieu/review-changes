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
