import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { ReviewCategory, ReviewFileStatus, ReviewTargetKind } from '../../../plugins/review-changes/hooks/types.ts'
import type { ReviewFile, ReviewPayload } from '../../../plugins/review-changes/hooks/payload.ts'
import { startViewer } from '../app.ts'
import { readLayout } from '../storage.ts'
import { DiffLayout } from '../types.ts'

function fileAt(path: string, patchHash: string): ReviewFile {
  return {
    path,
    status: ReviewFileStatus.Modified,
    additions: 1,
    deletions: 1,
    isBinary: false,
    hunks: [{ header: '@@ -1 +1 @@', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }],
    patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
    patchHash,
    isPatchOmitted: false,
  }
}

function buildPayload(): ReviewPayload {
  return {
    schemaVersion: 1,
    generatedAt: '2026-01-01T00:00:00Z',
    repository: { root: '/work/repo', name: 'shop' },
    target: { kind: ReviewTargetKind.Worktree, key: 'worktree', label: 'Working tree', branch: null, base: 'HEAD' },
    title: 'Add checkout',
    commits: [],
    files: [fileAt('src/cart.ts', 'h1'), fileAt('src/pay.ts', 'h2'), fileAt('docs/readme.md', 'h3')],
    analysis: {
      overallSummary: 'Adds **checkout**.',
      groups: [
        {
          key: 'core',
          label: 'Checkout logic',
          category: ReviewCategory.Core,
          summary: 'Cart and payment.',
          filePaths: ['src/cart.ts', 'src/pay.ts'],
          fileNotes: [{ path: 'src/pay.ts', text: 'Handles <b>money</b>.', critical: true }],
          lineNotes: [],
        },
        {
          key: 'docs',
          label: 'Documentation',
          category: ReviewCategory.Docs,
          summary: '',
          filePaths: ['docs/readme.md'],
          fileNotes: [],
          lineNotes: [],
        },
      ],
    },
  }
}

let root: HTMLElement

function buttonWithText(text: string): HTMLButtonElement {
  const button = Array.from(root.querySelectorAll('button')).find((candidate) => candidate.textContent === text)
  if (!button) throw new Error(`no button with text ${text}`)
  return button
}

function reviewedCheckbox(path: string): HTMLInputElement {
  const checkbox = root.querySelector<HTMLInputElement>(`input[aria-label="Reviewed ${path}"]`)
  if (!checkbox) throw new Error(`no reviewed checkbox for ${path}`)
  return checkbox
}

function toggleReviewed(path: string): void {
  const checkbox = reviewedCheckbox(path)
  checkbox.checked = !checkbox.checked
  checkbox.dispatchEvent(new Event('change', { bubbles: true }))
}

function visibleText(): string {
  return root.textContent ?? ''
}

beforeEach(() => {
  window.localStorage.clear()
  window.location.hash = ''
  document.body.replaceChildren()
  root = document.body.appendChild(document.createElement('div'))
})

afterEach(() => {
  document.body.replaceChildren()
})

