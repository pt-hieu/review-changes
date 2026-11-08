import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PatchReader } from '../patch/patchReader.ts'
import { scanPatch } from '../patch/scanIndex.ts'

const directories: string[] = []
const openReaders: PatchReader[] = []

export function scanText(patch: string) {
  const directory = mkdtempSync(join(tmpdir(), 'scanned-patch-'))
  const path = join(directory, 'patch.diff')
  directories.push(directory)
  writeFileSync(path, patch)

  const reader = new PatchReader(path)
  openReaders.push(reader)

  return { reader, table: scanPatch(reader.descriptor, reader.byteLength, { seed: 1 }) }
}

export function closeScannedPatches(): void {
  for (const reader of openReaders.splice(0)) reader.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
}
