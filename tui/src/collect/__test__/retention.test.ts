import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneSessions, pruneTemporaryEntries } from '../retention.ts'

const roots: string[] = []
const DAY_SECONDS = 24 * 60 * 60
const GIBIBYTE = 1024 * 1024 * 1024

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'retention-test-'))
  roots.push(root)

  return root
}

function addSession(sessionsDirectory: string, name: string, ageSeconds: number, sparseBytes = 0): string {
  const path = join(sessionsDirectory, name)
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'patch.diff'), 'x')

  if (sparseBytes > 0) {
    writeFileSync(join(path, 'big.bin'), '')
    truncateSync(join(path, 'big.bin'), sparseBytes)
  }

  const time = Date.now() / 1000 - ageSeconds
  utimesSync(path, time, time)

  return path
}

describe('pruneSessions', () => {
  test('does nothing when the directory does not exist', () => {
    expect(() => pruneSessions(join(newRoot(), 'missing'))).not.toThrow()
  })

  test('keeps the five most recently modified sessions and removes the rest', () => {
    const sessions = join(newRoot(), 'sessions')
    const names = ['oldest', 'older', 'old', 'mid', 'new', 'newer', 'newest']
    names.forEach((name, position) => addSession(sessions, name, (names.length - position) * 100))

    pruneSessions(sessions)

    expect(names.map(name => existsSync(join(sessions, name)))).toEqual([false, false, true, true, true, true, true])
  })

  test('leaves loose files and symlinks in the directory alone, and never follows a symlink out', () => {
    const root = newRoot()
    const sessions = join(root, 'sessions')
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'precious.txt'), 'keep')
    const names = ['a', 'b', 'c', 'd', 'e', 'f']
    names.forEach((name, position) => addSession(sessions, name, (names.length - position) * 100))
    symlinkSync(outside, join(sessions, 'link'))
    writeFileSync(join(sessions, 'stray.txt'), 'stray')

    pruneSessions(sessions)

    expect(existsSync(join(outside, 'precious.txt'))).toBe(true)
    expect(existsSync(join(sessions, 'stray.txt'))).toBe(true)
    expect(existsSync(join(sessions, 'a'))).toBe(false)
  })

  test('drops the oldest kept sessions when the total is over 2 GiB, but never the newest', () => {
    const sessions = join(newRoot(), 'sessions')
    addSession(sessions, 'oldest', 300, GIBIBYTE * 1.5)
    addSession(sessions, 'middle', 200, GIBIBYTE * 1.5)
    addSession(sessions, 'newest', 100, GIBIBYTE * 1.5)

    pruneSessions(sessions)

    expect(existsSync(join(sessions, 'newest'))).toBe(true)
    expect(existsSync(join(sessions, 'middle'))).toBe(false)
    expect(existsSync(join(sessions, 'oldest'))).toBe(false)
  })

  test('keeps everything within the cap', () => {
    const sessions = join(newRoot(), 'sessions')
    addSession(sessions, 'older', 200, GIBIBYTE * 0.5)
    addSession(sessions, 'newer', 100, GIBIBYTE * 0.5)

    pruneSessions(sessions)

    expect([existsSync(join(sessions, 'older')), existsSync(join(sessions, 'newer'))]).toEqual([true, true])
  })
})

describe('pruneTemporaryEntries', () => {
  test('does nothing when the directory does not exist', () => {
    expect(() => pruneTemporaryEntries(join(newRoot(), 'missing'), Date.now())).not.toThrow()
  })

  test('removes files and directories older than a day and keeps newer ones', () => {
    const temporary = join(newRoot(), 'tmp')
    mkdirSync(join(temporary, 'old-directory'), { recursive: true })
    writeFileSync(join(temporary, 'old-directory', 'inner'), 'x')
    writeFileSync(join(temporary, 'old-file'), 'x')
    writeFileSync(join(temporary, 'fresh-file'), 'x')
    mkdirSync(join(temporary, 'fresh-directory'))
    const stale = Date.now() / 1000 - DAY_SECONDS - 60
    utimesSync(join(temporary, 'old-directory'), stale, stale)
    utimesSync(join(temporary, 'old-file'), stale, stale)

    pruneTemporaryEntries(temporary, Date.now())

    expect(['old-directory', 'old-file', 'fresh-file', 'fresh-directory'].map(name => existsSync(join(temporary, name)))).toEqual([false, false, true, true])
  })

  test('a clock that is ahead removes entries by the given time, not the real one', () => {
    const temporary = join(newRoot(), 'tmp')
    mkdirSync(temporary)
    writeFileSync(join(temporary, 'file'), 'x')

    pruneTemporaryEntries(temporary, Date.now() + (DAY_SECONDS + 60) * 1000)

    expect(existsSync(join(temporary, 'file'))).toBe(false)
  })
})
