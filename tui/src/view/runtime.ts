import { spawn } from 'node:child_process'
import { writeSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { loadReview, type LoadedReview } from '../session/loadReview.ts'
import { loadOrCreateSeed, ReviewedStore } from '../store/reviewedStore.ts'
import { createHighlightClient } from '../highlight/client.ts'
import { InputParser, type InputEvent } from '../terminal/input.ts'
import { CLEAR_SCREEN, cursorTo, redirectStandardErrorToLog, silenceConsole, TerminalSession } from '../terminal/lifecycle.ts'
import { onTerminalResize, printLine, terminalSize, writeAll } from '../terminal/output.ts'
import { createTheme } from '../terminal/styles.ts'
import { fitToWidth, sanitizeLine, sliceColumns } from '../text/sanitize.ts'
import { InputEventKind, KeyOutcome } from '../types.ts'
import { ReviewApp } from './appState.ts'
import { FrameWriter } from './frame.ts'

const ESCAPE_RESOLVE_MILLISECONDS = 30
const FAST_TICK_MILLISECONDS = 2
const IDLE_TICK_MILLISECONDS = 50

function reviewedLocation(reviewDirectory: string): { directory: string; slug: string } {
  const parent = dirname(reviewDirectory)

  if (basename(parent) === 'sessions') return { directory: join(dirname(parent), 'reviewed'), slug: basename(reviewDirectory) }

  return { directory: join(reviewDirectory, 'reviewed'), slug: 'session' }
}

function zoomPane(): void {
  const binaryDirectory = process.env.REX_BIN_DIR

  if (binaryDirectory === undefined || binaryDirectory === '') return

  const child = spawn(join(binaryDirectory, 'rex'), ['zoom'], { stdio: 'ignore', detached: true })
  child.on('error', () => {})
  child.unref()
}

export function runApp(reviewDirectory: string): void {
  redirectStandardErrorToLog(reviewDirectory)
  silenceConsole()

  const writer = new FrameWriter()
  const parser = new InputParser()
  let app: ReviewApp | undefined
  let review: LoadedReview | undefined
  let fatalMessage: string | undefined
  let tickTimer: ReturnType<typeof setTimeout> | undefined
  let escapeTimer: ReturnType<typeof setTimeout> | undefined
  let highlightClient: ReturnType<typeof createHighlightClient> | undefined

  const terminal = new TerminalSession(code => process.exit(code))

  const shutdown = (code: number): never => {
    highlightClient?.dispose()
    review?.reader.close()
    terminal.restore()
    process.exit(code)
  }

  const showFatal = (message: string): void => {
    fatalMessage = message
    const { columns } = terminalSize()
    const line = fitToWidth(sliceColumns(sanitizeLine(`${message}  (press any key)`).text, 0, columns), columns)

    writeAll(CLEAR_SCREEN + cursorTo(1, 1) + line)
  }

  const paint = (): void => {
    if (app === undefined || fatalMessage !== undefined) return

    try {
      const { columns, rows } = terminalSize()
      const output = writer.render(app.render(columns, rows))

      app.markRepainted()
      if (output !== '') writeAll(output)
    } catch (error) {
      showFatal(error instanceof Error ? error.message : 'unexpected error')
    }
  }

  const handleEvents = (events: InputEvent[]): void => {
    if (fatalMessage !== undefined) {
      if (events.length > 0) shutdown(1)

      return
    }

    try {
      for (const event of events) {
        if (app === undefined) return

        if (event.kind === InputEventKind.Paste) {
          app.handlePaste(event.text)
          continue
        }

        const outcome = app.handleKey(event.name)

        if (outcome === KeyOutcome.Quit) shutdown(0)
        if (outcome === KeyOutcome.ZoomPane) zoomPane()

        if (outcome === KeyOutcome.Redraw) {
          writer.invalidate()
          writeAll(CLEAR_SCREEN)
        }
      }
    } catch (error) {
      writeSync(2, `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
      showFatal(error instanceof Error ? error.message : 'unexpected error')

      return
    }

    paint()
  }

  const onInput = (chunk: Uint8Array): void => {
    handleEvents(parser.feed(chunk))

    if (escapeTimer !== undefined) clearTimeout(escapeTimer)

    if (parser.hasPendingEscape()) {
      escapeTimer = setTimeout(() => handleEvents(parser.flushEscape()), ESCAPE_RESOLVE_MILLISECONDS)
    }
  }

  const scheduleTick = (): void => {
    const delay = app?.hasFastBackgroundWork === true ? FAST_TICK_MILLISECONDS : IDLE_TICK_MILLISECONDS

    tickTimer = setTimeout(() => {
      try {
        if (app !== undefined && fatalMessage === undefined && (app.tick() || app.hasPendingRepaint)) paint()
      } catch (error) {
        showFatal(error instanceof Error ? error.message : 'unexpected error')
      }

      scheduleTick()
    }, delay)
  }

  if (!process.stdin.isTTY) {
    printLine('review-changes needs an interactive terminal')
    process.exit(1)
  }

  terminal.start(onInput, () => {
    writer.invalidate()
    paint()
  })

  try {
    const location = reviewedLocation(reviewDirectory)
    const seed = loadOrCreateSeed(location.directory)

    review = loadReview(reviewDirectory, seed)
    highlightClient = createHighlightClient(review.table, review.lineIndexes, join(reviewDirectory, review.session.patchFileName), review.reader.inode, () => app?.requestRepaint())
    app = new ReviewApp({
      review,
      reviewDirectory,
      store: new ReviewedStore(location.directory, location.slug),
      theme: createTheme(process.env.NO_COLOR === undefined || process.env.NO_COLOR === ''),
      highlight: highlightClient,
      nowMilliseconds: () => Date.now(),
      canZoomPane: (process.env.REX_BIN_DIR ?? '') !== '' && (process.env.REX_BLOCK ?? '') !== '',
    })
  } catch (error) {
    showFatal(error instanceof Error ? error.message : 'unreadable review')
  }

  onTerminalResize(() => {
    writer.invalidate()
    if (fatalMessage === undefined) writeAll(CLEAR_SCREEN)
    paint()
  })

  paint()
  scheduleTick()
}
