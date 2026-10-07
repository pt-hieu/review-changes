import type { ReviewFile, ReviewPayload } from '../../plugins/review-changes/hooks/payload.ts'
import { DiffLayout } from './types.ts'

const memoryFallbackWhenStorageRefused = new Map<string, string>()

function readItem(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return memoryFallbackWhenStorageRefused.get(key) ?? null
  }
}

function writeItem(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    if (value === null) memoryFallbackWhenStorageRefused.delete(key)
    else memoryFallbackWhenStorageRefused.set(key, value)
  }
}

const layoutKey = 'review-changes:layout'
const collapseReviewedKey = 'review-changes:collapse-reviewed'

export function readLayout(): DiffLayout {
  return readItem(layoutKey) === DiffLayout.Split ? DiffLayout.Split : DiffLayout.Unified
}

export function writeLayout(layout: DiffLayout): void {
  writeItem(layoutKey, layout)
}

export function readCollapseReviewed(): boolean {
  return readItem(collapseReviewedKey) !== '0'
}

export function writeCollapseReviewed(isCollapsing: boolean): void {
  writeItem(collapseReviewedKey, isCollapsing ? '1' : '0')
}

export function patchHashedReviewedKey(payload: ReviewPayload, file: ReviewFile): string {
  return `review-changes:v1:${payload.repository.root}:${payload.target.key}:${file.path}:${file.patchHash}`
}

export function readReviewed(payload: ReviewPayload, file: ReviewFile): boolean {
  return readItem(patchHashedReviewedKey(payload, file)) === '1'
}

export function writeReviewed(payload: ReviewPayload, file: ReviewFile, isReviewed: boolean): void {
  writeItem(patchHashedReviewedKey(payload, file), isReviewed ? '1' : null)
}
