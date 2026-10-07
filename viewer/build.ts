import { dirname, join, relative } from 'node:path'
import { rename, rm, stat } from 'node:fs/promises'
import type { BunPlugin } from 'bun'

const viewerDirectory = import.meta.dir
const repositoryRoot = dirname(viewerDirectory)
const outputDirectory = join(repositoryRoot, 'plugins/review-changes/assets')
const bundleByteLimitUnderFileSystemCap = 3 * 1024 * 1024

const diffsPackageDirectory = dirname(Bun.resolveSync('@pierre/diffs/package.json', viewerDirectory))
const themingPackageDirectory = dirname(Bun.resolveSync('@pierre/theming/package.json', diffsPackageDirectory))

const subsetPlugin: BunPlugin = {
  name: 'review-changes-subset',
  setup(build) {
    build.onResolve({ filter: /^shiki$/ }, () => ({ path: join(viewerDirectory, 'shiki-subset.ts') }))
    build.onResolve({ filter: /^shiki\/wasm$/ }, () => ({ path: join(viewerDirectory, 'shiki-wasm-stub.ts') }))
    build.onResolve({ filter: /^@pierre\/theming\/themes$/ }, () => ({ path: join(viewerDirectory, 'theming-subset.ts') }))
    build.onResolve({ filter: /^@pierre\/theming\/dist\// }, (resolveArguments) => ({
      path: join(themingPackageDirectory, resolveArguments.path.slice('@pierre/theming/'.length)),
    }))
  },
}

await rm(outputDirectory, { recursive: true, force: true })

const result = await Bun.build({
  entrypoints: [join(viewerDirectory, 'src/main.ts')],
  target: 'browser',
  format: 'esm',
  minify: true,
  splitting: false,
  outdir: outputDirectory,
  naming: { entry: 'viewer.[ext]', asset: '[name].[ext]', chunk: '[name].[ext]' },
  plugins: [subsetPlugin],
})

for (const message of result.logs) console.warn(message)

if (!result.success) process.exit(1)

let totalBytes = 0
for (const output of result.outputs) {
  const extension = output.path.endsWith('.css') ? 'css' : output.path.endsWith('.js') ? 'js' : null

  if (extension === null) {
    console.error(`Unexpected build output: ${relative(repositoryRoot, output.path)}`)
    process.exit(1)
  }

  const finalPath = join(outputDirectory, `viewer.${extension}`)
  if (output.path !== finalPath) await rename(output.path, finalPath)

  const { size } = await stat(finalPath)
  totalBytes += size
  console.log(`${relative(repositoryRoot, finalPath)}  ${(size / 1024).toFixed(1)} KiB`)
}

console.log(`total  ${(totalBytes / 1024 / 1024).toFixed(2)} MiB (limit ${bundleByteLimitUnderFileSystemCap / 1024 / 1024} MiB)`)

if (totalBytes > bundleByteLimitUnderFileSystemCap) {
  console.error('The viewer bundle is over its limit: drop grammars from viewer/shiki-subset.ts.')
  process.exit(1)
}
