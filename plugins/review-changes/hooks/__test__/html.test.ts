import { describe, expect, test } from 'claude-code/testing'

import { assembleReviewHtml, HtmlBudgetError } from '../html.ts'
import type { ReviewFile, ReviewPayload } from '../payload.ts'
import { ReviewCategory, ReviewFileStatus, ReviewTargetKind } from '../types.ts'

const hostile = '</script><script>alert(1)</script> <!-- not a comment'

function fileWithPatch(path: string, patch: string): ReviewFile {
  return {
    path,
    status: ReviewFileStatus.Modified,
    additions: 1,
    deletions: 0,
    isBinary: false,
    hunks: [{ header: '@@ -1,1 +1,2 @@', oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 }],
    patch,
    patchHash: `hash-of-${path}`,
    isPatchOmitted: false,
  }
}

function payloadWith(files: ReviewFile[], title = 'Tidy the server'): ReviewPayload {
  return {
    schemaVersion: 1,
    generatedAt: '2026-10-07T12:00:00.000Z',
    repository: { root: '/repo', name: 'acme/shop' },
    target: { kind: ReviewTargetKind.Worktree, key: 'worktree', label: 'Uncommitted changes on main', branch: 'main', base: 'HEAD' },
    title,
    description: hostile,
    commits: [],
    files,
    analysis: {
      overallSummary: hostile,
      groups: [
        {
          key: 'uncategorized',
          label: 'Uncategorized',
          category: ReviewCategory.Other,
          summary: '',
          filePaths: files.map(file => file.path),
          fileNotes: [],
          lineNotes: [],
        },
      ],
    },
  }
}

const payloadElementStart = '<script type="application/json" id="review-payload">'

function embeddedPayload(html: string): unknown {
  const start = html.indexOf(payloadElementStart) + payloadElementStart.length
  const end = html.indexOf('</script>', start)
  return JSON.parse(html.slice(start, end))
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

describe('assembleReviewHtml', () => {
  test('a payload full of markup survives the page intact', () => {
    const payload = payloadWith([fileWithPatch('src/page.html', `diff --git a/src/page.html b/src/page.html\n+${hostile}\n`)], hostile)

    const html = assembleReviewHtml({
      payload,
      viewerScript: 'console.log("</script>", "<!--")',
      viewerStyle: 'body { color: red }',
    })

    expect(embeddedPayload(html)).toStrictEqual(payload)
    expect(html.match(/<script/gi)?.length).toBe(2)
    expect(html).toContain(
      '<title>&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt; &lt;!-- not a comment · review-changes</title>',
    )
    expect(html).toContain('<script type="module">console.log("<\\/script>", "<\\!--")</script>')
    expect(html).toContain('<style>body { color: red }</style>')
  })

  test('drops the largest patches by UTF-8 bytes first until the page fits', () => {
    const accentedPatch = `diff --git a/a.md b/a.md\n+${'é'.repeat(6000)}\n`
    const plainPatch = `diff --git a/b.md b/b.md\n+${'b'.repeat(8000)}\n`
    const smallPatch = 'diff --git a/c.md b/c.md\n+c\n'
    const payload = payloadWith([
      fileWithPatch('a.md', accentedPatch),
      fileWithPatch('b.md', plainPatch),
      fileWithPatch('c.md', smallPatch),
    ])

    const html = assembleReviewHtml({ payload, viewerScript: '', viewerStyle: '', maximumBytes: 12_000 })

    expect(byteLength(html)).toBeLessThanOrEqual(12_000)
    expect(embeddedPayload(html)).toStrictEqual({
      ...payload,
      files: [
        { ...fileWithPatch('a.md', ''), isPatchOmitted: true },
        fileWithPatch('b.md', plainPatch),
        fileWithPatch('c.md', smallPatch),
      ],
    })
    expect(payload.files[0]?.patch).toBe(accentedPatch)
  })

  test('refuses when even a page without any patch is over budget', () => {
    const payload = payloadWith([fileWithPatch('a.md', 'diff --git a/a.md b/a.md\n+a\n')])

    expect(() => assembleReviewHtml({ payload, viewerScript: '', viewerStyle: '', maximumBytes: 100 })).toThrow(HtmlBudgetError)
  })
})
