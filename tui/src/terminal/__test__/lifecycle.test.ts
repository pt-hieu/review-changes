import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUNDLE_PATH } from '../../__test__/bundlePaths.ts'
import { PtyProcess } from '../../__test__/ptyProcess.ts'
import { writeReviewDirectory, modifiedFilePatch } from '../../__test__/reviewDirectory.ts'
import { ENTER_SEQUENCE, LEAVE_SEQUENCE } from '../lifecycle.ts'

const temporaryDirectory = join(tmpdir(), `lifecycle-test-${process.pid}`)
const TEST_TIMEOUT_MILLISECONDS = 40_000
const openProcesses: PtyProcess[] = []

afterEach(() => {
  for (const pty of openProcesses.splice(0)) pty.dispose()
})

afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }))

async function startApp(): Promise<PtyProcess> {
  const reviewDirectory = writeReviewDirectory(temporaryDirectory, modifiedFilePatch('src/greeting.txt', ['hello', 'world']))
  const pty = new PtyProcess([process.execPath, BUNDLE_PATH, 'open', reviewDirectory])
  openProcesses.push(pty)

  expect(await pty.waitForScreenText('greeting.txt', 15_000)).toBe(true)

  return pty
}

describe('the terminal session of the built app', () => {
  test.each([
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ] as const)('%s restores the terminal and exits with 128 plus the signal number', async (signal, expectedExitCode) => {
    const pty = await startApp()
    pty.clearReceived()

    pty.process.kill(signal)

    expect(await pty.exitCode(10_000)).toBe(expectedExitCode)
    expect(pty.received).toContain(LEAVE_SEQUENCE)
  }, TEST_TIMEOUT_MILLISECONDS)

  test('q restores the terminal and exits with 0', async () => {
    const pty = await startApp()
    pty.clearReceived()

    pty.send('q')

    expect(await pty.exitCode(10_000)).toBe(0)
    expect(pty.received).toContain(LEAVE_SEQUENCE)
  }, TEST_TIMEOUT_MILLISECONDS)

  test('suspending leaves the alternate screen and resuming re-enters it and repaints', async () => {
    const pty = await startApp()
    pty.clearReceived()

    pty.process.kill('SIGTSTP')

    expect(await pty.waitForOutput(LEAVE_SEQUENCE, 10_000)).toBe(true)
    expect(pty.received).not.toContain(ENTER_SEQUENCE)

    pty.clearReceived()
    pty.process.kill('SIGCONT')

    expect(await pty.waitForOutput(ENTER_SEQUENCE, 10_000)).toBe(true)
    expect(await pty.waitUntil(() => pty.received.includes('greeting.txt') && pty.received.includes('hello'), 10_000)).toBe(true)
    expect(pty.received.indexOf(ENTER_SEQUENCE)).toBeLessThan(pty.received.indexOf('greeting.txt'))
  }, TEST_TIMEOUT_MILLISECONDS)
})