describe('startViewer', () => {
  test('shows the title, repository, file count, totals and overall summary', () => {
    startViewer(root, buildPayload())

    expect(root.querySelector('h1')?.textContent).toBe('Add checkout')
    expect(visibleText()).toContain('shop')
    expect(visibleText()).toContain('3 files')
    expect(visibleText()).toContain('+3')
    expect(visibleText()).toContain('−3')
    expect(root.querySelector('strong')?.textContent).toBe('checkout')
  })

  test('lists every group with its reviewed count and opens on the first one', () => {
    startViewer(root, buildPayload())

    expect(buttonWithText('coreCheckout logic0/2')).toBeDefined()
    expect(buttonWithText('docsDocumentation0/1')).toBeDefined()
    expect(root.querySelector('h2')?.textContent).toBe('Checkout logic')
    expect(root.querySelectorAll('section[data-path]').length).toBe(2)
  })

  test('switches the shown files when another group is selected', () => {
    startViewer(root, buildPayload())

    buttonWithText('docsDocumentation0/1').click()

    expect(root.querySelector('h2')?.textContent).toBe('Documentation')
    expect(Array.from(root.querySelectorAll('section[data-path]')).map((card) => card.getAttribute('data-path'))).toEqual(['docs/readme.md'])
  })

  test('puts files that no group claims into an Ungrouped group', () => {
    const payload = buildPayload()
    payload.files.push(fileAt('stray.txt', 'h4'))

    startViewer(root, payload)

    expect(visibleText()).toContain('Ungrouped')
    expect(visibleText()).toContain('4 files')
  })

  test('marking a file reviewed updates the progress and the group count and survives a reload', () => {
    const payload = buildPayload()
    startViewer(root, payload)
    expect(visibleText()).toContain('0 / 3 reviewed')

    toggleReviewed('src/cart.ts')

    expect(visibleText()).toContain('1 / 3 reviewed')
    expect(visibleText()).toContain('1/2')
    expect(reviewedCheckbox('src/cart.ts').checked).toBe(true)

    root.replaceChildren()
    startViewer(root, payload)

    expect(visibleText()).toContain('1 / 3 reviewed')
    expect(reviewedCheckbox('src/cart.ts').checked).toBe(true)
    expect(reviewedCheckbox('src/pay.ts').checked).toBe(false)
  })

  test('unmarking a reviewed file lowers the progress again', () => {
    startViewer(root, buildPayload())

    toggleReviewed('src/cart.ts')
    toggleReviewed('src/cart.ts')

    expect(visibleText()).toContain('0 / 3 reviewed')
  })

  test('a file whose patch changed since it was reviewed comes back unreviewed', () => {
    const payload = buildPayload()
    startViewer(root, payload)
    toggleReviewed('src/cart.ts')

    const changedPayload = buildPayload()
    changedPayload.files[0] = fileAt('src/cart.ts', 'h1-changed')
    root.replaceChildren()
    startViewer(root, changedPayload)

    expect(visibleText()).toContain('0 / 3 reviewed')
    expect(reviewedCheckbox('src/cart.ts').checked).toBe(false)
  })

  test('the layout buttons show which layout is active and remember the choice', () => {
    startViewer(root, buildPayload())
    expect(buttonWithText('Unified').getAttribute('aria-pressed')).toBe('true')
    expect(buttonWithText('Split').getAttribute('aria-pressed')).toBe('false')

    buttonWithText('Split').click()

    expect(buttonWithText('Split').getAttribute('aria-pressed')).toBe('true')
    expect(buttonWithText('Unified').getAttribute('aria-pressed')).toBe('false')
    expect(readLayout()).toBe(DiffLayout.Split)
  })

  test('opens in the layout saved earlier', () => {
    window.localStorage.setItem('review-changes:layout', DiffLayout.Split)

    startViewer(root, buildPayload())

    expect(buttonWithText('Split').getAttribute('aria-pressed')).toBe('true')
  })

  test('shows analyst notes as text, never as markup', () => {
    startViewer(root, buildPayload())

    expect(visibleText()).toContain('Handles <b>money</b>.')
    expect(root.querySelector('b')).toBeNull()
  })

  test('flags a group that has a critical note', () => {
    startViewer(root, buildPayload())

    expect(visibleText()).toContain('Review carefully')
  })

  test('filters the file tree by path', () => {
    startViewer(root, buildPayload())
    const filter = root.querySelector<HTMLInputElement>('input[type="search"]')
    if (!filter) throw new Error('no filter input')

    filter.value = 'readme'
    filter.dispatchEvent(new Event('input', { bubbles: true }))

    const treeText = filter.nextElementSibling?.textContent
    expect(treeText).toContain('readme.md')
    expect(treeText).not.toContain('cart.ts')
  })

  test('says so when no file path matches the filter', () => {
    startViewer(root, buildPayload())
    const filter = root.querySelector<HTMLInputElement>('input[type="search"]')
    if (!filter) throw new Error('no filter input')

    filter.value = 'nothing-matches'
    filter.dispatchEvent(new Event('input', { bubbles: true }))

    expect(visibleText()).toContain('No changed file path contains “nothing-matches”.')
  })

  test('keyboard x marks the focused file reviewed', () => {
    startViewer(root, buildPayload())

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }))

    expect(visibleText()).toContain('1 / 3 reviewed')
    expect(reviewedCheckbox('src/cart.ts').checked).toBe(true)
  })

  test('says there is nothing to review when the change has no files', () => {
    const payload = buildPayload()
    payload.files = []
    payload.analysis.groups = []

    startViewer(root, payload)

    expect(visibleText()).toContain('This change has no files to review.')
  })
})
