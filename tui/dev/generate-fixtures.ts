import { closeSync, mkdirSync, mkdtempSync, openSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REVIEW_SESSION_SCHEMA_VERSION, type ReviewSession } from '../src/contract.ts'
import { ReviewTargetKind } from '../src/review/types.ts'
import { FixtureScenario, type FixtureSummary } from './types.ts'

const OUTPUT_BUFFER_BYTES = 8 * 1024 * 1024
const MEBIBYTE = 1024 * 1024

class FixtureWriter {
  readonly hasher = new Bun.CryptoHasher('sha256')
  bytesWritten = 0
  private readonly buffer = Buffer.allocUnsafe(OUTPUT_BUFFER_BYTES)
  private used = 0

  constructor(private readonly fileDescriptor: number) {}

  write(data: Uint8Array | string): void {
    const bytes = typeof data === 'string' ? Buffer.from(data) : data

    if (bytes.length > this.buffer.length - this.used) this.flush()

    if (bytes.length > this.buffer.length) {
      this.hasher.update(bytes)
      writeSync(this.fileDescriptor, bytes)
      this.bytesWritten += bytes.length
      return
    }

    this.buffer.set(bytes, this.used)
    this.used += bytes.length
    this.bytesWritten += bytes.length
  }

  flush(): void {
    if (this.used === 0) return

    const chunk = this.buffer.subarray(0, this.used)
    this.hasher.update(chunk)
    writeSync(this.fileDescriptor, chunk)
    this.used = 0
  }
}

type HunkVariant = { body: Buffer; oldLines: number; newLines: number; additions: number; deletions: number }

function lineWithPrefix(prefix: string, serial: number, lineBytes: number): string {
  const filler = `const value${serial} = compute(input, ${serial});`.padEnd(lineBytes, 'x').slice(0, lineBytes - 2)

  return `${prefix}${filler}\n`
}

function buildHunkVariant(lineBytes: number, contextLines: number, changeBlocks: number, blockSize: number, seedSerial: number): HunkVariant {
  const lines: string[] = []
  let serial = seedSerial
  let oldLines = 0
  let newLines = 0
  let additions = 0
  let deletions = 0

  for (let index = 0; index < contextLines; index++) {
    lines.push(lineWithPrefix(' ', serial++, lineBytes))
    oldLines++
    newLines++
  }

  for (let blockIndex = 0; blockIndex < changeBlocks; blockIndex++) {
    for (let index = 0; index < blockSize; index++) {
      lines.push(lineWithPrefix('-', serial++, lineBytes))
      oldLines++
      deletions++
    }

    for (let index = 0; index < blockSize + 1; index++) {
      lines.push(lineWithPrefix('+', serial++, lineBytes))
      newLines++
      additions++
    }

    for (let index = 0; index < contextLines; index++) {
      lines.push(lineWithPrefix(' ', serial++, lineBytes))
      oldLines++
      newLines++
    }
  }

  return { body: Buffer.from(lines.join('')), oldLines, newLines, additions, deletions }
}

function hashOf(serial: number, salt: number): string {
  return (serial * 2654435761 + salt).toString(16).padStart(8, '0').slice(-8).repeat(5)
}

function sortedPathOf(index: number): string {
  const zeroPadded = (value: number, width: number): string => String(value).padStart(width, '0')

  return `src/pkg${zeroPadded(Math.floor(index / 400), 3)}/mod${zeroPadded(Math.floor(index / 20) % 20, 2)}/file${zeroPadded(index % 20, 2)}.ts`
}

function shuffledOrder(count: number): number[] {
  const order = Array.from({ length: count }, (_, index) => index)
  let state = 0x2545f491

  for (let index = count - 1; index > 0; index--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    const swapIndex = state % (index + 1)
    const held = order[index]!
    order[index] = order[swapIndex]!
    order[swapIndex] = held
  }

  return order
}

type Counters = { fileCount: number; hunkCount: number; additions: number; deletions: number }

function writeModifiedFiles(writer: FixtureWriter, counters: Counters, fileCount: number, hunksPerFile: number, lineBytes: number, extraContextLines: number = 0): void {
  const variants = [
    buildHunkVariant(lineBytes, 3 + extraContextLines, 1, 2, 0),
    buildHunkVariant(lineBytes, 3 + extraContextLines, 2, 3, 1000),
    buildHunkVariant(lineBytes, 3 + extraContextLines, 3, 1, 2000),
    buildHunkVariant(lineBytes, 2 + extraContextLines, 1, 6, 3000),
  ]

  for (let fileIndex = 0; fileIndex < fileCount; fileIndex++) {
    const path = sortedPathOf(fileIndex)
    writer.write(
      `diff --git a/${path} b/${path}\nindex ${hashOf(fileIndex, 1)}..${hashOf(fileIndex, 2)} 100644\n--- a/${path}\n+++ b/${path}\n`,
    )

    let oldStart = 1
    let newStart = 1

    for (let hunkIndex = 0; hunkIndex < hunksPerFile; hunkIndex++) {
      const variant = variants[(fileIndex + hunkIndex) % variants.length]!
      writer.write(`@@ -${oldStart},${variant.oldLines} +${newStart},${variant.newLines} @@ function context${hunkIndex}\n`)
      writer.write(variant.body)
      oldStart += variant.oldLines + 40
      newStart += variant.newLines + 40
      counters.hunkCount++
      counters.additions += variant.additions
      counters.deletions += variant.deletions
    }

    counters.fileCount++
  }
}

