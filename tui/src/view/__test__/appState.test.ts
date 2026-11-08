import { afterAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PseudoTerminal } from '../../__test__/pseudoTerminal.ts'
import { modifiedFilePatch, writeReviewDirectory } from '../../__test__/reviewDirectory.ts'
import { MAXIMUM_ROWS_PER_FILE } from '../../patch/lineIndex.ts'
import { loadReview, type LoadedReview } from '../../session/loadReview.ts'
import { ReviewedStore } from '../../store/reviewedStore.ts'
import { createTheme } from '../../terminal/styles.ts'
import { ReviewApp } from '../appState.ts'
import { FrameWriter } from '../frame.ts'

const temporaryDirectory = join(tmpdir(), `app-state-test-${process.pid}`)
const openReviews: LoadedReview[] = []
const ROWS = 30
const KEY_BAR_ROW = ROWS - 1
const FOCUS_KEYS = ['1', '2', '3', '0']

afterAll(() => {
  for (const review of openReviews) review.reader.close()
  rmSync(temporaryDirectory, { recursive: true, force: true })
})

function openApp(patch: string) {
  const reviewDirectory = writeReviewDirectory(temporaryDirectory, patch)
  const review = loadReview(reviewDirectory, 1)
  openReviews.push(review)

  const app = new ReviewApp({
    review,
    reviewDirectory,
    store: new ReviewedStore(join(reviewDirectory, 'reviewed'), 'app-state-test'),
    theme: createTheme(false),
    highlight: undefined,
    nowMilliseconds: () => Date.now(),
    canZoomPane: false,
  })
  const writer = new FrameWriter()
  const terminal = new PseudoTerminal()

  return {
    press(key: string) {
      app.handleKey(key)
    },
    screen(columns: number): PseudoTerminal {
      for (let step = 0; step < 50; step++) app.tick()

      terminal.feed(writer.render(app.render(columns, ROWS)))

      return terminal
    },
  }
}

const SMALL_PATCH = modifiedFilePatch('src/example.txt', ['needle-in-the-diff', 'second line'])

describe('the key bar', () => {
  test.each([140, 80, 60])('shows 1 summary, 2 groups and 3 diff first and in order at %i columns, whichever panel has focus', columns => {
    const app = openApp(SMALL_PATCH)

    for (const focusKey of FOCUS_KEYS) {
      app.press(focusKey)

      const keyBar = app.screen(columns).textOfRow(KEY_BAR_ROW)

      expect(keyBar.trimStart().startsWith('1 summary 2 groups 3 diff')).toBe(true)
    }
  })
})

describe('switching the main view with the number keys', () => {
  test('1 shows the summary in place of the diff and 3 returns to the diff', () => {
    const app = openApp(SMALL_PATCH)

    expect(app.screen(140).screenText(ROWS)).toContain('needle-in-the-diff')

    app.press('1')

    const summary = app.screen(140).screenText(ROWS)
    expect(summary).not.toContain('needle-in-the-diff')
    expect(summary).toContain('Summary')

    app.press('3')

    expect(app.screen(140).screenText(ROWS)).toContain('needle-in-the-diff')
  })

  test('1 and 3 work from the main panel as well', () => {
    const app = openApp(SMALL_PATCH)

    app.press('0')
    app.press('1')
    expect(app.screen(140).screenText(ROWS)).not.toContain('needle-in-the-diff')

    app.press('3')
    expect(app.screen(140).screenText(ROWS)).toContain('needle-in-the-diff')
  })
})

describe('a file with more rows than the viewer indexes', () => {
  test('says how many rows are shown out of how many', () => {
    const extraRows = 7
    const totalRows = MAXIMUM_ROWS_PER_FILE + extraRows
    const app = openApp(modifiedFilePatch('huge.txt', Array.from({ length: totalRows }, () => '')))

    const text = app.screen(140).screenText(ROWS)

    expect(text).toContain(`Showing the first ${MAXIMUM_ROWS_PER_FILE} of ${totalRows + 1} rows`)
  })
})
