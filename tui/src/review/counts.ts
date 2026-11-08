import type { ReviewFile } from './payload.ts'

export function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`
}

export function countOf(count: number, noun: string): string {
  return `${count} ${plural(count, noun)}`
}

export function totalLineCounts(files: readonly Pick<ReviewFile, 'additions' | 'deletions'>[]): {
  additions: number
  deletions: number
} {
  return {
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  }
}

export function lineCountsLabel(files: readonly Pick<ReviewFile, 'additions' | 'deletions'>[]): string {
  const { additions, deletions } = totalLineCounts(files)

  return `+${additions}/−${deletions}`
}
