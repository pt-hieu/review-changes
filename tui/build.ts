import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

const tuiDirectory = import.meta.dir
const repositoryRoot = dirname(tuiDirectory)
const sourceDirectory = join(tuiDirectory, 'src')
const defaultOutputDirectory = join(repositoryRoot, 'plugins/review-changes/assets')
const bundleByteLimitUnderFileSystemCap = 3 * 1024 * 1024
const filesAllowedToUseStreams = new Set(['terminal/output.ts', 'main.ts'])
const streamPattern = /process\.(stdout|stderr)|\bconsole\./

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)

    if (entry.isDirectory()) return entry.name === '__test__' ? [] : sourceFiles(path)

    return entry.name.endsWith('.ts') ? [path] : []
  })
}

const streamViolations = sourceFiles(sourceDirectory)
  .map(path => relative(sourceDirectory, path))
  .filter(path => !filesAllowedToUseStreams.has(path))
  .filter(path => streamPattern.test(readFileSync(join(sourceDirectory, path), 'utf8')))

if (streamViolations.length > 0) {
  console.error(`only terminal/output.ts may write to a stream; found in: ${streamViolations.join(', ')}`)
  process.exit(1)
}

const outputDirectory = process.argv[2] ?? defaultOutputDirectory

const workerBuild = await Bun.build({
  entrypoints: [join(sourceDirectory, 'highlight/worker.ts')],
  target: 'bun',
  format: 'esm',
  minify: true,
  splitting: false,
  outdir: outputDirectory,
  naming: { entry: 'highlight-worker.js' },
})

const appBuild = await Bun.build({
  entrypoints: [join(sourceDirectory, 'main.ts')],
  target: 'bun',
  format: 'esm',
  minify: true,
  splitting: false,
  outdir: outputDirectory,
  naming: { entry: 'review-changes.js' },
})

const results = [workerBuild, appBuild]
const result = { logs: results.flatMap(build => build.logs), success: results.every(build => build.success), outputs: results.flatMap(build => build.outputs) }

for (const message of result.logs) console.warn(message)

if (!result.success) process.exit(1)

const totalBytes = result.outputs.reduce((total, output) => total + statSync(output.path).size, 0)

if (totalBytes > bundleByteLimitUnderFileSystemCap) {
  console.error(`bundle is ${totalBytes} bytes, over the ${bundleByteLimitUnderFileSystemCap} byte limit`)
  process.exit(1)
}
