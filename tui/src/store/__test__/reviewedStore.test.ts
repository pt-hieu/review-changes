import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadOrCreateSeed, ReviewedStore } from '../reviewedStore.ts'

const roots: string[] = []

afterAll(() => {
  for (const root of roots) {
    chmodSync(root, 0o700)
    rmSync(root, { recursive: true, force: true })
  }
})

function newDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'reviewed-store-test-'))
  roots.push(root)

  return join(root, 'reviewed')
}

describe('loadOrCreateSeed', () => {
  test('creates a positive seed and returns the same one afterwards', () => {
    const directory = newDirectory()
    const seed = loadOrCreateSeed(directory)

    expect(Number.isSafeInteger(seed)).toBe(true)
    expect(seed).toBeGreaterThan(0)
    expect(loadOrCreateSeed(directory)).toBe(seed)
  })

  test.each(['', 'not a number', '-5', '0', '1.5', '99999999999999999999'])('replaces a corrupt seed file holding %j with a valid one that then stays', corrupt => {
    const directory = newDirectory()
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'seed'), corrupt)

    const seed = loadOrCreateSeed(directory)

    expect(Number.isSafeInteger(seed)).toBe(true)
    expect(seed).toBeGreaterThan(0)
    expect(loadOrCreateSeed(directory)).toBe(seed)
  })

  test('different directories get different seeds', () => {
    expect(loadOrCreateSeed(newDirectory())).not.toBe(loadOrCreateSeed(newDirectory()))
  })
})

describe('ReviewedStore', () => {
  test('remembers marks across instances, including unmarking', () => {
    const directory = newDirectory()
    const store = new ReviewedStore(directory, 'pr-1')

    store.setMany([1, 2, 3], true)
    store.setMany([2], false)
    store.toggle(9)

    const reopened = new ReviewedStore(directory, 'pr-1')

    expect([1, 2, 3, 9].map(key => reopened.isReviewed(key))).toEqual([true, false, true, true])
    expect(reopened.reviewedCount).toBe(3)
    expect(reopened.seed).toBe(store.seed)
  })

  test('keeps different reviews apart', () => {
    const directory = newDirectory()
    new ReviewedStore(directory, 'pr-1').setMany([5], true)

    expect(new ReviewedStore(directory, 'pr-2').isReviewed(5)).toBe(false)
  })

  test('reports how many marks actually changed', () => {
    const store = new ReviewedStore(newDirectory(), 'pr-1')

    expect(store.setMany([1, 2, 2], true)).toBe(2)
    expect(store.setMany([1, 2], true)).toBe(0)
    expect(store.setMany([1, 7], false)).toBe(1)
  })

  test('toggle returns the new state', () => {
    const store = new ReviewedStore(newDirectory(), 'pr-1')

    expect(store.toggle(4)).toBe(true)
    expect(store.toggle(4)).toBe(false)
  })

  test('skips corrupt, hostile and oversized lines in the stored file and keeps the valid ones', () => {
    const directory = newDirectory()
    const seed = loadOrCreateSeed(directory)
    const lines = [
      '{"key":1,"isReviewed":true}',
      'not json at all',
      '{"key":-1,"isReviewed":true}',
      '{"key":1.5,"isReviewed":true}',
      '{"key":"2","isReviewed":true}',
      '{"key":3,"isReviewed":"yes"}',
      '{"key":99999999999999999999,"isReviewed":true}',
      'null',
      '[1,2]',
      `{"key":4,"isReviewed":true,"padding":"${'x'.repeat(100)}"}`,
      '{"key":5,"isReviewed":true}',
      '{"key":5,"isReviewed":false}',
      '{"key":6,"isReviewed":true}',
      '{"__proto__":{"key":8,"isReviewed":true}}',
    ]
    writeFileSync(join(directory, 'pr-1.jsonl'), `${lines.join('\n')}\n`)

    const store = new ReviewedStore(directory, 'pr-1')

    expect([1, 2, 3, 4, 5, 6, 8].map(key => store.isReviewed(key))).toEqual([true, false, false, false, false, true, false])
    expect(store.reviewedCount).toBe(2)
    expect(store.seed).toBe(seed)
  })

  test('a store that was compacted on load still holds exactly the same marks', () => {
    const directory = newDirectory()
    const store = new ReviewedStore(directory, 'pr-1')

    for (let round = 0; round < 5; round++) {
      store.setMany([1, 2], true)
      store.setMany([1, 2], false)
    }

    store.setMany([3], true)

    const reopened = new ReviewedStore(directory, 'pr-1')
    const afterCompaction = new ReviewedStore(directory, 'pr-1')

    expect([1, 2, 3].map(key => reopened.isReviewed(key))).toEqual([false, false, true])
    expect([1, 2, 3].map(key => afterCompaction.isReviewed(key))).toEqual([false, false, true])
    expect(readFileSync(join(directory, 'pr-1.jsonl'), 'utf8').trimEnd().split('\n')).toEqual(['{"key":3,"isReviewed":true}'])
  })

  test.each(['', '.', '..', '../escape', 'a/b', 'a b', 'x'.repeat(201)])('refuses the review name %j so a name cannot reach outside the store', slug => {
    expect(() => new ReviewedStore(newDirectory(), slug)).toThrow('invalid review slug')
  })

  test.skipIf(process.getuid?.() === 0)('keeps marks in memory and reports the failure when the store cannot be written', () => {
    const directory = newDirectory()
    const store = new ReviewedStore(directory, 'pr-1')
    chmodSync(directory, 0o500)

    store.setMany([1], true)

    expect(store.hasSaveFailed).toBe(true)
    expect(store.isReviewed(1)).toBe(true)

    chmodSync(directory, 0o700)
    store.setMany([2], true)

    expect(store.hasSaveFailed).toBe(false)
  })
})
