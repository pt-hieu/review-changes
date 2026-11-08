import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateFixture } from './generate-fixtures.ts'
import { FixtureScenario } from './types.ts'

const FRAME_END = '\x1b[?2026l'
const COLUMNS = 140
const ROWS = 40
const SETTLE_MILLISECONDS = 25
const FRAME_TIMEOUT_MILLISECONDS = 150
const QUIET_MILLISECONDS = 1000

type Budgets = { launchMilliseconds: number; keyP95: number; keyP99: number; switchMilliseconds: number; filterMilliseconds: number; rssMebibytes: number }

const BASELINE_BUDGETS: Budgets = { launchMilliseconds: 300, keyP95: 16, keyP99: 33, switchMilliseconds: 50, filterMilliseconds: 16, rssMebibytes: 250 }
const STRESS_BUDGETS: Budgets = { ...BASELINE_BUDGETS, launchMilliseconds: 1000 }

function percentile(allSamples: number[], fraction: number): number {
  const samples = allSamples.filter(sample => sample >= 0)

  if (samples.length === 0) return 0

  const sorted = [...samples].sort((left, right) => left - right)

  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!
}

class TerminalProcess {
  readonly process: ReturnType<typeof Bun.spawn>
  private text = ''
  private frameWaiter: ((at: number) => void) | undefined
  private lastFrameAt = 0

  constructor(bundle: string, reviewDirectory: string) {
    this.process = Bun.spawn(['bun', bundle, 'open', reviewDirectory], {
      terminal: {
        cols: COLUMNS,
        rows: ROWS,
        data: (_terminal, data) => {
          const chunk = Buffer.from(data).toString('latin1')
          this.text = (this.text + chunk).slice(-400_000)

          if (chunk.includes(FRAME_END)) {
            this.lastFrameAt = performance.now()
            const waiter = this.frameWaiter
            this.frameWaiter = undefined
            waiter?.(this.lastFrameAt)
          }
        },
      },
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    })
  }

  get screenText(): string {
    return this.text
  }

  waitForFrame(): Promise<number> {
    return new Promise(resolve => {
      this.frameWaiter = resolve
      setTimeout(() => resolve(-1), FRAME_TIMEOUT_MILLISECONDS)
    })
  }

  async waitForText(needle: string, timeoutMilliseconds: number): Promise<boolean> {
    const deadline = performance.now() + timeoutMilliseconds

    while (performance.now() < deadline) {
      if (this.text.includes(needle)) return true

      await Bun.sleep(2)
    }

    return false
  }

  async settle(): Promise<void> {
    const deadline = performance.now() + 15000

    while (performance.now() < deadline && performance.now() - this.lastFrameAt < QUIET_MILLISECONDS) await Bun.sleep(20)
  }

  async timedKey(key: string): Promise<number> {
    await Bun.sleep(SETTLE_MILLISECONDS)

    const started = performance.now()
    const frame = this.waitForFrame()

    this.process.terminal!.write(key)

    const arrived = await frame

    return arrived < 0 ? -1 : arrived - started
  }

  async rssMebibytes(): Promise<number> {
    const result = Bun.spawnSync(['ps', '-o', 'rss=', '-p', String(this.process.pid)])

    return Number(result.stdout.toString().trim()) / 1024
  }

  async close(): Promise<void> {
    this.process.terminal!.write('q')
    await Promise.race([this.process.exited, Bun.sleep(1000)])
    this.process.kill()
  }
}

type Row = { name: string; value: number; budget: number }

async function runScenario(bundle: string, scenario: FixtureScenario, budgets: Budgets, parent: string): Promise<{ rows: Row[]; failures: number }> {
  const summary = generateFixture(scenario, parent)
  const launchStarted = performance.now()
  const session = new TerminalProcess(bundle, summary.reviewDirectory)
  const rows: Row[] = []

  await session.waitForText('Files', 10_000)
  rows.push({ name: `${scenario} launch ms`, value: performance.now() - launchStarted, budget: budgets.launchMilliseconds })
  await Bun.sleep(300)

  const isLongLine = scenario === FixtureScenario.LongLine || scenario === FixtureScenario.HugeLine
  const mainKey = isLongLine ? 'L' : 'j'
  const scroll: number[] = []
  await session.timedKey('l')
  await session.settle()

  for (let index = 0; index < 150; index++) scroll.push(await session.timedKey(mainKey))

  rows.push({ name: `${scenario} scroll p95 ms`, value: percentile(scroll, 0.95), budget: budgets.keyP95 })
  rows.push({ name: `${scenario} scroll p99 ms`, value: percentile(scroll, 0.99), budget: budgets.keyP99 })

  await session.timedKey('\x1b')
  await session.timedKey('3')
  await session.settle()

  const movement: number[] = []
  for (let index = 0; index < Math.min(150, summary.fileCount - 1); index++) movement.push(await session.timedKey('j'))

  rows.push({ name: `${scenario} list-move p95 ms`, value: percentile(movement, 0.95), budget: budgets.keyP95 })
  rows.push({ name: `${scenario} list-move p99 ms`, value: percentile(movement, 0.99), budget: budgets.keyP99 })

  await session.settle()

  const jump = await session.timedKey('G')
  if (jump >= 0) rows.push({ name: `${scenario} switch to last file ms`, value: jump, budget: budgets.switchMilliseconds })

  const back = await session.timedKey('g')
  if (back >= 0) rows.push({ name: `${scenario} switch to first file ms`, value: back, budget: budgets.switchMilliseconds })

  await session.timedKey('/')

  const filter: number[] = []
  for (const character of 'file1') filter.push(await session.timedKey(character))

  rows.push({ name: `${scenario} filter keystroke max ms`, value: Math.max(0, ...filter), budget: budgets.filterMilliseconds })

  const rss = await session.rssMebibytes()
  const unanswered = [...scroll, ...movement].filter(sample => sample < 0).length
  rows.push({ name: `${scenario} keys without a frame (of ${scroll.length + movement.length})`, value: unanswered, budget: scenario === FixtureScenario.Baseline || scenario === FixtureScenario.Stress ? 15 : Number.MAX_SAFE_INTEGER })
  rows.push({ name: `${scenario} rss MiB`, value: rss, budget: budgets.rssMebibytes })

  await session.close()
  rmSync(summary.reviewDirectory, { recursive: true, force: true })

  return { rows, failures: rows.filter(row => row.value > row.budget).length }
}

const bundle = process.argv[2]
const requested = process.argv.slice(3)

if (bundle === undefined) {
  process.stderr.write('usage: bun tui/dev/ui-benchmark.ts <bundle> [scenario...]\n')
  process.exit(64)
}

const scenarios = (requested.length > 0 ? requested : Object.values(FixtureScenario)) as FixtureScenario[]
const parent = mkdtempSync(join(tmpdir(), 'review-changes-ui-bench-'))
let failures = 0

for (const scenario of scenarios) {
  const budgets = scenario === FixtureScenario.Baseline ? BASELINE_BUDGETS : STRESS_BUDGETS
  const result = await runScenario(bundle, scenario, budgets, parent)

  failures += result.failures

  for (const row of result.rows) {
    const status = row.value > row.budget ? 'FAIL' : 'ok  '
    process.stdout.write(`${status} ${row.name.padEnd(42)} ${row.value.toFixed(2).padStart(9)} (budget ${row.budget})\n`)
  }
}

rmSync(parent, { recursive: true, force: true })
process.exit(failures > 0 ? 1 : 0)
