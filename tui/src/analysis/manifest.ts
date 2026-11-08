import type { IndexedGroup } from '../contract.ts'
import type { FileTable } from '../patch/fileTable.ts'
import { FileStatusCode } from '../types.ts'

const STATUS_LETTERS: Record<FileStatusCode, string> = {
  [FileStatusCode.Modified]: 'M',
  [FileStatusCode.Added]: 'A',
  [FileStatusCode.Removed]: 'D',
  [FileStatusCode.Renamed]: 'R',
  [FileStatusCode.Copied]: 'C',
}

export function buildManifest(table: FileTable, seeds: IndexedGroup[]): string {
  const seedKeyOfFile = new Array<string>(table.fileCount).fill('')

  for (const seed of seeds) {
    for (const fileIndex of seed.fileIndexes) seedKeyOfFile[fileIndex] = seed.key
  }

  const lines: string[] = []

  for (let fileIndex = 0; fileIndex < table.fileCount; fileIndex++) {
    lines.push(
      [
        JSON.stringify(table.pathOf(fileIndex)),
        STATUS_LETTERS[table.status[fileIndex] as FileStatusCode] ?? 'M',
        table.additions[fileIndex],
        table.deletions[fileIndex],
        seedKeyOfFile[fileIndex],
        table.patchStartLine[fileIndex]! + 1,
        table.patchStartLine[fileIndex + 1]! - table.patchStartLine[fileIndex]!,
        table.patchOffset[fileIndex + 1]! - table.patchOffset[fileIndex]!,
      ].join('\t'),
    )
  }

  return `${lines.join('\n')}\n`
}
