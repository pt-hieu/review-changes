import { InputEventKind } from '../types.ts'

export type InputEvent = { kind: InputEventKind.Key; name: string } | { kind: InputEventKind.Paste; text: string }

const ESCAPE = 0x1b
const BELL = 0x07
const MAXIMUM_SEQUENCE_BYTES = 64
const MAXIMUM_PASTE_CHARACTERS = 4096
const PASTE_END = [0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e]
const MODIFIER_NAMES = ['', 'shift', 'alt', 'alt+shift', 'ctrl', 'ctrl+shift', 'ctrl+alt', 'ctrl+alt+shift']

const CURSOR_KEYS = new Map<string, string>([
  ['A', 'up'],
  ['B', 'down'],
  ['C', 'right'],
  ['D', 'left'],
  ['H', 'home'],
  ['F', 'end'],
  ['Z', 'shift+tab'],
])

const TILDE_KEYS = new Map<number, string>([
  [1, 'home'],
  [3, 'delete'],
  [4, 'end'],
  [5, 'pageup'],
  [6, 'pagedown'],
  [7, 'home'],
  [8, 'end'],
])

const utf8Decoder = new TextDecoder('utf-8', { ignoreBOM: true })

function withModifier(modifierCode: number, name: string): string {
  const modifier = MODIFIER_NAMES[modifierCode - 1]

  return modifier === undefined || modifier === '' ? name : `${modifier}+${name}`
}

function singleByteKeyName(byte: number): string | undefined {
  if (byte === 0x0d || byte === 0x0a) return 'enter'
  if (byte === 0x09) return 'tab'
  if (byte === 0x7f || byte === 0x08) return 'backspace'
  if (byte === 0x20) return 'space'
  if (byte >= 0x01 && byte <= 0x1a) return `ctrl+${String.fromCharCode(0x60 + byte)}`
  if (byte >= 0x21 && byte < 0x7f) return String.fromCharCode(byte)

  return undefined
}

function utf8Length(leadByte: number): number {
  if (leadByte >= 0xf0 && leadByte < 0xf8) return 4
  if (leadByte >= 0xe0) return leadByte < 0xf0 ? 3 : 1
  if (leadByte >= 0xc2 && leadByte < 0xe0) return 2

  return 1
}

function csiKeyName(parameters: string, finalByte: string): string | undefined {
  const parts = parameters.split(';')
  const modifierCode = Number(parts[1] ?? 1) || 1

  if (finalByte === '~') {
    const name = TILDE_KEYS.get(Number(parts[0]))

    return name === undefined ? undefined : withModifier(modifierCode, name)
  }

  const name = CURSOR_KEYS.get(finalByte)

  return name === undefined ? undefined : withModifier(modifierCode, name)
}

export class InputParser {
  private pending: number[] = []
  private pasteText: string | undefined
  private pasteBytes: number[] = []
  private pasteTail: number[] = []

  hasPendingEscape(): boolean {
    return this.pending.length === 1 && this.pending[0] === ESCAPE
  }

  flushEscape(): InputEvent[] {
    if (!this.hasPendingEscape()) return []

    this.pending = []

    return [{ kind: InputEventKind.Key, name: 'esc' }]
  }

  feed(chunk: Uint8Array): InputEvent[] {
    const bytes = this.pending.length > 0 ? Uint8Array.from([...this.pending, ...chunk]) : chunk
    const events: InputEvent[] = []
    this.pending = []
    let cursor = 0

    while (cursor < bytes.length) {
      if (this.pasteText !== undefined) {
        cursor = this.consumePaste(bytes, cursor, events)
        continue
      }

      const consumed = this.parseOne(bytes, cursor, events)

      if (consumed === 0) {
        this.pending = Array.from(bytes.subarray(cursor))
        break
      }

      cursor += consumed
    }

    return events
  }

