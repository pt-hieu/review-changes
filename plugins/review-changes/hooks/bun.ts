export type CommandRunner = (
  commandArguments: readonly string[],
  options?: { cwd?: string; stdin?: string; timeoutMs?: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

export const BUN_MISSING_MESSAGE =
  'review-changes needs bun, and none was found. Install it from https://bun.sh.'

const BUN_PROBE_SCRIPT = 'console.log(process.execPath)'
const PROBE_TIMEOUT_MILLISECONDS = 10_000

let resolvedBunPath: string | null = null

export function appArguments(bunPath: string, appPath: string, ...applicationArguments: string[]): string[] {
  return [bunPath, '--no-env-file', appPath, ...applicationArguments]
}

export function forgetBunPath(): void {
  resolvedBunPath = null
}

export function bunCandidates(home: string | undefined): string[] {
  return [
    'bun',
    ...(home === undefined || home === '' ? [] : [`${home}/.bun/bin/bun`]),
    '/opt/homebrew/bin/bun',
    '/usr/local/bin/bun',
  ]
}

export async function resolveBun(runCommand: CommandRunner, home: string | undefined, neutralDirectory: string): Promise<string | null> {
  if (resolvedBunPath !== null) return resolvedBunPath

  for (const candidate of bunCandidates(home)) {
    try {
      const probe = await runCommand([candidate, '--no-env-file', '-e', BUN_PROBE_SCRIPT], {
        cwd: neutralDirectory,
        timeoutMs: PROBE_TIMEOUT_MILLISECONDS,
      })
      const executable = probe.stdout.trim()

      if (probe.exitCode === 0 && executable.startsWith('/')) {
        resolvedBunPath = executable

        return executable
      }
    } catch {
      continue
    }
  }

  return null
}
