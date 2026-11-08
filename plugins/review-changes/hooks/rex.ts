import { appArguments } from './bun.ts'
import type { CommandRunner } from './bun.ts'

export type RexLocation = { block: string; session: string; binary: string }

export const PANE_LABEL = 'review-changes'
export const PANE_RATIO_PERCENT = '70'

const REX_COMMAND_TIMEOUT_MILLISECONDS = 15_000

export function locateRex(environment: { block?: string; session?: string; binaryDirectory?: string }): RexLocation | null {
  if (!environment.block || !environment.session) return null

  const binary = environment.binaryDirectory ? `${environment.binaryDirectory}/rex` : 'rex'

  return { block: environment.block, session: environment.session, binary }
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
    const parsed = JSON.parse(stdout) as { block_ids?: unknown }
    const first = Array.isArray(parsed.block_ids) ? parsed.block_ids[0] : undefined

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
