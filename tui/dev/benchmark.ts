import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PatchReader } from '../src/patch/patchReader.ts'
import { LineIndex, LineIndexCache } from '../src/patch/lineIndex.ts'
import { scanPatch } from '../src/patch/scanIndex.ts'
import { readSession } from '../src/session/loadReview.ts'
import { ReviewedStore } from '../src/store/reviewedStore.ts'
import { generateFixture } from './generate-fixtures.ts'
import { FixtureScenario, type Budget, type FixtureSummary, type MeasureResult } from './types.ts'

const MEBIBYTE = 1024 * 1024
const VISIBLE_ROWS = 60
const WINDOW_BYTES = 400
const INDEX_QUANTUM_MILLISECONDS = 8
const SWITCH_SAMPLES = 1000
const SCROLL_SAMPLES = 3000

const DEFAULT_BUDGET: Budget = {
  launchMilliseconds: 1000,
  switchP99Milliseconds: 50,
  scrollP95Milliseconds: 16,
  scrollP99Milliseconds: 33,
  indexQuantumMilliseconds: 16,
  rssMebibytes: 250,
}

const BUDGETS: Record<FixtureScenario, Budget> = {
  [FixtureScenario.Baseline]: { ...DEFAULT_BUDGET, launchMilliseconds: 300 },
  [FixtureScenario.Stress]: DEFAULT_BUDGET,
  [FixtureScenario.ShortLines]: DEFAULT_BUDGET,
  [FixtureScenario.BigFile]: DEFAULT_BUDGET,
  [FixtureScenario.LongLine]: DEFAULT_BUDGET,
  [FixtureScenario.HugeLine]: DEFAULT_BUDGET,
  [FixtureScenario.Entries]: DEFAULT_BUDGET,
}

const DEFAULT_SCENARIOS = [FixtureScenario.Baseline, FixtureScenario.Stress, FixtureScenario.BigFile, FixtureScenario.LongLine, FixtureScenario.Entries]
const FULL_SCENARIOS = [...DEFAULT_SCENARIOS, FixtureScenario.ShortLines, FixtureScenario.HugeLine]

function percentile(samples: number[], fraction: number): number {
  if (samples.length === 0) return 0

  const sorted = [...samples].sort((left, right) => left - right)

  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!
}

function readScreen(index: LineIndex, firstRow: number): void {
  const last = Math.min(index.indexedRowCount, firstRow + VISIBLE_ROWS)

  for (let row = firstRow; row < last; row++) index.readRow(row, 0, WINDOW_BYTES)
}

