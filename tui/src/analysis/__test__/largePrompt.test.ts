import { describe, expect, test } from 'bun:test'
import { LARGE_PROMPT_BYTE_LIMIT, MAXIMUM_PROMPT_LINE_BYTES, buildLargeAnalyzerPrompt, truncateBytes } from '../largePrompt.ts'
import type { LargePromptInput, SeedSummary } from '../largePrompt.ts'

function hostileSeed(position: number): SeedSummary {
  return {
    key: `seed-${position}`,
    label: `pkg/${'long-directory-name/'.repeat(30)}${position}`,
    fileCount: 500,
    additions: 12345,
    deletions: 678,
    topFiles: Array.from({ length: 8 }, (_, fileIndex) => ({
      path: `pkg/${'é'.repeat(300)}/file${fileIndex}.ts`,
      additions: 10,
      deletions: 2,
      contexts: ['function a() {', `class ${'B'.repeat(500)}`, 'const c = 1', 'dropped fourth'],
    })),
  }
}

function inputOf(overrides: Partial<LargePromptInput>): LargePromptInput {
  return {
    title: 'Search',
    targetLabel: '#12 search → main',
    userRequests: [],
    commits: [],
    seeds: [],
    fileCount: 20000,
    additions: 900000,
    deletions: 50000,
    manifestPath: '/repo/.git/review-changes/sessions/pr-12/manifest.tsv',
    patchPath: '/repo/.git/review-changes/sessions/pr-12/patch.diff',
    ...overrides,
  }
}

describe('buildLargeAnalyzerPrompt', () => {
  test('stays within 64 KiB however much text the pull request carries', () => {
    const prompt = buildLargeAnalyzerPrompt(
      inputOf({
        title: 'T'.repeat(100_000),
        description: 'D'.repeat(1_000_000),
        userRequests: Array.from({ length: 50 }, () => 'R'.repeat(4000)),
        commits: Array.from({ length: 5000 }, (_, index) => ({ sha: `${index}`.padStart(40, 'a'), subject: 'S'.repeat(2000), author: 'x' })),
        seeds: Array.from({ length: 40 }, (_, index) => hostileSeed(index + 1)),
      }),
    )

    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(LARGE_PROMPT_BYTE_LIMIT)
  })

  test('names every seed even when their file details no longer fit', () => {
    const seeds = Array.from({ length: 40 }, (_, index) => hostileSeed(index + 1))
    const prompt = buildLargeAnalyzerPrompt(inputOf({ seeds, commits: Array.from({ length: 100 }, () => ({ sha: 'a'.repeat(40), subject: 'S'.repeat(190), author: '' })) }))

    for (const seed of seeds) expect(prompt).toContain(`${seed.key}  `)
    expect(prompt).toContain('---SEED GROUPS--- (40; 20000 files, +900000/-50000)')
  })

  test('points the analyzer at the manifest and the patch, and asks for seeds', () => {
    const prompt = buildLargeAnalyzerPrompt(inputOf({ seeds: [hostileSeed(1)] }))

    expect(prompt).toContain('/repo/.git/review-changes/sessions/pr-12/manifest.tsv')
    expect(prompt).toContain('Patch: /repo/.git/review-changes/sessions/pr-12/patch.diff')
    expect(prompt).toContain('"seeds": ["seed-3", ...]')
    expect(prompt).toContain('never whole')
  })

  test('keeps each seed line within 200 bytes and on one line', () => {
    const prompt = buildLargeAnalyzerPrompt(inputOf({ seeds: [{ ...hostileSeed(1), label: `a\nb\t${'x'.repeat(500)}` }] }))
    const lines = prompt.split('\n').filter(line => line.startsWith('seed-1') || line.startsWith('  pkg/'))

    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(MAXIMUM_PROMPT_LINE_BYTES + 2)
  })
})

describe('truncateBytes', () => {
  test('cuts on a character boundary and marks the cut', () => {
    expect(truncateBytes('ééééé', 7)).toBe('éé...')
  })

  test('leaves short text alone and flattens line breaks', () => {
    expect(truncateBytes('a\nb', 10)).toBe('a b')
  })
})
