import type { ReviewFile, ReviewHunk } from './payload.ts'
import { GitPathPrefix, ReviewFileStatus } from './types.ts'

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
const DIFF_HEADER_PREFIX = 'diff --git '
const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }

export async function buildReviewFiles(patch: string): Promise<ReviewFile[]> {
  const sections = patch
    .split(/(?=^diff --git )/m)
    .filter(section => section.startsWith(DIFF_HEADER_PREFIX))
    .map(section => section.replace(/\n*$/, '\n'))
  return Promise.all(sections.map(buildReviewFile))
}

async function buildReviewFile(section: string): Promise<ReviewFile> {
  const lines = section.slice(0, -1).split('\n')
  const firstHunkIndex = lines.findIndex(line => HUNK_HEADER_PATTERN.test(line))
  const headerLines = firstHunkIndex === -1 ? lines : lines.slice(0, firstHunkIndex)
  const bodyLines = firstHunkIndex === -1 ? [] : lines.slice(firstHunkIndex)

  const headerValue = (prefix: string): string | undefined => {
    const line = headerLines.find(candidate => candidate.startsWith(prefix))
    return line === undefined ? undefined : line.slice(prefix.length)
  }
  const renameFrom = optionalPath(headerValue('rename from '))
  const renameTo = optionalPath(headerValue('rename to '))
  const copyFrom = optionalPath(headerValue('copy from '))
  const copyTo = optionalPath(headerValue('copy to '))
  const oldPath = sidePath(headerValue('--- '), GitPathPrefix.Old)
  const newPath = sidePath(headerValue('+++ '), GitPathPrefix.New)
  const headerPaths = parseDiffHeaderPaths(lines[0]!)

  let status: ReviewFileStatus = ReviewFileStatus.Modified
  if (headerLines.some(line => line.startsWith('new file mode'))) status = ReviewFileStatus.Added
  else if (headerLines.some(line => line.startsWith('deleted file mode'))) status = ReviewFileStatus.Removed
  else if (renameFrom !== undefined) status = ReviewFileStatus.Renamed
  else if (copyFrom !== undefined) status = ReviewFileStatus.Copied

  const path = status === ReviewFileStatus.Removed
    ? oldPath ?? headerPaths.oldPath
    : newPath ?? renameTo ?? copyTo ?? headerPaths.newPath
  const previousPath = status === ReviewFileStatus.Renamed ? renameFrom : status === ReviewFileStatus.Copied ? copyFrom : undefined

  const hunks: ReviewHunk[] = []
  let additions = 0
  let deletions = 0
  for (const line of bodyLines) {
    const hunkMatch = HUNK_HEADER_PATTERN.exec(line)

    if (hunkMatch) {
      hunks.push({
        header: line,
        oldStart: Number(hunkMatch[1]),
        oldLines: hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]),
        newStart: Number(hunkMatch[3]),
        newLines: hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]),
      })
    } else if (line.startsWith('+')) {
      additions++
    } else if (line.startsWith('-')) {
      deletions++
    }
  }

  const isBinary = headerLines.some(line =>
    line === 'GIT binary patch' || (line.startsWith('Binary files ') && line.endsWith(' differ')))

  return {
    path,
    ...(previousPath === undefined ? {} : { previousPath }),
    status,
    additions,
    deletions,
    isBinary,
    hunks,
    patch: section,
    patchHash: await hashText(section),
    isPatchOmitted: false,
  }
}

async function hashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function optionalPath(text: string | undefined): string | undefined {
  return text === undefined ? undefined : unquoteGitPath(text)
}

function sidePath(text: string | undefined, prefix: GitPathPrefix): string | undefined {
  if (text === undefined) return undefined

  const textWithoutTabGitAddsForSpacedPath = text.replace(/\t$/, '')
  const path = unquoteGitPath(textWithoutTabGitAddsForSpacedPath)

  if (path === '/dev/null') return undefined

  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

function parseSamePathTwice(rest: string): { oldPath: string; newPath: string } | undefined {
  const halfLength = (rest.length - 1) / 2

  if (!Number.isInteger(halfLength)) return undefined

  const oldSide = rest.slice(0, halfLength)
  const newSide = rest.slice(halfLength + 1)

  if (oldSide.startsWith(GitPathPrefix.Old) && newSide.startsWith(GitPathPrefix.New) && oldSide.slice(2) === newSide.slice(2)) {
    return { oldPath: oldSide.slice(2), newPath: newSide.slice(2) }
  }

  return undefined
}

function parseDiffHeaderPaths(line: string): { oldPath: string; newPath: string } {
  const rest = line.slice(DIFF_HEADER_PREFIX.length)
  const quotedSidePattern = /^("a\/(?:[^"\\]|\\.)*"|a\/.*?) ("b\/(?:[^"\\]|\\.)*")$|^("a\/(?:[^"\\]|\\.)*") (b\/.*)$/
  const quotedMatch = quotedSidePattern.exec(rest)

  if (quotedMatch) {
    const oldSide = quotedMatch[1] ?? quotedMatch[3]!
    const newSide = quotedMatch[2] ?? quotedMatch[4]!
    return { oldPath: unquoteGitPath(oldSide).slice(2), newPath: unquoteGitPath(newSide).slice(2) }
  }

  const samePathTwice = parseSamePathTwice(rest)

  if (samePathTwice) return samePathTwice

  const separatorIndex = rest.lastIndexOf(' b/')

  if (separatorIndex === -1) return { oldPath: rest, newPath: rest }

  return { oldPath: rest.slice(0, separatorIndex).replace(/^a\//, ''), newPath: rest.slice(separatorIndex + 3) }
}

function unquoteGitPath(text: string): string {
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return text

  const encoder = new TextEncoder()
  const bytes: number[] = []
  const body = text.slice(1, -1)
  for (let index = 0; index < body.length; index++) {
    const character = body[index]!

    if (character !== '\\') {
      const codePoint = body.codePointAt(index)!
      const fullCharacter = String.fromCodePoint(codePoint)
      bytes.push(...encoder.encode(fullCharacter))
      index += fullCharacter.length - 1
      continue
    }

    const octalEscape = /^[0-7]{3}/.exec(body.slice(index + 1))
    if (octalEscape) {
      bytes.push(Number.parseInt(octalEscape[0], 8))
      index += 3
    } else {
      const escaped = body[index + 1] ?? '\\'
      bytes.push(C_ESCAPES[escaped] ?? escaped.charCodeAt(0))
      index++
    }
  }

  return new TextDecoder().decode(new Uint8Array(bytes))
}