function measure(reviewDirectory: string, scenario: FixtureScenario): MeasureResult {
  const session = readSession(reviewDirectory)
  const launchStarted = performance.now()
  const reader = new PatchReader(join(reviewDirectory, session.patchFileName))
  const store = new ReviewedStore(join(reviewDirectory, 'reviewed'), 'bench')

  const scanStarted = performance.now()
  const table = scanPatch(reader.descriptor, reader.byteLength, { seed: store.seed })
  const scanMilliseconds = performance.now() - scanStarted
  const rssAfterScanMebibytes = process.memoryUsage().rss / MEBIBYTE

  const sortStarted = performance.now()
  table.sortedOrder()
  const sortMilliseconds = performance.now() - sortStarted

  const cache = new LineIndexCache(table, reader)
  const firstStarted = performance.now()
  const firstIndex = cache.get(0)
  firstIndex.advance(INDEX_QUANTUM_MILLISECONDS)
  readScreen(firstIndex, 0)
  const firstFrameMilliseconds = performance.now() - firstStarted
  const launchMilliseconds = performance.now() - launchStarted

  const switchMilliseconds: number[] = []
  let state = 12345
  for (let sample = 0; sample < SWITCH_SAMPLES; sample++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    const fileIndex = state % table.fileCount
    const started = performance.now()
    const index = cache.get(fileIndex)
    index.advance(INDEX_QUANTUM_MILLISECONDS)
    readScreen(index, 0)
    switchMilliseconds.push(performance.now() - started)
  }

  let largestFile = 0
  for (let fileIndex = 1; fileIndex < table.fileCount; fileIndex++) {
    if (table.patchOffset[fileIndex + 1]! - table.patchOffset[fileIndex]! > table.patchOffset[largestFile + 1]! - table.patchOffset[largestFile]!) largestFile = fileIndex
  }

  const largeIndex = new LineIndex(table, reader, largestFile)
  let longestIndexQuantumMilliseconds = 0
  const fullIndexStarted = performance.now()
  while (!largeIndex.isComplete) {
    const quantumStarted = performance.now()
    largeIndex.advance(INDEX_QUANTUM_MILLISECONDS)
    longestIndexQuantumMilliseconds = Math.max(longestIndexQuantumMilliseconds, performance.now() - quantumStarted)
  }
  const fullIndexMilliseconds = performance.now() - fullIndexStarted

  const scrollMilliseconds: number[] = []
  const scrollableRows = Math.max(1, largeIndex.indexedRowCount - VISIBLE_ROWS)
  for (let sample = 0; sample < SCROLL_SAMPLES; sample++) {
    const firstRow = sample < SCROLL_SAMPLES / 2 ? sample % scrollableRows : (sample * 7919) % scrollableRows
    const started = performance.now()
    readScreen(largeIndex, firstRow)
    largeIndex.lineNumbersAt(Math.min(firstRow, largeIndex.indexedRowCount - 1))
    scrollMilliseconds.push(performance.now() - started)
  }

  const windowReadMilliseconds: number[] = []
  if (largeIndex.indexedRowCount > 0) {
    for (let column = 0; column < 200; column++) {
      const started = performance.now()
      for (let row = 0; row < Math.min(VISIBLE_ROWS, largeIndex.indexedRowCount); row++) largeIndex.readRow(row, column * 1000, WINDOW_BYTES)
      windowReadMilliseconds.push(performance.now() - started)
    }
  }

  const keys = Array.from(table.reviewKey.subarray(0, Math.min(table.fileCount, 20000)))
  const reviewedStarted = performance.now()
  store.setMany(keys, true)
  const reviewedMarkMilliseconds = performance.now() - reviewedStarted

  const rssMebibytes = process.memoryUsage().rss / MEBIBYTE
  reader.close()

  return {
    scenario,
    fileCount: table.fileCount,
    hunkCount: table.hunkCount,
    additions: table.totalAdditions(),
    deletions: table.totalDeletions(),
    scanMilliseconds,
    sortMilliseconds,
    firstFrameMilliseconds,
    launchMilliseconds,
    switchMilliseconds,
    scrollMilliseconds,
    longestIndexQuantumMilliseconds,
    fullIndexMilliseconds,
    windowReadMilliseconds,
    reviewedMarkMilliseconds,
    rssMebibytes,
    rssAfterScanMebibytes,
  }
}

function checkAgainstBudget(summary: FixtureSummary, result: MeasureResult): string[] {
  const budget = BUDGETS[summary.scenario]
  const failures: string[] = []
  const check = (name: string, actual: number, limit: number): void => {
    if (actual > limit) failures.push(`${name} ${actual.toFixed(1)} > ${limit}`)
  }

  if (result.fileCount !== summary.fileCount) failures.push(`files ${result.fileCount} != ${summary.fileCount}`)
  if (result.hunkCount !== summary.hunkCount) failures.push(`hunks ${result.hunkCount} != ${summary.hunkCount}`)
  if (result.additions !== summary.additions) failures.push(`additions ${result.additions} != ${summary.additions}`)
  if (result.deletions !== summary.deletions) failures.push(`deletions ${result.deletions} != ${summary.deletions}`)

  check('launch ms', result.launchMilliseconds, budget.launchMilliseconds)
  check('switch p99 ms', percentile(result.switchMilliseconds, 0.99), budget.switchP99Milliseconds)
  check('scroll p95 ms', percentile(result.scrollMilliseconds, 0.95), budget.scrollP95Milliseconds)
  check('scroll p99 ms', percentile(result.scrollMilliseconds, 0.99), budget.scrollP99Milliseconds)
  check('index quantum ms', result.longestIndexQuantumMilliseconds, budget.indexQuantumMilliseconds)
  check('rss MiB', result.rssMebibytes, budget.rssMebibytes)

  return failures
}

