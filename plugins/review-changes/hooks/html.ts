import { REVIEW_PAYLOAD_ELEMENT_ID } from './payload.ts'
import type { ReviewPayload } from './payload.ts'

const ENGINE_WRITE_LIMIT_BYTES = 4 * 1024 * 1024
const ENGINE_ACCOUNTING_HEADROOM_BYTES = 64 * 1024
export const MAXIMUM_HTML_BYTES = ENGINE_WRITE_LIMIT_BYTES - ENGINE_ACCOUNTING_HEADROOM_BYTES

export class HtmlBudgetError extends Error {
  override name = 'HtmlBudgetError'
}

const encoder = new TextEncoder()

function byteLength(text: string): number {
  return encoder.encode(text).length
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

function scriptSafeModule(source: string): string {
  return source.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--')
}

function styleSafe(source: string): string {
  return source.replace(/<\/style/gi, '<\\/style')
}

function renderPage(payload: ReviewPayload, viewerScript: string, viewerStyle: string): string {
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    `<title>${escapeHtml(payload.title)} · review-changes</title>`,
    `<style>${styleSafe(viewerStyle)}</style></head>`,
    '<body><div id="app"></div>',
    `<script type="application/json" id="${REVIEW_PAYLOAD_ELEMENT_ID}">${scriptSafeJson(payload)}</script>`,
    `<script type="module">${scriptSafeModule(viewerScript)}</script>`,
    '</body></html>',
    '',
  ].join('\n')
}

export function assembleReviewHtml({
  payload,
  viewerScript,
  viewerStyle,
  maximumBytes = MAXIMUM_HTML_BYTES,
}: {
  payload: ReviewPayload
  viewerScript: string
  viewerStyle: string
  maximumBytes?: number
}): string {
  let html = renderPage(payload, viewerScript, viewerStyle)
  let size = byteLength(html)

  if (size <= maximumBytes) return html

  const files = payload.files.map(file => ({ ...file }))
  const largestFirst = files
    .filter(file => file.patch !== '')
    .map(file => ({ file, savedBytes: byteLength(scriptSafeJson(file.patch)) - byteLength('""') }))
    .sort((left, right) => right.savedBytes - left.savedBytes)
  const fitted: ReviewPayload = { ...payload, files }

  let estimatedSizeFromPatchSavings = size
  let isRenderStale = false
  for (const { file, savedBytes } of largestFirst) {
    file.patch = ''
    file.isPatchOmitted = true
    isRenderStale = true
    estimatedSizeFromPatchSavings -= savedBytes

    const isEstimatedToFit = estimatedSizeFromPatchSavings <= maximumBytes

    if (!isEstimatedToFit) continue

    html = renderPage(fitted, viewerScript, viewerStyle)
    size = byteLength(html)
    isRenderStale = false

    if (size <= maximumBytes) return html

    estimatedSizeFromPatchSavings = size
  }

  if (isRenderStale) {
    html = renderPage(fitted, viewerScript, viewerStyle)
    size = byteLength(html)

    if (size <= maximumBytes) return html
  }

  throw new HtmlBudgetError(
    `the review page needs ${size} bytes even without any diff, over the ${maximumBytes}-byte limit`,
  )
}
