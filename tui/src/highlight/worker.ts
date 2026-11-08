import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'
import { silenceConsole } from '../terminal/lifecycle.ts'
import { SyntaxSlot, WorkerMessageType } from '../types.ts'
import { LANGUAGE_LOADERS } from './languages.ts'
import type { HighlightReply, WorkerInput, WorkerOutput } from './protocol.ts'

declare const self: {
  onmessage: ((event: { data: WorkerInput }) => void) | null
  postMessage(message: WorkerOutput, transfer?: ArrayBufferLike[]): void
}

const THEME_NAME = 'review-changes'
const MAXIMUM_REGION_BYTES = 4 * 1024 * 1024
const TOKENIZE_MAX_LINE_LENGTH = 2000
const TOKENIZE_TIME_LIMIT_MILLISECONDS = 50
const SLOT_COLORS = ['#000001', '#000002', '#000003', '#000004', '#000005', '#000006', '#000007']

const decoder = new TextDecoder('utf-8', { ignoreBOM: true })

const THEME = {
  name: THEME_NAME,
  type: 'dark' as const,
  colors: { 'editor.foreground': '#000007', 'editor.background': '#000000' },
  settings: [
    { settings: { foreground: '#000007', background: '#000000' } },
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#000001' } },
    { scope: ['string', 'punctuation.definition.string', 'string.quoted'], settings: { foreground: '#000002' } },
    { scope: ['constant', 'constant.numeric', 'constant.language', 'support.constant', 'variable.other.constant'], settings: { foreground: '#000003' } },
    { scope: ['keyword', 'storage', 'storage.type', 'storage.modifier', 'keyword.control', 'entity.name.tag'], settings: { foreground: '#000004' } },
    { scope: ['entity.name.function', 'support.function', 'meta.function-call', 'variable.function'], settings: { foreground: '#000005' } },
    { scope: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class', 'entity.other.inherited-class', 'entity.name.namespace'], settings: { foreground: '#000006' } },
    { scope: ['variable.parameter'], settings: { foreground: '#000007' } },
  ],
}

let highlighter: HighlighterCore | undefined
let descriptor = -1
const loadedLanguages = new Set<string>()
const readBuffer = Buffer.allocUnsafe(MAXIMUM_REGION_BYTES)

function slotOfColor(color: string | undefined): SyntaxSlot {
  if (color === undefined) return SyntaxSlot.Plain

  const index = SLOT_COLORS.indexOf(color.toLowerCase())

  return index === -1 ? SyntaxSlot.Plain : ((index + 1) as SyntaxSlot)
}

async function ensureHighlighter(language: string): Promise<HighlighterCore | undefined> {
  const loader = LANGUAGE_LOADERS[language]

  if (loader === undefined) return undefined

  if (highlighter === undefined) {
    highlighter = await createHighlighterCore({
      themes: [THEME],
      langs: [],
      engine: createOnigurumaEngine(import('shiki/wasm')),
    })
  }

  if (!loadedLanguages.has(language)) {
    await highlighter.loadLanguage((await loader()).default as never)
    loadedLanguages.add(language)
  }

  return highlighter
}

type SideLines = { texts: string[]; rowOfLine: number[] }

function tokenize(core: HighlighterCore, language: string, side: SideLines): Uint32Array[] {
  if (side.texts.length === 0) return []

  const lines = core.codeToTokensBase(side.texts.join('\n'), {
    lang: language,
    theme: THEME_NAME,
    tokenizeMaxLineLength: TOKENIZE_MAX_LINE_LENGTH,
    tokenizeTimeLimit: TOKENIZE_TIME_LIMIT_MILLISECONDS,
  })

  let lineStart = 0

  return lines.map((tokens, lineIndex) => {
    const runs = new Uint32Array(tokens.length * 3)
    const startOfLine = lineStart

    lineStart += (side.texts[lineIndex]?.length ?? 0) + 1

    tokens.forEach((token, index) => {
      runs[index * 3] = Math.max(0, token.offset - startOfLine)
      runs[index * 3 + 1] = slotOfColor(token.color)
      runs[index * 3 + 2] = 0
    })

    return runs
  })
}

async function highlight(request: Extract<WorkerInput, { type: WorkerMessageType.Highlight }>): Promise<HighlightReply | undefined> {
  const core = await ensureHighlighter(request.language)

  if (core === undefined) return undefined

  const length = Math.min(request.length, MAXIMUM_REGION_BYTES)
  const bytesRead = readSync(descriptor, readBuffer, 0, length, request.offset)
  const lines = decoder.decode(readBuffer.subarray(0, bytesRead)).split('\n')
  const oldSide: SideLines = { texts: [], rowOfLine: [] }
  const newSide: SideLines = { texts: [], rowOfLine: [] }

  for (let row = 0; row < request.rowCount; row++) {
    const line = lines[row] ?? ''
    const marker = line.charCodeAt(0)
    const content = line.slice(1).replace(/[\r\u2028\u2029]/g, ' ')

    if (marker === 0x2b) {
      newSide.texts.push(content)
      newSide.rowOfLine.push(row)
    } else if (marker === 0x2d) {
      oldSide.texts.push(content)
      oldSide.rowOfLine.push(row)
    } else if (marker === 0x20) {
      newSide.texts.push(content)
      newSide.rowOfLine.push(row)
      oldSide.texts.push(content)
      oldSide.rowOfLine.push(row)
    }
  }

  const rowRuns: (Uint32Array | undefined)[] = new Array(request.rowCount).fill(undefined)
  const oldRuns = tokenize(core, request.language, oldSide)
  const newRuns = tokenize(core, request.language, newSide)

  oldSide.rowOfLine.forEach((row, index) => {
    if ((lines[row]?.charCodeAt(0) ?? 0) === 0x2d) rowRuns[row] = oldRuns[index]
  })
  newSide.rowOfLine.forEach((row, index) => {
    rowRuns[row] = newRuns[index]
  })

  const offsets = new Uint32Array(request.rowCount + 1)
  let total = 0

  for (let row = 0; row < request.rowCount; row++) {
    offsets[row] = total
    total += rowRuns[row]?.length ?? 0
  }

  offsets[request.rowCount] = total

  const runs = new Uint32Array(total)

  for (let row = 0; row < request.rowCount; row++) {
    const source = rowRuns[row]
    if (source !== undefined) runs.set(source, offsets[row]!)
  }

  return { type: WorkerMessageType.Highlighted, id: request.id, firstRow: request.firstRow, rowCount: request.rowCount, offsets, runs }
}

silenceConsole()

self.onmessage = event => {
  const message = event.data

  if (message.type === WorkerMessageType.Init) {
    if (descriptor >= 0) closeSync(descriptor)

    descriptor = openSync(message.patchPath, 'r')

    if (fstatSync(descriptor).ino !== message.patchInode) {
      closeSync(descriptor)
      descriptor = -1
    }

    return
  }

  highlight(message)
    .then(reply => {
      if (reply === undefined) self.postMessage({ type: WorkerMessageType.Failed, id: message.id })
      else self.postMessage(reply, [reply.offsets.buffer, reply.runs.buffer])
    })
    .catch(() => self.postMessage({ type: WorkerMessageType.Failed, id: message.id }))
}
