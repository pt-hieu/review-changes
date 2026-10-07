import { FileDiff, getFiletypeFromFileName, getSingularPatch, type DiffLineAnnotation } from '@pierre/diffs'
import type { ReviewFile, ReviewLineNote } from '../../plugins/review-changes/hooks/payload.ts'
import { ReviewLineSide } from '../../plugins/review-changes/hooks/types.ts'
import { bundledLanguages } from '../shiki-subset.ts'
import { element } from './dom.ts'
import { renderMarkdown } from './markdown.ts'
import type { DiffLayout } from './types.ts'

export type MountedDiff = {
  setLayout(layout: DiffLayout): void
  destroy(): void
}

function baseOptions(layout: DiffLayout) {
  return {
    diffStyle: layout,
    theme: { dark: 'pierre-dark', light: 'pierre-light' },
    themeType: 'system',
    preferredHighlighter: 'shiki-js',
    disableFileHeader: true,
    overflow: 'wrap',
    lineDiffType: 'word-alt',
    hunkSeparators: 'line-info',
    diffIndicators: 'bars',
  } as const
}

export function estimateUnifiedRowCount(file: ReviewFile): number {
  return file.hunks.reduce((rows, hunk) => rows + hunk.oldLines + 1, 0) + file.additions
}

export function mountDiff(
  container: HTMLElement,
  file: ReviewFile,
  lineNotes: ReviewLineNote[],
  layout: DiffLayout,
): MountedDiff {
  const fileDiff = getSingularPatch(file.patch)
  const language = getFiletypeFromFileName(file.path)
  if (!Object.hasOwn(bundledLanguages, language)) fileDiff.lang = 'text'

  const notesByLine = new Map<string, ReviewLineNote[]>()
  for (const note of lineNotes) {
    const lineKey = `${note.side}:${note.line}`
    notesByLine.set(lineKey, [...(notesByLine.get(lineKey) ?? []), note])
  }

  const lineAnnotations: DiffLineAnnotation<ReviewLineNote[]>[] = [...notesByLine.values()].map((notes) => ({
    side: notes[0]?.side ?? ReviewLineSide.Additions,
    lineNumber: notes[0]?.line ?? 0,
    metadata: notes,
  }))

  const instance = new FileDiff<ReviewLineNote[]>({
    ...baseOptions(layout),
    renderAnnotation: (annotation) => renderLineNotes(annotation.metadata),
  })
  instance.render({ fileDiff, containerWrapper: container, lineAnnotations })

  return {
    setLayout(nextLayout) {
      instance.setOptions({ ...instance.options, diffStyle: nextLayout })
      instance.rerender()
    },
    destroy() {
      instance.cleanUp()
    },
  }
}

function renderLineNotes(notes: ReviewLineNote[]): HTMLElement {
  return element(
    'div',
    { class: 'line-notes' },
    ...notes.map((note) =>
      element(
        'div',
        { class: note.critical ? 'line-note is-critical' : 'line-note' },
        element('span', { class: 'line-note-marker', 'aria-hidden': 'true' }, note.critical ? '!' : 'i'),
        element('div', { class: 'markdown line-note-text' }, renderMarkdown(note.text)),
      ),
    ),
  )
}
