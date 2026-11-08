import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { FileTable } from '../patch/fileTable.ts'
import type { LineIndexCache } from '../patch/lineIndex.ts'
import { FileFlag, WorkerMessageType } from '../types.ts'
import type { HighlightService } from '../view/appState.ts'
import { languageForPath } from './languageNames.ts'
import type { HighlightReply, WorkerInput, WorkerOutput } from './protocol.ts'

export type HighlightClient = HighlightService & { dispose(): void }

const CHUNK_ROWS = 256
const WHOLE_HUNK_ROWS = 512
const MAXIMUM_FILE_PATCH_BYTES = 8 * 1024 * 1024
const WATCHDOG_MILLISECONDS = 1000
const MEMORY_CHECK_MILLISECONDS = 2000
const MEMORY_LIMIT_BYTES = 220 * 1024 * 1024
const CACHE_LIMIT_BYTES = 8 * 1024 * 1024
const MAXIMUM_WORKER_FAILURES = 2
const BYTES_PER_RUN_VALUE = 4

type Job = { id: number; fileIndex: number; key: string; language: string; offset: number; length: number; firstRow: number; rowCount: number }

type CachedChunk = { fileIndex: number; rows: number[]; bytes: number }

type WorkerLike = {
  postMessage(message: WorkerInput, transfer?: ArrayBuffer[]): void
  terminate(): void
  onmessage: ((event: { data: WorkerOutput }) => void) | null
  onerror: ((event: unknown) => void) | null
}

function workerUrl(): string | undefined {
  const candidates = ['./highlight-worker.js', './worker.ts']

  for (const candidate of candidates) {
    const url = new URL(candidate, import.meta.url)

    if (existsSync(fileURLToPath(url))) return url.href
  }

  return undefined
}

