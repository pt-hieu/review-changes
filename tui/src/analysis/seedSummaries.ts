import { readSync } from 'node:fs'
import type { IndexedGroup } from '../contract.ts'
import type { FileTable } from '../patch/fileTable.ts'
import type { PatchReader } from '../patch/patchReader.ts'
import { scanFileHunks } from '../patch/scanIndex.ts'
import type { SeedFileSummary, SeedSummary } from './largePrompt.ts'

const TOP_FILE_COUNT = 5
const CONTEXT_COUNT = 3
const HUNK_LINE_BYTES = 400

const decoder = new TextDecoder('utf-8', { ignoreBOM: true })

function hunkContext(reader: PatchReader, offset: number): string {
  const buffer = Buffer.alloc(HUNK_LINE_BYTES)
  const byteCount = readSync(reader.descriptor, buffer, 0, HUNK_LINE_BYTES, offset)
  const line = decoder.decode(buffer.subarray(0, byteCount)).split('\n')[0] ?? ''
  const parts = line.split('@@')

  return parts.length >= 3 ? parts.slice(2).join('@@').trim() : ''
}

function contextsOf(table: FileTable, reader: PatchReader, fileIndex: number): string[] {
  const { first, end } = table.hunkRange(fileIndex)

  if (first === end) return []

  const hunks = scanFileHunks(reader.descriptor, table.patchOffset[fileIndex]!, table.patchOffset[fileIndex + 1]!)
  const contexts: string[] = []

  for (let hunkIndex = 0; hunkIndex < hunks.count && contexts.length < CONTEXT_COUNT; hunkIndex++) {
    const context = hunkContext(reader, hunks.offset[hunkIndex]!)

    if (context !== '' && !contexts.includes(context)) contexts.push(context)
  }

  return contexts
}

export function summarizeSeeds(groups: IndexedGroup[], table: FileTable, reader: PatchReader): SeedSummary[] {
  return groups.map(group => {
    const byChurn = [...group.fileIndexes].sort(
      (left, right) => table.additions[right]! + table.deletions[right]! - table.additions[left]! - table.deletions[left]!,
    )
    const topFiles: SeedFileSummary[] = byChurn.slice(0, TOP_FILE_COUNT).map(fileIndex => ({
      path: table.pathOf(fileIndex),
      additions: table.additions[fileIndex]!,
      deletions: table.deletions[fileIndex]!,
      contexts: contextsOf(table, reader, fileIndex),
    }))

    return {
      key: group.key,
      label: group.label,
      fileCount: group.fileIndexes.length,
      additions: group.fileIndexes.reduce((total, fileIndex) => total + table.additions[fileIndex]!, 0),
      deletions: group.fileIndexes.reduce((total, fileIndex) => total + table.deletions[fileIndex]!, 0),
      topFiles,
    }
  })
}