  private consumePaste(bytes: Uint8Array, start: number, events: InputEvent[]): number {
    const storageLimit = MAXIMUM_PASTE_CHARACTERS * 4
    let cursor = start

    while (cursor < bytes.length) {
      const byte = bytes[cursor]!
      cursor++

      if (this.pasteBytes.length < storageLimit + PASTE_END.length) this.pasteBytes.push(byte)

      this.pasteTail.push(byte)
      if (this.pasteTail.length > PASTE_END.length) this.pasteTail.shift()

      if (this.pasteTail.length === PASTE_END.length && PASTE_END.every((expected, offset) => this.pasteTail[offset] === expected)) {
        const hasOverflowed = this.pasteBytes.length >= storageLimit + PASTE_END.length
        const content = hasOverflowed ? this.pasteBytes.slice(0, storageLimit) : this.pasteBytes.slice(0, this.pasteBytes.length - PASTE_END.length)
        const decoded = utf8Decoder.decode(Uint8Array.from(content))

        events.push({ kind: InputEventKind.Paste, text: decoded.slice(0, MAXIMUM_PASTE_CHARACTERS) })
        this.pasteText = undefined
        this.pasteBytes = []
        this.pasteTail = []

        return cursor
      }
    }

    return cursor
  }

  private parseOne(bytes: Uint8Array, start: number, events: InputEvent[]): number {
    const first = bytes[start]!

    if (first === ESCAPE) return this.parseEscape(bytes, start, events)

    if (first >= 0x80) {
      const length = utf8Length(first)

      if (start + length > bytes.length) return 0

      const text = utf8Decoder.decode(bytes.subarray(start, start + length))
      events.push({ kind: InputEventKind.Key, name: [...text][0] ?? '' })

      return length
    }

    const name = singleByteKeyName(first)
    if (name !== undefined) events.push({ kind: InputEventKind.Key, name })

    return 1
  }

  private parseEscape(bytes: Uint8Array, start: number, events: InputEvent[]): number {
    if (start + 1 >= bytes.length) return 0

    const introducer = bytes[start + 1]!

    if (introducer === 0x5b) return this.parseControlSequence(bytes, start, events)

    if (introducer === 0x4f) {
      if (start + 2 >= bytes.length) return 0

      const name = CURSOR_KEYS.get(String.fromCharCode(bytes[start + 2]!))
      if (name !== undefined) events.push({ kind: InputEventKind.Key, name })

      return 3
    }

    if (introducer === 0x5d || introducer === 0x50 || introducer === 0x5f || introducer === 0x5e || introducer === 0x58) {
      return this.skipStringSequence(bytes, start)
    }

    if (introducer === ESCAPE) {
      events.push({ kind: InputEventKind.Key, name: 'esc' })

      return 1
    }

    const name = singleByteKeyName(introducer)
    events.push({ kind: InputEventKind.Key, name: name === undefined ? 'esc' : `alt+${name}` })

    return 2
  }

  private parseControlSequence(bytes: Uint8Array, start: number, events: InputEvent[]): number {
    let cursor = start + 2

    while (cursor < bytes.length && bytes[cursor]! >= 0x20 && bytes[cursor]! <= 0x3f) {
      if (cursor - start > MAXIMUM_SEQUENCE_BYTES) return cursor - start + 1
      cursor++
    }

    if (cursor >= bytes.length) return 0

    const finalByte = String.fromCharCode(bytes[cursor]!)
    const parameters = String.fromCharCode(...bytes.subarray(start + 2, cursor))
    const consumed = cursor - start + 1

    if (finalByte === '~' && parameters === '200') {
      this.pasteText = ''
      this.pasteBytes = []
      this.pasteTail = []

      return consumed
    }

    const name = csiKeyName(parameters, finalByte)
    if (name !== undefined) events.push({ kind: InputEventKind.Key, name })

    return consumed
  }

  private skipStringSequence(bytes: Uint8Array, start: number): number {
    for (let cursor = start + 2; cursor < bytes.length; cursor++) {
      const byte = bytes[cursor]!

      if (byte === BELL) return cursor - start + 1
      if (byte === ESCAPE && cursor + 1 < bytes.length && bytes[cursor + 1] === 0x5c) return cursor - start + 2
      if (byte === ESCAPE && cursor + 1 >= bytes.length) return 0
      if (cursor - start > MAXIMUM_SEQUENCE_BYTES * 16) return cursor - start + 1
    }

    return 0
  }
}