export function createHighlightClient(table: FileTable, lineIndexes: LineIndexCache, patchPath: string, patchInode: number, onUpdate: () => void): HighlightClient {
  const rowRuns = new Map<number, Map<number, Uint32Array>>()
  const cachedChunks = new Map<string, CachedChunk>()
  const pending: Job[] = []
  const queuedKeys = new Set<string>()
  const plainFiles = new Set<number>()
  let cacheBytes = 0
  let worker: WorkerLike | undefined
  let runningJob: Job | undefined
  let runningSince = 0
  let nextJobId = 1
  let failures = 0
  let isDisabled = false
  let hasUpdate = false
  let lastMemoryCheck = 0

  const isEligible = (fileIndex: number): boolean => {
    if (plainFiles.has(fileIndex)) return false

    const flags = table.flags[fileIndex]!

    if ((flags & (FileFlag.Binary | FileFlag.Generated)) !== 0) return false

    return table.patchOffset[fileIndex + 1]! - table.patchOffset[fileIndex]! <= MAXIMUM_FILE_PATCH_BYTES
  }

  const evict = (): void => {
    for (const [key, chunk] of cachedChunks) {
      if (cacheBytes <= CACHE_LIMIT_BYTES) break

      const rowsOfFile = rowRuns.get(chunk.fileIndex)
      for (const row of chunk.rows) rowsOfFile?.delete(row)

      cachedChunks.delete(key)
      cacheBytes -= chunk.bytes
    }
  }

  const store = (job: Job, reply: HighlightReply): void => {
    let rowsOfFile = rowRuns.get(job.fileIndex)

    if (rowsOfFile === undefined) {
      rowsOfFile = new Map()
      rowRuns.set(job.fileIndex, rowsOfFile)
    }

    const rows: number[] = []

    for (let index = 0; index < reply.rowCount; index++) {
      const start = reply.offsets[index]!
      const end = reply.offsets[index + 1]!

      if (end > start) {
        rowsOfFile.set(reply.firstRow + index, reply.runs.subarray(start, end))
        rows.push(reply.firstRow + index)
      }
    }

    const bytes = reply.runs.length * BYTES_PER_RUN_VALUE

    cachedChunks.set(job.key, { fileIndex: job.fileIndex, rows, bytes })
    cacheBytes += bytes
    evict()
  }

  const stopWorker = (): void => {
    worker?.terminate()
    worker = undefined
    runningJob = undefined
  }

  const handleFailure = (): void => {
    failures++
    stopWorker()

    if (failures >= MAXIMUM_WORKER_FAILURES) isDisabled = true
  }

  const ensureWorker = (): WorkerLike | undefined => {
    if (worker !== undefined) return worker
    if (isDisabled) return undefined

    const url = workerUrl()

    if (url === undefined) {
      isDisabled = true

      return undefined
    }

    try {
      const created = new Worker(url) as unknown as WorkerLike

      created.onmessage = event => {
        const output = event.data
        const job = runningJob

        if (job === undefined || output.id !== job.id) return

        runningJob = undefined

        if (output.type === WorkerMessageType.Highlighted) {
          store(job, output)
          hasUpdate = true
          onUpdate()
        }

        pump()
      }
      created.onerror = () => handleFailure()
      created.postMessage({ type: WorkerMessageType.Init, patchPath, patchInode })
      worker = created

      return created
    } catch {
      isDisabled = true

      return undefined
    }
  }

  const pump = (): void => {
    if (runningJob !== undefined || pending.length === 0) return

    const active = ensureWorker()

    if (active === undefined) return

    const job = pending.shift()!
    queuedKeys.delete(job.key)

    if (cachedChunks.has(job.key) || plainFiles.has(job.fileIndex)) {
      pump()

      return
    }

    runningJob = job
    runningSince = performance.now()
    active.postMessage({ type: WorkerMessageType.Highlight, id: job.id, language: job.language, offset: job.offset, length: job.length, firstRow: job.firstRow, rowCount: job.rowCount })
  }

  return {
    runsFor(fileIndex, row) {
      return rowRuns.get(fileIndex)?.get(row)
    },

    request(fileIndex, firstRow, lastRow) {
      if (isDisabled || !isEligible(fileIndex)) return

      const language = languageForPath(table.pathOf(fileIndex))

      if (language === undefined) return

      const lineIndex = lineIndexes.get(fileIndex)
      const limit = Math.min(lastRow + 1, lineIndex.indexedRowCount)
      const jobs: Job[] = []
      let row = Math.max(0, firstRow)

      while (row < limit) {
        const hunk = lineIndex.hunkIndexOfRow(row)
        const hunkFirstRow = lineIndex.rowOfHunk(hunk)
        const hunkRows = lineIndex.hunks.rowCount[hunk]!
        const chunkSize = hunkRows <= WHOLE_HUNK_ROWS ? hunkRows : CHUNK_ROWS
        const chunkIndex = Math.floor((row - hunkFirstRow) / chunkSize)
        const chunkFirst = hunkFirstRow + chunkIndex * chunkSize
        const chunkEnd = Math.min(hunkFirstRow + hunkRows, chunkFirst + chunkSize, lineIndex.indexedRowCount)
        const key = `${fileIndex}:${chunkFirst}`

        row = chunkEnd

        if (cachedChunks.has(key) || queuedKeys.has(key) || runningJob?.key === key) continue
        if (chunkEnd <= chunkFirst) continue

        const range = lineIndex.byteRangeOfRows(chunkFirst, chunkEnd)

        jobs.push({ id: nextJobId++, fileIndex, key, language, offset: range.start, length: range.length, firstRow: chunkFirst, rowCount: chunkEnd - chunkFirst })
      }

      pending.splice(0, pending.length, ...pending.filter(job => job.fileIndex === fileIndex))
      queuedKeys.clear()

      for (const job of [...pending, ...jobs]) queuedKeys.add(job.key)

      pending.push(...jobs)
      pump()
    },

    poll() {
      const now = performance.now()

      if (runningJob !== undefined && now - runningSince > WATCHDOG_MILLISECONDS) {
        plainFiles.add(runningJob.fileIndex)
        handleFailure()
        pump()
      }

      if (worker !== undefined && runningJob === undefined && now - lastMemoryCheck > MEMORY_CHECK_MILLISECONDS) {
        lastMemoryCheck = now

        if (process.memoryUsage().rss > MEMORY_LIMIT_BYTES) stopWorker()
      }

      const updated = hasUpdate
      hasUpdate = false

      return updated
    },

    dispose() {
      stopWorker()
    },
  }
}