function writeBigFile(writer: FixtureWriter, counters: Counters, changedLines: number): void {
  const half = changedLines / 2

  writer.write(`diff --git a/big.ts b/big.ts\nindex ${hashOf(1, 1)}..${hashOf(1, 2)} 100644\n--- a/big.ts\n+++ b/big.ts\n@@ -1,${half} +1,${half} @@\n`)

  for (let index = 0; index < half; index++) writer.write(lineWithPrefix('-', index, 60))
  for (let index = 0; index < half; index++) writer.write(lineWithPrefix('+', index, 60))

  counters.fileCount = 1
  counters.hunkCount = 1
  counters.additions = half
  counters.deletions = half
}

function writeLongLine(writer: FixtureWriter, counters: Counters, lineByteCount: number): void {
  writer.write(`diff --git a/min.js b/min.js\nindex ${hashOf(1, 1)}..${hashOf(1, 2)} 100644\n--- a/min.js\n+++ b/min.js\n@@ -1,2 +1,3 @@\n context line\n`)
  writer.write('+')

  const piece = Buffer.alloc(MEBIBYTE, 'var a=1;function f(x){return x+1}')
  for (let written = 0; written < lineByteCount; written += piece.length) {
    writer.write(piece.subarray(0, Math.min(piece.length, lineByteCount - written)))
  }

  writer.write('\n context after\n')
  writer.write(`diff --git a/after.ts b/after.ts\nindex ${hashOf(2, 1)}..${hashOf(2, 2)} 100644\n--- a/after.ts\n+++ b/after.ts\n@@ -1 +1 @@\n-old\n+new\n`)

  counters.fileCount = 2
  counters.hunkCount = 2
  counters.additions = 2
  counters.deletions = 1
}

function writeEntries(writer: FixtureWriter, counters: Counters, entryCount: number): void {
  for (const index of shuffledOrder(entryCount)) {
    const path = sortedPathOf(index)

    if (index % 2 === 0) {
      writer.write(`diff --git a/old/${path} b/${path}\nsimilarity index 100%\nrename from old/${path}\nrename to ${path}\n`)
    } else {
      writer.write(
        `diff --git a/${path} b/${path}\nindex ${hashOf(index, 1)}..${hashOf(index, 2)} 100644\nBinary files a/${path} and b/${path} differ\n`,
      )
    }

    counters.fileCount++
  }
}

type ScenarioPlan = { generate: (writer: FixtureWriter, counters: Counters) => void }

const SCENARIO_PLANS: Record<FixtureScenario, ScenarioPlan> = {
  [FixtureScenario.Baseline]: { generate: (writer, counters) => writeModifiedFiles(writer, counters, 5000, 26, 40) },
  [FixtureScenario.Stress]: { generate: (writer, counters) => writeModifiedFiles(writer, counters, 20000, 32, 40) },
  [FixtureScenario.ShortLines]: { generate: (writer, counters) => writeModifiedFiles(writer, counters, 20000, 90, 6, 12) },
  [FixtureScenario.BigFile]: { generate: (writer, counters) => writeBigFile(writer, counters, 200000) },
  [FixtureScenario.LongLine]: { generate: (writer, counters) => writeLongLine(writer, counters, MEBIBYTE) },
  [FixtureScenario.HugeLine]: { generate: (writer, counters) => writeLongLine(writer, counters, 300 * MEBIBYTE) },
  [FixtureScenario.Entries]: { generate: (writer, counters) => writeEntries(writer, counters, 50000) },
}

export function generateFixture(scenario: FixtureScenario, parentDirectory: string = tmpdir()): FixtureSummary {
  mkdirSync(parentDirectory, { recursive: true })
  const reviewDirectory = mkdtempSync(join(parentDirectory, `review-changes-${scenario}-`))
  const patchFileName = 'patch.diff'
  const started = performance.now()
  const fileDescriptor = openSync(join(reviewDirectory, patchFileName), 'w')
  const writer = new FixtureWriter(fileDescriptor)
  const counters: Counters = { fileCount: 0, hunkCount: 0, additions: 0, deletions: 0 }

  SCENARIO_PLANS[scenario].generate(writer, counters)
  writer.flush()
  closeSync(fileDescriptor)

  const session: ReviewSession = {
    schemaVersion: REVIEW_SESSION_SCHEMA_VERSION,
    reviewId: crypto.randomUUID(),
    patchDigest: writer.hasher.digest('hex'),
    generatedAt: new Date().toISOString(),
    repository: { root: '/tmp/fixture', name: 'fixture' },
    target: { kind: ReviewTargetKind.Worktree, key: 'worktree', label: `fixture ${scenario}`, branch: null, base: 'HEAD' },
    title: `Fixture ${scenario}`,
    commits: [],
    patchFileName,
    patchByteLength: writer.bytesWritten,
  }
  writeFileSync(join(reviewDirectory, 'review.json'), JSON.stringify(session))

  return {
    scenario,
    reviewDirectory,
    patchBytes: writer.bytesWritten,
    ...counters,
    generationMilliseconds: performance.now() - started,
  }
}

if (import.meta.main) {
  const requested = process.argv.slice(2)
  const scenarios = requested.length > 0 ? requested : [FixtureScenario.Baseline, FixtureScenario.Stress]
  const known = new Set<string>(Object.values(FixtureScenario))
  const parentArgument = process.env.REVIEW_CHANGES_FIXTURE_DIRECTORY

  for (const scenario of scenarios) {
    if (!known.has(scenario)) {
      process.stderr.write(`unknown scenario ${scenario}; known: ${[...known].join(', ')}\n`)
      process.exit(64)
    }

    const summary = generateFixture(scenario as FixtureScenario, parentArgument)
    process.stdout.write(`${JSON.stringify(summary)}\n`)
  }
}
