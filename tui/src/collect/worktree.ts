import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { EMPTY_TREE, ReviewSourceError } from '../review/git.ts'
import type { RunCommand } from '../review/git.ts'
import { withEnvironment } from './commandRunner.ts'
import { diffToFile, objectsDirectory, quotedObjectDirectory } from './diffCommand.ts'

export type WorktreeDiffRequest = {
  runCommand: RunCommand
  repositoryRoot: string
  scratchDirectory: string
  outputPath: string
}

export async function diffWorktreeToFile(request: WorktreeDiffRequest): Promise<string> {
  const { runCommand, repositoryRoot, scratchDirectory, outputPath } = request
  const objectDirectory = join(scratchDirectory, 'obj')
  const temporaryIndex = join(scratchDirectory, 'index')
  mkdirSync(objectDirectory, { recursive: true })

  const head = await runCommand(['git', 'rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: repositoryRoot })
  const base = head.exitCode === 0 ? 'HEAD' : EMPTY_TREE

  const indexResult = await runCommand(['git', 'rev-parse', '--path-format=absolute', '--git-path', 'index'], { cwd: repositoryRoot })
  const indexPath = indexResult.stdout.trim()
  if (indexResult.exitCode === 0 && existsSync(indexPath)) copyFileSync(indexPath, temporaryIndex)

  const environment = {
    GIT_INDEX_FILE: temporaryIndex,
    GIT_OBJECT_DIRECTORY: objectDirectory,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: quotedObjectDirectory(await objectsDirectory(runCommand, repositoryRoot)),
  }

  try {
    const intentToAdd = await withEnvironment(runCommand, environment)(['git', 'add', '--intent-to-add', '--', '.'], { cwd: repositoryRoot })

    if (intentToAdd.exitCode !== 0) throw new ReviewSourceError(`git add failed: ${intentToAdd.stderr.split('\n')[0] ?? ''}`)

    await diffToFile({ directory: repositoryRoot, revisions: [base], outputPath, environment })
  } finally {
    rmSync(scratchDirectory, { recursive: true, force: true })
  }

  return base
}