function formatRow(summary: FixtureSummary, result: MeasureResult, failures: string[]): string {
  const fixed = (value: number, digits: number = 2): string => value.toFixed(digits)
  const cells = [
    summary.scenario.padEnd(12),
    `${fixed(summary.patchBytes / MEBIBYTE, 0)}MiB`.padStart(8),
    String(summary.fileCount).padStart(6),
    fixed(result.scanMilliseconds, 0).padStart(6),
    fixed(result.sortMilliseconds, 1).padStart(6),
    fixed(result.launchMilliseconds, 0).padStart(7),
    `${fixed(percentile(result.switchMilliseconds, 0.5))}/${fixed(percentile(result.switchMilliseconds, 0.99))}/${fixed(Math.max(...result.switchMilliseconds))}`.padStart(17),
    `${fixed(percentile(result.scrollMilliseconds, 0.5))}/${fixed(percentile(result.scrollMilliseconds, 0.95))}/${fixed(percentile(result.scrollMilliseconds, 0.99))}`.padStart(17),
    fixed(result.longestIndexQuantumMilliseconds, 1).padStart(8),
    fixed(result.fullIndexMilliseconds, 0).padStart(7),
    fixed(result.rssMebibytes, 0).padStart(6),
    failures.length === 0 ? 'ok' : `FAIL ${failures.join('; ')}`,
  ]

  return cells.join(' ')
}

async function runParent(scenarios: FixtureScenario[]): Promise<number> {
  const parentDirectory = mkdtempSync(join(tmpdir(), 'review-changes-bench-'))
  let hasFailure = false

  process.stdout.write(
    `${'scenario'.padEnd(12)} ${'patch'.padStart(8)} ${'files'.padStart(6)} ${'scan'.padStart(6)} ${'sort'.padStart(6)} ${'launch'.padStart(7)} ${'switch p50/99/max'.padStart(17)} ${'scroll p50/95/99'.padStart(17)} ${'quantum'.padStart(8)} ${'fullidx'.padStart(7)} ${'rssMiB'.padStart(6)} status\n`,
  )

  try {
    for (const scenario of scenarios) {
      const summary = generateFixture(scenario, parentDirectory)
      const child = Bun.spawnSync([process.execPath, import.meta.path, '--measure', summary.reviewDirectory, scenario], { stdout: 'pipe', stderr: 'pipe' })

      if (child.exitCode !== 0) {
        process.stdout.write(`${scenario.padEnd(12)} child failed: ${child.stderr.toString().slice(0, 300)}\n`)
        hasFailure = true
      } else {
        const result = JSON.parse(child.stdout.toString()) as MeasureResult
        const failures = checkAgainstBudget(summary, result)
        if (failures.length > 0) hasFailure = true
        process.stdout.write(`${formatRow(summary, result, failures)}\n`)
      }

      rmSync(summary.reviewDirectory, { recursive: true, force: true })
    }
  } finally {
    rmSync(parentDirectory, { recursive: true, force: true })
  }

  return hasFailure ? 1 : 0
}

if (process.argv[2] === '--measure') {
  process.stdout.write(JSON.stringify(measure(process.argv[3]!, process.argv[4] as FixtureScenario)))
} else {
  const isFull = process.argv.includes('--full')
  const requested = process.argv.slice(2).filter(argument => !argument.startsWith('--')) as FixtureScenario[]
  const scenarios = requested.length > 0 ? requested : isFull ? FULL_SCENARIOS : DEFAULT_SCENARIOS

  process.exit(await runParent(scenarios))
}
