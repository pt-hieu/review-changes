import { writeSync } from 'node:fs'

const STANDARD_OUTPUT = 1

export function writeAll(text: string): void {
  const bytes = Buffer.from(text, 'utf8')
  let written = 0

  while (written < bytes.length) {
    written += writeSync(STANDARD_OUTPUT, bytes, written, bytes.length - written)
  }
}

export function terminalSize(): { columns: number; rows: number } {
  return { columns: process.stdout.columns || 80, rows: process.stdout.rows || 24 }
}

export function onTerminalResize(listener: () => void): void {
  process.stdout.on('resize', listener)
}

export function printLine(text: string): void {
  process.stdout.write(`${text}\n`)
}

export function printError(text: string): void {
  process.stderr.write(`${text}\n`)
}
