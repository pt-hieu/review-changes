import { describe, expect, test } from 'bun:test'
import { WorkerMessageType } from '../../types.ts'
import { parseWorkerOutput } from '../protocol.ts'

describe('parseWorkerOutput', () => {
  test('reads a highlighted reply with its run tables', () => {
    const offsets = new Uint32Array([0, 3])
    const runs = new Uint32Array([0, 1, 0])

    expect(parseWorkerOutput({ type: 'highlighted', id: 4, firstRow: 10, rowCount: 2, offsets, runs })).toEqual({
      type: WorkerMessageType.Highlighted,
      id: 4,
      firstRow: 10,
      rowCount: 2,
      offsets,
      runs,
    })
  })

  test('reads a failure reply', () => {
    expect(parseWorkerOutput({ type: 'failed', id: 4 })).toEqual({ type: WorkerMessageType.Failed, id: 4 })
  })

  test('rejects a reply without an id, of an unknown type, or with run tables of the wrong kind', () => {
    expect(parseWorkerOutput({ type: 'failed' })).toBeUndefined()
    expect(parseWorkerOutput({ type: 'progress', id: 4 })).toBeUndefined()
    expect(parseWorkerOutput({ type: 'highlighted', id: 4, firstRow: 0, rowCount: 1, offsets: [0], runs: [0, 1, 0] })).toBeUndefined()
    expect(parseWorkerOutput(null)).toBeUndefined()
  })
})
