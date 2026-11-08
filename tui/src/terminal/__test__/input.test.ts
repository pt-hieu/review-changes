import { describe, expect, test } from 'bun:test'
import { InputEventKind } from '../../types.ts'
import { InputParser, type InputEvent } from '../input.ts'

const encoder = new TextEncoder()

function keys(events: InputEvent[]): string[] {
  return events.map(event => (event.kind === InputEventKind.Key ? event.name : `paste:${event.text}`))
}

describe('InputParser', () => {
  test('plain, control and arrow keys', () => {
    const parser = new InputParser()

    expect(keys(parser.feed(encoder.encode('jG \r\x04\x1b[A\x1b[B\x1bOC\x1b[Z')))).toEqual(['j', 'G', 'space', 'enter', 'ctrl+d', 'up', 'down', 'right', 'shift+tab'])
  })

  test('a lone escape is held until it is flushed', () => {
    const parser = new InputParser()

    expect(parser.feed(Uint8Array.of(0x1b))).toEqual([])
    expect(parser.hasPendingEscape()).toBe(true)
    expect(keys(parser.flushEscape())).toEqual(['esc'])
  })

  test('a sequence split across reads is assembled', () => {
    const parser = new InputParser()

    expect(parser.feed(encoder.encode('\x1b['))).toEqual([])
    expect(keys(parser.feed(encoder.encode('5~')))).toEqual(['pageup'])
  })

  test('a multi-byte character split across reads is one key', () => {
    const parser = new InputParser()
    const bytes = encoder.encode('é')

    expect(parser.feed(bytes.subarray(0, 1))).toEqual([])
    expect(keys(parser.feed(bytes.subarray(1)))).toEqual(['é'])
  })

  test('terminal replies are consumed and never become keys', () => {
    const parser = new InputParser()
    const replies = '\x1b[?2026;2$y\x1b]11;rgb:0000/0000/0000\x07\x1b]4;1;rgb:cc/00/00\x1b\\\x1b[?62;4c\x1bP1$r0m\x1b\\'

    expect(keys(parser.feed(encoder.encode(`${replies}x`)))).toEqual(['x'])
  })

  test('a paste is delivered whole and its text never becomes keys', () => {
    const parser = new InputParser()
    const events = parser.feed(encoder.encode('\x1b[200~aaaa\nqqq\x1b[201~j'))

    expect(keys(events)).toEqual(['paste:aaaa\nqqq', 'j'])
  })

  test('a paste split over several reads is delivered once', () => {
    const parser = new InputParser()

    expect(parser.feed(encoder.encode('\x1b[200~qu'))).toEqual([])
    expect(parser.feed(encoder.encode('it'))).toEqual([])
    expect(keys(parser.feed(encoder.encode('\x1b[201~')))).toEqual(['paste:quit'])
  })

  test('an oversized paste is capped and still ends at its terminator', () => {
    const parser = new InputParser()
    const events = parser.feed(encoder.encode(`\x1b[200~${'z'.repeat(100_000)}\x1b[201~k`))

    expect(events[0]).toEqual({ kind: InputEventKind.Paste, text: 'z'.repeat(4096) })
    expect(keys(events.slice(1))).toEqual(['k'])
  })

  test('an overlong control sequence is dropped rather than buffered', () => {
    const parser = new InputParser()
    const events = parser.feed(encoder.encode(`\x1b[${'1;'.repeat(200)}`))

    expect(parser.hasPendingEscape()).toBe(false)
    expect(keys(events).join('')).not.toContain('quit')
  })

  test('modifier arrows carry their modifier', () => {
    const parser = new InputParser()

    expect(keys(parser.feed(encoder.encode('\x1b[1;5C\x1b[1;2A')))).toEqual(['ctrl+right', 'shift+up'])
  })
})
