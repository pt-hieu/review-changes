import { statSync } from 'node:fs'
import type { RunCommand } from '../review/git.ts'

const MAXIMUM_CAPTURED_BYTES = 32 * 1024 * 1024
const SIZE_WATCH_INTERVAL_MILLISECONDS = 1000
const DROPPED_GIT_VARIABLES = /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG\w*|EXTERNAL_DIFF|EXEC_PATH|TEMPLATE_DIR|ATTR_\w+|PAGER)$/

export const HARDENED_GIT_ENVIRONMENT: Record<string, string> = {
  LC_ALL: 'C',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'core.hooksPath',
  GIT_CONFIG_VALUE_0: '/dev/null',
  GIT_CONFIG_KEY_1: 'core.fsmonitor',
  GIT_CONFIG_VALUE_1: 'false',
}

export type FileCommandResult = { exitCode: number; stderr: string; isOverSizeLimit: boolean }

export function environmentFor(extra: Record<string, string> | undefined): Record<string, string> {
  const inherited: Record<string, string> = {}

  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !DROPPED_GIT_VARIABLES.test(name)) inherited[name] = value
  }

  return { ...inherited, ...HARDENED_GIT_ENVIRONMENT, ...extra }
}

export function withEnvironment(runCommand: RunCommand, extra: Record<string, string>): RunCommand {
  return (commandArguments, options) => runCommand(commandArguments, { ...options, env: { ...options?.env, ...extra } })
}

async function readCapped(stream: ReadableStream<Uint8Array>): Promise<{ text: string; isTruncated: boolean }> {
  const chunks: Uint8Array[] = []
  let byteCount = 0
  let isTruncated = false

  for await (const chunk of stream) {
    if (byteCount + chunk.length > MAXIMUM_CAPTURED_BYTES) {
      isTruncated = true
      continue
    }

    chunks.push(chunk)
    byteCount += chunk.length
  }

  return { text: Buffer.concat(chunks).toString('utf8'), isTruncated }
}

export function createCommandRunner(): RunCommand {
  return async (commandArguments, options) => {
    const child = Bun.spawn([...commandArguments], {
      cwd: options?.cwd,
      env: environmentFor(options?.env),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timer = options?.timeoutMs === undefined ? undefined : setTimeout(() => child.kill(), options.timeoutMs)

    const [standardOutput, standardError, exitCode] = await Promise.all([
      readCapped(child.stdout),
      readCapped(child.stderr),
      child.exited,
    ])

    clearTimeout(timer)

    return { exitCode, stdout: standardOutput.text, stderr: standardError.text, isStdoutTruncated: standardOutput.isTruncated }
  }
}

export async function runCommandToFile(
  commandArguments: readonly string[],
  options: { cwd: string; env?: Record<string, string>; outputPath: string; maximumBytes: number; timeoutMs?: number },
): Promise<FileCommandResult> {
  const child = Bun.spawn([...commandArguments], {
    cwd: options.cwd,
    env: environmentFor(options.env),
    stdin: 'ignore',
    stdout: Bun.file(options.outputPath),
    stderr: 'pipe',
  })
  let isOverSizeLimit = false

  const watcher = setInterval(() => {
    try {
      if (statSync(options.outputPath).size > options.maximumBytes) {
        isOverSizeLimit = true
        child.kill()
      }
    } catch {
      return
    }
  }, SIZE_WATCH_INTERVAL_MILLISECONDS)
  const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => child.kill(), options.timeoutMs)

  const [standardError, exitCode] = await Promise.all([readCapped(child.stderr), child.exited])

  clearInterval(watcher)
  clearTimeout(timer)

  if (!isOverSizeLimit) isOverSizeLimit = statSync(options.outputPath).size > options.maximumBytes

  return { exitCode, stderr: standardError.text, isOverSizeLimit }
}
