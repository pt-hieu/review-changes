import { closeSync, openSync, writeSync } from 'node:fs'
import { constants } from 'node:os'
import { join } from 'node:path'
import { writeAll } from './output.ts'

const ESCAPE = String.fromCharCode(27)
const STANDARD_ERROR = 2

export const ENTER_SEQUENCE = `${ESCAPE}[?1049h${ESCAPE}[?25l${ESCAPE}[?7l${ESCAPE}[?2004h${ESCAPE}[2J`
export const LEAVE_SEQUENCE = `${ESCAPE}[?2026l${ESCAPE}[?2004l${ESCAPE}[?7h${ESCAPE}[?25h${ESCAPE}[0m${ESCAPE}[?1049l`
export const BEGIN_FRAME = `${ESCAPE}[?2026h`
export const END_FRAME = `${ESCAPE}[?2026l`

export function cursorTo(row: number, column: number): string {
  return `${ESCAPE}[${Math.trunc(row)};${Math.trunc(column)}H`
}

export const CLEAR_SCREEN = `${ESCAPE}[2J`

export function redirectStandardErrorToLog(reviewDirectory: string): void {
  closeSync(STANDARD_ERROR)

  try {
    openSync(join(reviewDirectory, 'crash.log'), 'w')
  } catch {
    openSync('/dev/null', 'w')
  }
}

export function silenceConsole(): void {
  const silent = (): void => {}
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'table', 'dir'] as const

  for (const method of methods) console[method] = silent
}

const TERMINATING_SIGNALS = [
  'SIGTERM',
  'SIGHUP',
  'SIGINT',
  'SIGQUIT',
  'SIGUSR1',
  'SIGUSR2',
  'SIGALRM',
  'SIGVTALRM',
  'SIGXCPU',
  'SIGXFSZ',
  'SIGPIPE',
] as const
const SIGNAL_EXIT_BASE = 128
const FAILURE_EXIT_CODE = 1

function describeFailure(reason: unknown): string {
  return reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
}

export class TerminalSession {
  private isActive = false
  private readonly onExit: (code: number) => void
  private onResume: () => void = () => {}

  constructor(onExit: (code: number) => void) {
    this.onExit = onExit
  }

  start(onInput: (chunk: Uint8Array) => void, onResume: () => void = () => {}): void {
    this.onResume = onResume
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', onInput)
    writeAll(ENTER_SEQUENCE)
    this.isActive = true

    for (const signal of TERMINATING_SIGNALS) {
      process.on(signal, () => this.stop(SIGNAL_EXIT_BASE + (constants.signals[signal] ?? 0)))
    }

    process.on('SIGTSTP', () => this.suspend())
    process.on('SIGCONT', () => this.resume())
    process.on('uncaughtException', error => this.fail(error))
    process.on('unhandledRejection', reason => this.fail(reason))
  }

  restore(): void {
    if (!this.isActive) return

    this.isActive = false

    try {
      writeAll(LEAVE_SEQUENCE)
      process.stdin.setRawMode(false)
    } catch {
      return
    }
  }

  stop(code = 0): void {
    this.restore()
    this.onExit(code)
  }

  private fail(reason: unknown): void {
    try {
      writeSync(STANDARD_ERROR, `${describeFailure(reason)}\n`)
    } catch {
      this.restore()
    }

    this.stop(FAILURE_EXIT_CODE)
  }

  private suspend(): void {
    this.restore()
    process.kill(process.pid, 'SIGSTOP')
  }

  private resume(): void {
    if (this.isActive) return

    try {
      process.stdin.setRawMode(true)
      writeAll(ENTER_SEQUENCE)
      this.isActive = true
      this.onResume()
    } catch {
      this.stop(FAILURE_EXIT_CODE)
    }
  }
}
