import type { RunCommand } from '../review/git.ts'
import { ReviewSourceError } from '../review/git.ts'
import { runCommandToFile } from './commandRunner.ts'

export const MAXIMUM_PATCH_BYTES = 4 * 1024 * 1024 * 1024
export const MAXIMUM_CHANGED_ENTRIES = 50_000

const DIFF_TIMEOUT_MILLISECONDS = 15 * 60 * 1000

export const PATCH_DIFF_FLAGS = [
  '-c', 'core.quotePath=false',
  'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--full-index', '-M', '-l1000', '-O/dev/null',
  '--submodule=short', '--ignore-submodules=none', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/',
] as const

export type DiffRequest = {
  directory: string
  revisions: readonly string[]
  outputPath: string
  environment?: Record<string, string>
}

export function quotedObjectDirectory(path: string): string {
  return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export async function diffToFile(request: DiffRequest): Promise<void> {
  const result = await runCommandToFile(['git', ...PATCH_DIFF_FLAGS, '--end-of-options', ...request.revisions], {
    cwd: request.directory,
    env: request.environment,
    outputPath: request.outputPath,
    maximumBytes: MAXIMUM_PATCH_BYTES,
    timeoutMs: DIFF_TIMEOUT_MILLISECONDS,
  })

  if (result.isOverSizeLimit) throw new ReviewSourceError('The diff is larger than 4 GiB; review a narrower target.')

  if (result.exitCode !== 0) {
    const firstLine = result.stderr.split('\n').find(line => line.trim() !== '')

    throw new ReviewSourceError(`git diff failed: ${firstLine ?? `exit code ${result.exitCode}`}`)
  }
}

export async function objectsDirectory(runCommand: RunCommand, directory: string): Promise<string> {
  const result = await runCommand(['git', 'rev-parse', '--path-format=absolute', '--git-path', 'objects'], { cwd: directory })

  if (result.exitCode !== 0) throw new ReviewSourceError('Could not locate the repository objects.')

  return result.stdout.trim()
}
