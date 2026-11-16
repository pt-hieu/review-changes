import { appArguments } from './bun.ts'
import type { CommandRunner } from './bun.ts'

export type RexLocation = { block: string; session: string; binary: string }

export type RexEnvironment = { block?: string; session?: string; binaryDirectory?: string; home?: string }

export type HookEnvironment = { rex: RexLocation | null; home: string | undefined }

export const PANE_LABEL = 'review-changes'
export const PANE_RATIO_PERCENT = '70'

const REX_COMMAND_TIMEOUT_MILLISECONDS = 15_000

function locateRex(environment: RexEnvironment): RexLocation | null {
  if (!environment.block || !environment.session) return null

  const binary = environment.binaryDirectory ? `${environment.binaryDirectory}/rex` : 'rex'

  return { block: environment.block, session: environment.session, binary }
}

export function parseHookEnvironment(variables: RexEnvironment): HookEnvironment {
  return { rex: locateRex(variables), home: variables.home === '' ? undefined : variables.home }
}

export function splitArguments(rex: RexLocation, bunPath: string, appPath: string, neutralDirectory: string, reviewDirectory: string): string[] {
  return [
    rex.binary, 'split', '-s', rex.session, '-b', rex.block,
    '--split=right', '--ratio', PANE_RATIO_PERCENT, '--label', PANE_LABEL,
    '--shell=none', '-c', neutralDirectory, '--json',
    '--', ...appArguments(bunPath, appPath, 'open', reviewDirectory),
  ]
}

export function inspectArguments(rex: RexLocation, blockId: string): string[] {
  return [rex.binary, 'block', 'inspect', blockId, '-s', rex.session]
}

export function focusArguments(rex: RexLocation, blockId: string): string[] {
  return [rex.binary, 'block', 'focus', blockId, '-s', rex.session]
}

export function closeArguments(rex: RexLocation, blockId: string): string[] {
  return [rex.binary, 'block', 'close', blockId, '-s', rex.session]
}

export function parseSplitBlockId(stdout: string): string | null {
  try {
    const parsed: unknown = JSON.parse(stdout)
    const blockIds = typeof parsed === 'object' && parsed !== null && 'block_ids' in parsed ? parsed.block_ids : undefined
    const first: unknown = Array.isArray(blockIds) ? blockIds[0] : undefined

    return typeof first === 'string' && first !== '' ? first : null
  } catch {
    return null
  }
}

export async function isBlockAlive(runCommand: CommandRunner, rex: RexLocation, blockId: string): Promise<boolean> {
  try {
    return (await runCommand(inspectArguments(rex, blockId), { timeoutMs: REX_COMMAND_TIMEOUT_MILLISECONDS })).exitCode === 0
  } catch {
    return false
  }
}

export async function runRex(runCommand: CommandRunner, commandArguments: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return runCommand(commandArguments, { timeoutMs: REX_COMMAND_TIMEOUT_MILLISECONDS })
}
