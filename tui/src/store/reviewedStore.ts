import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SLUG_PATTERN = /^[A-Za-z0-9._-]{1,200}$/
const SEED_BYTES = 6
const MAXIMUM_LINE_LENGTH = 64
const MAXIMUM_STORE_BYTES = 256 * 1024 * 1024

function randomSeed(): number {
  const bytes = crypto.getRandomValues(new Uint8Array(SEED_BYTES))

  return bytes.reduce((value, byte) => value * 256 + byte, 0)
}

export function loadOrCreateSeed(reviewedDirectory: string): number {
  mkdirSync(reviewedDirectory, { recursive: true, mode: 0o700 })
  const seedPath = join(reviewedDirectory, 'seed')

  try {
    closeSync(openSync(seedPath, 'wx', 0o600))
    writeFileSync(seedPath, String(randomSeed()))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }

  const seed = Number(readFileSync(seedPath, 'utf8').trim())

  if (Number.isSafeInteger(seed) && seed > 0) return seed

  const replacement = randomSeed()
  writeFileSync(seedPath, String(replacement))

  return replacement
}

function parseMarkLine(line: string): { key: number; isReviewed: boolean } | undefined {
  if (line.length === 0 || line.length > MAXIMUM_LINE_LENGTH) return undefined

  try {
    const parsed: unknown = JSON.parse(line)

    if (typeof parsed !== 'object' || parsed === null) return undefined

    const { key, isReviewed } = parsed as { key?: unknown; isReviewed?: unknown }

    if (typeof key !== 'number' || !Number.isSafeInteger(key) || key < 0) return undefined
    if (typeof isReviewed !== 'boolean') return undefined

    return { key, isReviewed }
  } catch {
    return undefined
  }
}

function formatMarkLine(key: number, isReviewed: boolean): string {
  return `{"key":${key},"isReviewed":${isReviewed}}\n`
}

export class ReviewedStore {
  readonly seed: number
  private readonly reviewed = new Set<number>()
  private readonly storePath: string
  private isSaveFailing = false

  constructor(reviewedDirectory: string, slug: string) {
    if (!SLUG_PATTERN.test(slug) || slug === '.' || slug === '..') throw new Error('invalid review slug')

    this.seed = loadOrCreateSeed(reviewedDirectory)
    this.storePath = join(reviewedDirectory, `${slug}.jsonl`)
    this.load()
  }

  get hasSaveFailed(): boolean {
    return this.isSaveFailing
  }

  isReviewed(key: number): boolean {
    return this.reviewed.has(key)
  }

  get reviewedCount(): number {
    return this.reviewed.size
  }

  setMany(keys: readonly number[], isReviewed: boolean): number {
    const changed: number[] = []

    for (const key of keys) {
      if (this.reviewed.has(key) === isReviewed) continue

      if (isReviewed) this.reviewed.add(key)
      else this.reviewed.delete(key)

      changed.push(key)
    }

    if (changed.length > 0) {
      try {
        appendFileSync(this.storePath, changed.map(key => formatMarkLine(key, isReviewed)).join(''), { mode: 0o600 })
        this.isSaveFailing = false
      } catch {
        this.isSaveFailing = true
      }
    }

    return changed.length
  }

  toggle(key: number): boolean {
    const isReviewed = !this.reviewed.has(key)
    this.setMany([key], isReviewed)

    return isReviewed
  }

  private load(): void {
    let content = ''

    try {
      const buffer = readFileSync(this.storePath)
      if (buffer.length <= MAXIMUM_STORE_BYTES) content = buffer.toString('utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return
    }

    let lineCount = 0

    for (const line of content.split('\n')) {
      const mark = parseMarkLine(line)

      if (mark === undefined) continue

      lineCount++
      if (mark.isReviewed) this.reviewed.add(mark.key)
      else this.reviewed.delete(mark.key)
    }

    if (lineCount > this.reviewed.size) this.compact()
  }

  private compact(): void {
    const temporaryPath = `${this.storePath}.tmp`
    const content = Array.from(this.reviewed, key => formatMarkLine(key, true)).join('')

    writeFileSync(temporaryPath, content, { mode: 0o600 })
    renameSync(temporaryPath, this.storePath)
  }
}
