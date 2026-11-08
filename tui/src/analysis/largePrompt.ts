import { SINGLE_USER_REQUEST_CHARACTER_LIMIT, USER_REQUESTS_TOTAL_CHARACTER_LIMIT } from '../review/analysis.ts'
import type { ReviewCommit } from '../review/payload.ts'

export const LARGE_PROMPT_BYTE_LIMIT = 64 * 1024
export const MAXIMUM_PROMPT_LINE_BYTES = 200
export const MAXIMUM_PROMPT_COMMITS = 100
export const MAXIMUM_PROMPT_DESCRIPTION_CHARACTERS = 4000
export const MAXIMUM_PROMPT_READS = 30

const MAXIMUM_TOP_FILES = 5
const MAXIMUM_CONTEXTS_PER_FILE = 3
const SKIPPED_ENTRY_BYTES = 256 * 1024
const MAXIMUM_TITLE_CHARACTERS = 300

export type SeedFileSummary = { path: string; additions: number; deletions: number; contexts: string[] }

export type SeedSummary = {
  key: string
  label: string
  fileCount: number
  additions: number
  deletions: number
  topFiles: SeedFileSummary[]
}

export type LargePromptInput = {
  title: string
  targetLabel: string
  pullRequestUrl?: string
  description?: string
  userRequests: string[]
  commits: ReviewCommit[]
  seeds: SeedSummary[]
  fileCount: number
  additions: number
  deletions: number
  manifestPath: string
  patchPath: string
}

export function truncateBytes(text: string, byteLimit: number): string {
  const singleLine = text.replace(/[\r\n\t]+/g, ' ')
  const bytes = Buffer.from(singleLine, 'utf8')

  if (bytes.length <= byteLimit) return singleLine

  return `${bytes.subarray(0, byteLimit - 3).toString('utf8').replace(/�+$/, '')}...`
}

function seedHeadline(seed: SeedSummary): string {
  const label = truncateBytes(seed.label, 80)
  const fileLabel = seed.fileCount === 1 ? 'file' : 'files'

  return truncateBytes(`${seed.key}  ${label}  ${seed.fileCount} ${fileLabel} +${seed.additions}/-${seed.deletions}`, MAXIMUM_PROMPT_LINE_BYTES)
}

function seedFileLine(file: SeedFileSummary): string {
  const contexts = file.contexts.slice(0, MAXIMUM_CONTEXTS_PER_FILE).map(context => `@@ ${context}`).join(' / ')

  return `  ${truncateBytes(`${file.path}  +${file.additions}/-${file.deletions}  ${contexts}`, MAXIMUM_PROMPT_LINE_BYTES - 2)}`
}

function seedBlock(seed: SeedSummary): string {
  return [seedHeadline(seed), ...seed.topFiles.slice(0, MAXIMUM_TOP_FILES).map(seedFileLine)].join('\n')
}

function byteLengthOf(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

function seedSection(seeds: SeedSummary[], byteBudget: number): string {
  const headlines = seeds.map(seedHeadline)
  let remaining = byteBudget - headlines.reduce((total, headline) => total + byteLengthOf(headline) + 1, 0)

  return seeds
    .map((seed, position) => {
      const block = seedBlock(seed)
      const extraBytes = byteLengthOf(block) - byteLengthOf(headlines[position]!)

      if (extraBytes > remaining) return headlines[position]!

      remaining -= extraBytes

      return block
    })
    .join('\n')
}

function requestBlocks(userRequests: string[]): string[] {
  const kept: string[] = []
  let characterCount = 0

  for (const request of userRequests) {
    const capped = request.slice(0, SINGLE_USER_REQUEST_CHARACTER_LIMIT)

    if (characterCount + capped.length > USER_REQUESTS_TOTAL_CHARACTER_LIMIT) break

    kept.push(capped)
    characterCount += capped.length
  }

  return kept.map((request, index) => `[${index + 1}]\n${request}`)
}

export function buildLargeAnalyzerPrompt(input: LargePromptInput): string {
  const header = [`Title: ${truncateBytes(input.title, MAXIMUM_TITLE_CHARACTERS)}`, `Target: ${truncateBytes(input.targetLabel, MAXIMUM_TITLE_CHARACTERS)}`]

  if (input.pullRequestUrl !== undefined) header.push(`PR link: ${truncateBytes(input.pullRequestUrl, MAXIMUM_PROMPT_LINE_BYTES)}`)

  const parts = [header.join('\n')]

  if (input.description) parts.push(`---DESCRIPTION---\n${input.description.slice(0, MAXIMUM_PROMPT_DESCRIPTION_CHARACTERS)}`)

  const requests = requestBlocks(input.userRequests)

  if (requests.length > 0) parts.push(`---USER REQUESTS--- (${requests.length}, oldest first)\n${requests.join('\n\n')}`)

  const commits = input.commits.slice(0, MAXIMUM_PROMPT_COMMITS)

  if (input.commits.length > 1) {
    const lines = commits.map(commit => truncateBytes(`${commit.sha.slice(0, 7)} ${commit.subject}`, MAXIMUM_PROMPT_LINE_BYTES))

    parts.push(`---COMMITS--- (${input.commits.length}, oldest first)\n${lines.join('\n')}`)
  }

  const closing = [
    `Manifest (one line per changed file, tab separated: path as a JSON string, status, additions, deletions, seedKey, patchStartLine, patchLineCount, patchByteCount): ${input.manifestPath}`,
    `Patch: ${input.patchPath}`,
    `Read the patch only with offset and limit taken from manifest.tsv (patchStartLine and patchLineCount); never whole. Skip any entry whose patchByteCount is over ${SKIPPED_ENTRY_BYTES}, because a single line may be huge. Make at most ${MAXIMUM_PROMPT_READS} Reads.`,
    'This diff is too large to list file by file. Each group names the seed groups it covers as "seeds": ["seed-3", ...]; add "filePaths" only to move individual files out of their seed. Every seed must end up in some group. Answer with one fenced json block.',
  ].join('\n')

  const seedHeading = `---SEED GROUPS--- (${input.seeds.length}; ${input.fileCount} files, +${input.additions}/-${input.deletions})\n`
  const fixedBytes = byteLengthOf(`${parts.join('\n\n')}\n\n${seedHeading}\n\n${closing}`)
  const seedBudget = Math.max(0, LARGE_PROMPT_BYTE_LIMIT - fixedBytes)

  parts.push(`${seedHeading}${seedSection(input.seeds, seedBudget)}`)
  parts.push(closing)

  return parts.join('\n\n')
}
