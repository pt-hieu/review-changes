import './viewer.css'
import {
  REVIEW_PAYLOAD_ELEMENT_ID,
  REVIEW_PAYLOAD_SCHEMA_VERSION,
  type ReviewPayload,
} from '../../plugins/review-changes/hooks/payload.ts'
import { startViewer } from './app.ts'
import { element } from './dom.ts'

function showError(root: HTMLElement, message: string): void {
  root.replaceChildren(element('p', { class: 'fatal' }, message))
}

const root = document.getElementById('app') ?? document.body.appendChild(element('div', { id: 'app' }))
const payloadElement = document.getElementById(REVIEW_PAYLOAD_ELEMENT_ID)

if (!payloadElement?.textContent) {
  showError(root, 'This page has no review in it: the review-payload script element is missing or empty.')
} else {
  let payload: ReviewPayload | null = null
  try {
    payload = JSON.parse(payloadElement.textContent) as ReviewPayload
  } catch (error) {
    showError(root, `This page's review could not be read: ${String(error)}`)
  }

  if (payload) {
    if (payload.schemaVersion !== REVIEW_PAYLOAD_SCHEMA_VERSION) {
      showError(
        root,
        `This review was written in format ${String(payload.schemaVersion)}, and this viewer reads format ${REVIEW_PAYLOAD_SCHEMA_VERSION}. Run /review-changes again to rebuild it.`,
      )
    } else {
      document.title = `${payload.title} · review-changes`
      startViewer(root, payload)
    }
  }
}
