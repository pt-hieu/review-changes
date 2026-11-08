import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUNDLE_PATH } from '../../__test__/bundlePaths.ts'
import { PtyProcess, ROWS } from '../../__test__/ptyProcess.ts'
import { modifiedFilePatch, writeReviewDirectory } from '../../__test__/reviewDirectory.ts'

const temporaryDirectory = join(tmpdir(), `highlight-test-${process.pid}`)
const openProcesses: PtyProcess[] = []

const TEST_TIMEOUT_MILLISECONDS = 40_000
const KEYWORD_STYLE = ';35'
const STRING_STYLE = ';32'

afterEach(() => {
  for (const pty of openProcesses.splice(0)) pty.dispose()
})

afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }))

describe('syntax colours in the built app', () => {
  test('a keyword and a string on a later line of a file are coloured at their own columns', async () => {
    const patch = modifiedFilePatch('src/colours.ts', [
      'const first = 1',
      '// a comment between the lines',
      'let second = 2',
      'export function later() { return "quoted text" }',
    ])
    const pty = new PtyProcess([process.execPath, BUNDLE_PATH, 'open', writeReviewDirectory(temporaryDirectory, patch)])
    openProcesses.push(pty)

    expect(await pty.waitForScreenText('quoted text', 15_000)).toBe(true)
    expect(
      await pty.waitUntil(() => {
        const keyword = pty.screen.locate('export function', ROWS)

        return keyword !== undefined && pty.screen.styleAt(keyword.row, keyword.column).endsWith(KEYWORD_STYLE)
      }, 15_000),
    ).toBe(true)

    const line = pty.screen.locate('export function later', ROWS)!
    const quoted = pty.screen.locate('"quoted text"', ROWS)!
    const styleOfWord = (word: string, start: number) =>
      Array.from({ length: word.length }, (_unused, offset) => pty.screen.styleAt(line.row, start + offset))

    expect(quoted.row).toBe(line.row)
    expect(styleOfWord('export', line.column).every(style => style.endsWith(KEYWORD_STYLE))).toBe(true)
    expect(styleOfWord('function', line.column + 'export '.length).every(style => style.endsWith(KEYWORD_STYLE))).toBe(true)
    expect(styleOfWord('"quoted text"', quoted.column).every(style => style.endsWith(STRING_STYLE))).toBe(true)
    expect(pty.screen.styleAt(line.row, quoted.column - 1).endsWith(STRING_STYLE)).toBe(false)
    expect(pty.screen.styleAt(line.row, quoted.column + '"quoted text"'.length).endsWith(STRING_STYLE)).toBe(false)
  }, TEST_TIMEOUT_MILLISECONDS)
})
