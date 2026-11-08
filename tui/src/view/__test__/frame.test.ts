import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReviewCategory, ReviewLineSide, ReviewTargetKind, ReviewVisualChange } from '../../review/types.ts'
import { REVIEW_SESSION_SCHEMA_VERSION, type ReviewSession, type SessionAnalysis } from '../../contract.ts'
import { loadReview, type LoadedReview } from '../../session/loadReview.ts'
import { ReviewedStore } from '../../store/reviewedStore.ts'
import { createTheme } from '../../terminal/styles.ts'
import { AnalysisStatus } from '../../types.ts'
import { ReviewApp } from '../appState.ts'
import { FrameWriter } from '../frame.ts'

const ESC = '\x1b'
const HOSTILE_PATH = `evil${ESC}]52;c;QUJD\x07${ESC}[2J‮ㅤ.ts`
const HOSTILE_TEXT = `${ESC}]52;c;QUJD\x07 ${ESC}P1$r${ESC}\\ ${ESC}_Gpayload${ESC}\\ \u009b2J ‮⁦ ㅤ \u{e0100} ﻿X \u{1f600}‍\u{1f600} ́́́́́́`
const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{Noncharacter_Code_Point}]/u

function hostilePatch(): Buffer {
  const parts = [
    `diff --git a/${HOSTILE_PATH} b/${HOSTILE_PATH}\n`,
    'index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644\n',
    `--- a/${HOSTILE_PATH}\n`,
    `+++ b/${HOSTILE_PATH}\n`,
    '@@ -1,2 +1,2 @@ heading \x1b[31mred\n',
    `-old ${HOSTILE_TEXT}\n`,
    `+new ${HOSTILE_TEXT}\n`,
    ' context\x1b[2Jline\x9b\n',
  ]

  return Buffer.concat([Buffer.from(parts.join('').replace('\u009b', ''), 'utf8'), Buffer.from([0x20, 0xc2, 0x9b, 0xff, 0xfe, 0x0a])])
}

function walkOutput(output: string): { problems: string[]; plainText: string } {
  const problems: string[] = []
  let plainText = ''

  for (let index = 0; index < output.length; ) {
    const character = output[index]!

    if (character !== ESC) {
      plainText += character
      index++
      continue
    }

    const match = /^\x1b\[(\?)?([0-9;]*)([A-Za-z])/.exec(output.slice(index, index + 64))

    if (match === null) {
      problems.push(`unexpected escape at ${index}`)
      index++
      continue
    }

    const [sequence, isPrivate, parameters, final] = match as unknown as [string, string | undefined, string, string]
    const isCursorMove = final === 'H' && isPrivate === undefined && /^\d+;\d+$/.test(parameters)
    const isStyle = final === 'm' && isPrivate === undefined
    const isSynchronizedUpdate = (final === 'h' || final === 'l') && isPrivate === '?' && parameters === '2026'

    if (!isCursorMove && !isStyle && !isSynchronizedUpdate) problems.push(`forbidden sequence ${JSON.stringify(sequence)}`)

    index += sequence.length
  }

  return { problems, plainText }
}

describe('frames built from attacker-controlled review data', () => {
  let directory: string
  let review: LoadedReview

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'review-changes-frame-test-'))
    const patch = hostilePatch()
    writeFileSync(join(directory, 'patch.diff'), patch)

    const session: ReviewSession = {
      schemaVersion: REVIEW_SESSION_SCHEMA_VERSION,
      reviewId: 'review-1',
      patchDigest: 'digest',
      generatedAt: '2026-01-01T00:00:00.000Z',
      repository: { root: '/tmp/repo', name: `repo ${HOSTILE_TEXT}` },
      target: { kind: ReviewTargetKind.Worktree, key: 'worktree', label: `label ${HOSTILE_TEXT}`, branch: null, base: 'HEAD' },
      title: `title ${HOSTILE_TEXT}`,
      description: `description ${HOSTILE_TEXT}`,
      commits: [{ sha: 'abcdef1234567', subject: `subject ${HOSTILE_TEXT}`, author: `author ${HOSTILE_TEXT}` }],
      patchFileName: 'patch.diff',
      patchByteLength: patch.length,
    }

    const analysis: SessionAnalysis = {
      schemaVersion: REVIEW_SESSION_SCHEMA_VERSION,
      reviewId: 'review-1',
      status: AnalysisStatus.Ready,
      analysisStartedAt: '2026-01-01T00:00:00.000Z',
      error: HOSTILE_TEXT,
      overallSummary: `summary ${HOSTILE_TEXT}`,
      groups: [
        {
          key: 'group',
          label: `group ${HOSTILE_TEXT}`,
          category: ReviewCategory.Core,
          summary: `group summary ${HOSTILE_TEXT}`,
          critical: true,
          fileIndexes: [0],
          fileNotes: [{ fileIndex: 0, text: `file note ${HOSTILE_TEXT}`, critical: true }],
          lineNotes: [{ fileIndex: 0, side: ReviewLineSide.Additions, line: 1, text: `line note ${HOSTILE_TEXT}`, critical: true }],
          visual: {
            caption: `caption ${HOSTILE_TEXT}`,
            lines: [{ text: `visual ${HOSTILE_TEXT}`, depth: 1, change: ReviewVisualChange.Added, anchor: { fileIndex: 0 } }],
          },
        },
      ],
    }

    writeFileSync(join(directory, 'review.json'), JSON.stringify(session))
    writeFileSync(join(directory, 'analysis.json'), JSON.stringify(analysis))
    review = loadReview(directory, 99)
  })

  afterAll(() => {
    review.reader.close()
    rmSync(directory, { recursive: true, force: true })
  })

  function collectFrames(columns: number, rows: number, keySequence: string[]): string {
    const app = new ReviewApp({
      review,
      reviewDirectory: directory,
      store: new ReviewedStore(join(directory, 'reviewed'), 'frame-test'),
      theme: createTheme(true),
      highlight: undefined,
      nowMilliseconds: () => Date.now(),
      canZoomPane: false,
    })
    const writer = new FrameWriter()
    let output = writer.render(app.render(columns, rows))

    for (const key of keySequence) {
      app.handleKey(key)
      app.tick()
      output += writer.render(app.render(columns, rows))
    }

    return output
  }

  const keySequence = ['2', '1', '?', 'esc', '3', 'l', 'j', 'c', 'm', '/', 'x', 'y', 'esc', '2', 'l', 'enter', 'esc', 'i', 'H', 'L']

  test.each([
    [140, 40],
    [100, 30],
    [60, 20],
    [42, 11],
  ])('every byte written at %ix%i is a cursor move, style or synchronized-update sequence', (columns, rows) => {
    const { problems } = walkOutput(collectFrames(columns, rows, keySequence))

    expect(problems).toEqual([])
  })

  test('no control, bidirectional or invisible character reaches the terminal as itself', () => {
    const { plainText } = walkOutput(collectFrames(140, 40, keySequence))

    expect(plainText.match(FORBIDDEN)).toBeNull()
  })

  test('hostile characters stay visible as harmless text', () => {
    const { plainText } = walkOutput(collectFrames(140, 40, keySequence))

    expect(plainText).toContain('␛')
    expect(plainText).toContain('<U+202E>')
    expect(plainText).toContain('<U+3164>')
    expect(plainText).toContain('<U+E0100>')
    expect(plainText).toContain('<U+009B>')
  })
})
