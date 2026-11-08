import { existsSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

const KEPT_SESSION_COUNT = 5
const MAXIMUM_SESSIONS_BYTES = 2 * 1024 * 1024 * 1024
const TEMPORARY_ENTRY_MAXIMUM_AGE_MILLISECONDS = 24 * 60 * 60 * 1000

type SessionEntry = { path: string; modifiedTime: number; byteCount: number }

function directoryBytes(path: string): number {
  let total = 0

  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name)

    try {
      total += entry.isDirectory() ? directoryBytes(entryPath) : statSync(entryPath).size
    } catch {
      continue
    }
  }

  return total
}

function removeDirectChild(sessionsDirectory: string, path: string): void {
  try {
    if (dirname(realpathSync(path)) !== realpathSync(sessionsDirectory)) return

    rmSync(path, { recursive: true, force: true })
  } catch {
    return
  }
}

export function pruneSessions(sessionsDirectory: string): void {
  if (!existsSync(sessionsDirectory)) return

  const entries: SessionEntry[] = readdirSync(sessionsDirectory, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const path = join(sessionsDirectory, entry.name)

      return { path, modifiedTime: statSync(path).mtimeMs, byteCount: directoryBytes(path) }
    })
    .sort((left, right) => right.modifiedTime - left.modifiedTime)

  const kept = entries.slice(0, KEPT_SESSION_COUNT)

  for (const entry of entries.slice(KEPT_SESSION_COUNT)) removeDirectChild(sessionsDirectory, entry.path)

  let totalBytes = kept.reduce((total, entry) => total + entry.byteCount, 0)

  for (let position = kept.length - 1; position > 0 && totalBytes > MAXIMUM_SESSIONS_BYTES; position--) {
    removeDirectChild(sessionsDirectory, kept[position]!.path)
    totalBytes -= kept[position]!.byteCount
  }
}

export function pruneTemporaryEntries(temporaryDirectory: string, now: number): void {
  if (!existsSync(temporaryDirectory)) return

  for (const entry of readdirSync(temporaryDirectory, { withFileTypes: true })) {
    const path = join(temporaryDirectory, entry.name)

    try {
      if (now - statSync(path).mtimeMs > TEMPORARY_ENTRY_MAXIMUM_AGE_MILLISECONDS) rmSync(path, { recursive: true, force: true })
    } catch {
      continue
    }
  }
}
