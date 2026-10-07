import { join } from 'node:path'
import { assembleReviewHtml } from '../../plugins/review-changes/hooks/html.ts'
import type { ReviewPayload } from '../../plugins/review-changes/hooks/payload.ts'

const developmentDirectory = import.meta.dir
const assetsDirectory = join(developmentDirectory, '../../plugins/review-changes/assets')
const payloadPath = process.argv[2] ?? join(developmentDirectory, 'fixture.json')
const outputPath = process.argv[3] ?? join(developmentDirectory, 'fixture.html')

const payload = (await Bun.file(payloadPath).json()) as ReviewPayload
const viewerScript = await Bun.file(join(assetsDirectory, 'viewer.js')).text()
const viewerStyle = await Bun.file(join(assetsDirectory, 'viewer.css')).text()
const page = assembleReviewHtml({ payload, viewerScript, viewerStyle })

await Bun.write(outputPath, page)
console.log(`${outputPath}  ${(page.length / 1024).toFixed(1)} KiB`)
