import type {
  ReviewFile,
  ReviewFileNote,
  ReviewGroup,
  ReviewLineNote,
  ReviewPayload,
  ReviewTarget,
} from '../../plugins/review-changes/hooks/payload.ts'
import { ReviewCategory, ReviewFileStatus, ReviewLineSide, ReviewTargetKind } from '../../plugins/review-changes/hooks/types.ts'
import { estimateUnifiedRowCount, mountDiff, type MountedDiff } from './diff.ts'
import { append, clear, element, httpUrlOrNull, type Child } from './dom.ts'
import { renderMarkdown } from './markdown.ts'
import {
  readCollapseReviewed,
  readLayout,
  readReviewed,
  writeCollapseReviewed,
  writeLayout,
  writeReviewed,
} from './storage.ts'
import { DiffLayout } from './types.ts'

const statusLabels: Record<ReviewFileStatus, string> = {
  [ReviewFileStatus.Added]: 'Added',
  [ReviewFileStatus.Removed]: 'Deleted',
  [ReviewFileStatus.Modified]: 'Modified',
  [ReviewFileStatus.Renamed]: 'Renamed',
  [ReviewFileStatus.Copied]: 'Copied',
}

type CriticalItem = { path: string; line?: number; side?: ReviewLineNote['side']; text: string }

export function startViewer(root: HTMLElement, payload: ReviewPayload): void {
  const filesByPath = new Map(payload.files.map((file) => [file.path, file]))
  const groups = withUngroupedFiles(payload)

  const groupIndexByPath = new Map<string, number>()
  groups.forEach((group, groupIndex) => {
    for (const path of group.filePaths) groupIndexByPath.set(path, groupIndex)
  })
  const orderedPathsByGroup = groups.map((group) => orderByDirectory(group.filePaths.filter((path) => filesByPath.has(path))))
  const allPathsInOrder = orderedPathsByGroup.flat()

  const reviewedPaths = new Set(payload.files.filter((file) => readReviewed(payload, file)).map((file) => file.path))
  let layout: DiffLayout = readLayout()
  let isCollapsingReviewed = readCollapseReviewed()
  let activeGroupIndex = Math.max(0, groups.findIndex((group) => `#${group.key}` === window.location.hash))
  let focusedPath: string | null = null
  let filterText = ''
  const personalCollapseOverrides = new Map<string, boolean>()
  const mountedDiffs = new Map<string, MountedDiff>()
  const checkboxesByPath = new Map<string, HTMLInputElement[]>()
  const cardsByPath = new Map<string, HTMLElement>()

  const totals = payload.files.reduce(
    (sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }),
    { additions: 0, deletions: 0 },
  )

  const progressText = element('span', { class: 'progress-text' })
  const progressBar = element('span', { class: 'progress-bar' }, element('span', { class: 'progress-fill' }))
  const unifiedButton = element('button', { type: 'button', class: 'segment', 'data-layout': DiffLayout.Unified }, 'Unified')
  const splitButton = element('button', { type: 'button', class: 'segment', 'data-layout': DiffLayout.Split }, 'Split')
  const collapseToggle = element('input', { type: 'checkbox' })
  collapseToggle.checked = isCollapsingReviewed

  const header = element(
    'header',
    { class: 'top' },
    element(
      'div',
      { class: 'top-main' },
      element('h1', { class: 'title' }, payload.title),
      element(
        'div',
        { class: 'meta' },
        ...targetMeta(payload.target, payload.title),
        element('span', { class: 'meta-item' }, payload.repository.name),
        payload.commits.length > 0 && element('span', { class: 'meta-item' }, plural(payload.commits.length, 'commit')),
        element('span', { class: 'meta-item' }, plural(payload.files.length, 'file')),
        element(
          'span',
          { class: 'meta-item line-counts' },
          element('span', { class: 'additions' }, `+${totals.additions}`),
          element('span', { class: 'deletions' }, `−${totals.deletions}`),
        ),
      ),
    ),
    element(
      'div',
      { class: 'top-tools' },
      element('div', { class: 'progress', title: 'Files marked reviewed' }, progressText, progressBar),
      element('div', { class: 'segmented', role: 'group', 'aria-label': 'Diff layout' }, unifiedButton, splitButton),
      element('label', { class: 'toggle' }, collapseToggle, 'Collapse reviewed'),
    ),
  )

  const groupList = element('ol', { class: 'group-list' })
  const groupCountElements: HTMLElement[] = []
  const groupButtons: HTMLButtonElement[] = []
  groups.forEach((group, groupIndex) => {
    const count = element('span', { class: 'group-count' })
    groupCountElements.push(count)
    const button = element(
      'button',
      { type: 'button', class: 'group-button', 'data-category': group.category },
      element('span', { class: 'category-chip' }, group.category),
      element('span', { class: 'group-label' }, group.label),
      isGroupCritical(group) && element('span', { class: 'critical-dot', title: 'Has spots to review carefully' }),
      count,
    )
    button.addEventListener('click', () => selectGroup(groupIndex))
    groupButtons.push(button)
    groupList.appendChild(element('li', {}, button))
  })

  const filterInput = element('input', {
    type: 'search',
    class: 'filter',
    placeholder: 'Filter files by path',
    'aria-label': 'Filter files by path',
    spellcheck: 'false',
  })
  const tree = element('div', { class: 'tree' })
  const sidebar = element(
    'aside',
    { class: 'sidebar' },
    element('nav', { 'aria-label': 'Groups' }, groupList),
    element('div', { class: 'tree-section' }, filterInput, tree),
    element(
      'p',
      { class: 'shortcuts' },
      ...shortcut('j', 'k', 'file'),
      ...shortcut('[', ']', 'group'),
      element('kbd', {}, 'x'),
      ' reviewed ',
      element('kbd', {}, 's'),
      ' layout',
    ),
  )

  const groupSection = element('section', { class: 'group' })
  const main = element('main', { class: 'content' }, renderOverview(payload), groupSection)

  append(root, [header, element('div', { class: 'columns' }, sidebar, main)])

  const diffObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const host = entry.target as HTMLElement
        diffObserver.unobserve(host)
        mountDiffInto(host)
      }
    },
    { root: main, rootMargin: '1200px 0px' },
  )

  function mountDiffInto(host: HTMLElement): void {
    const path = host.dataset.path ?? ''
    const file = filesByPath.get(path)
    const group = groups[groupIndexByPath.get(path) ?? -1]
    if (!file || !group || mountedDiffs.has(path)) return
    try {
      mountedDiffs.set(path, mountDiff(host, file, group.lineNotes.filter((note) => note.path === path), layout))
      host.style.minHeight = ''
    } catch (error) {
      host.style.minHeight = ''
      host.replaceChildren(
        element('p', { class: 'placeholder' }, `This diff could not be drawn (${String(error)}). The raw patch follows.`),
        element('pre', { class: 'raw-patch' }, file.patch),
      )
    }
  }

  function selectGroup(groupIndex: number, options: { isScrolling?: boolean } = {}): void {
    if (groupIndex < 0 || groupIndex >= groups.length) return
    activeGroupIndex = groupIndex
    const group = groups[groupIndex]
    if (group) window.history.replaceState(null, '', `#${group.key}`)
    renderActiveGroup()
    if (options.isScrolling !== false) groupSection.scrollIntoView({ block: 'start' })
  }

  function renderActiveGroup(): void {
    diffObserver.disconnect()
    for (const mounted of mountedDiffs.values()) mounted.destroy()
    mountedDiffs.clear()
    cardsByPath.clear()
    for (const [path, checkboxes] of checkboxesByPath) {
      checkboxesByPath.set(
        path,
        checkboxes.filter((checkbox) => !groupSection.contains(checkbox)),
      )
    }
    groupButtons.forEach((button, groupIndex) => button.classList.toggle('is-active', groupIndex === activeGroupIndex))

    clear(groupSection)
    const group = groups[activeGroupIndex]
    if (!group) {
      groupSection.appendChild(element('p', { class: 'placeholder' }, 'This change has no files to review.'))
      renderTree()
      return
    }
    const criticalItems = collectCriticalItems(group)
    append(groupSection, [
      element(
        'div',
        { class: 'group-heading' },
        element('h2', {}, group.label),
        element('span', { class: 'category-chip', 'data-category': group.category }, group.category),
        group.critical && element('span', { class: 'careful-chip' }, 'Review carefully'),
      ),
      group.summary && element('div', { class: 'markdown group-summary' }, renderMarkdown(group.summary)),
      criticalItems.length > 0 && renderCallout(criticalItems),
    ])
    const fileList = element('div', { class: 'file-list' })
    for (const path of orderedPathsByGroup[activeGroupIndex] ?? []) {
      const file = filesByPath.get(path)
      if (file) fileList.appendChild(renderFileCard(file, group))
    }
    groupSection.appendChild(fileList)
    renderTree()
    refreshProgress()
  }

  function renderCallout(items: CriticalItem[]): HTMLElement {
    return element(
      'aside',
      { class: 'callout', 'aria-label': 'Review carefully' },
      element('h3', {}, 'Review carefully'),
      element(
        'ul',
        {},
        ...items.map((item) => {
          const location = element(
            'button',
            { type: 'button', class: 'callout-location' },
            item.line === undefined ? item.path : `${item.path}:${item.line}${item.side === ReviewLineSide.Deletions ? ' (old)' : ''}`,
          )
          location.addEventListener('click', () => jumpToFile(item.path, { isExpanding: true }))
          return element('li', {}, location, element('div', { class: 'markdown' }, renderMarkdown(item.text)))
        }),
      ),
    )
  }

  function renderFileCard(file: ReviewFile, group: ReviewGroup): HTMLElement {
    const checkbox = reviewedCheckbox(file)
    const toggleButton = element(
      'button',
      { type: 'button', class: 'file-toggle', 'aria-expanded': 'true' },
      element('span', { class: 'chevron', 'aria-hidden': 'true' }),
      renderPath(file),
    )
    const fileNotes = group.fileNotes.filter((note) => note.path === file.path)
    const diffHost = element('div', { class: 'diff-host', 'data-path': file.path })
    const body = element(
      'div',
      { class: 'file-body' },
      fileNotes.length > 0 && renderFileNotes(fileNotes),
      diffHost,
    )
    const placeholder = diffPlaceholder(file)
    if (placeholder) {
      diffHost.appendChild(element('p', { class: 'placeholder' }, placeholder))
    } else {
      diffHost.style.minHeight = `${Math.min(estimateUnifiedRowCount(file), 400) * 20}px`
      diffObserver.observe(diffHost)
    }

    const card = element(
      'section',
      { class: 'file-card', 'data-path': file.path },
      element(
        'header',
        { class: 'file-header' },
        element('label', { class: 'reviewed-box', title: 'Mark reviewed (x)' }, checkbox),
        toggleButton,
        element('span', { class: `status status-${file.status}` }, statusLabels[file.status]),
        element(
          'span',
          { class: 'line-counts' },
          element('span', { class: 'additions' }, `+${file.additions}`),
          element('span', { class: 'deletions' }, `−${file.deletions}`),
        ),
      ),
      body,
    )
    toggleButton.addEventListener('click', () => {
      personalCollapseOverrides.set(file.path, !card.classList.contains('is-collapsed'))
      focusFile(file.path, { isScrolling: false })
      applyCollapse(file.path)
    })
    card.addEventListener('pointerdown', () => focusFile(file.path, { isScrolling: false }))
    cardsByPath.set(file.path, card)
    applyCollapse(file.path, card)
    if (focusedPath === file.path) card.classList.add('is-focused')
    return card
  }

  function renderFileNotes(notes: ReviewFileNote[]): HTMLElement {
    return element(
      'ul',
      { class: 'file-notes' },
      ...notes.map((note) =>
        element('li', { class: note.critical ? 'file-note is-critical' : 'file-note' }, element('div', { class: 'markdown' }, renderMarkdown(note.text))),
      ),
    )
  }

  function reviewedCheckbox(file: ReviewFile): HTMLInputElement {
    const checkbox = element('input', { type: 'checkbox', 'aria-label': `Reviewed ${file.path}` })
    checkbox.checked = reviewedPaths.has(file.path)
    checkbox.addEventListener('change', () => setReviewed(file.path, checkbox.checked))
    checkboxesByPath.set(file.path, [...(checkboxesByPath.get(file.path) ?? []), checkbox])
    return checkbox
  }

  function setReviewed(path: string, isReviewed: boolean): void {
    const file = filesByPath.get(path)
    if (!file) return
    if (isReviewed) reviewedPaths.add(path)
    else reviewedPaths.delete(path)
    writeReviewed(payload, file, isReviewed)
    personalCollapseOverrides.delete(path)
    for (const checkbox of checkboxesByPath.get(path) ?? []) checkbox.checked = isReviewed
    for (const treeItem of tree.querySelectorAll<HTMLElement>('.tree-file')) {
      if (treeItem.dataset.path === path) treeItem.classList.toggle('is-reviewed', isReviewed)
    }
    applyCollapse(path)
    refreshProgress()
  }

  function applyCollapse(path: string, card = cardsByPath.get(path)): void {
    if (!card) return
    const isCollapsed = personalCollapseOverrides.get(path) ?? (isCollapsingReviewed && reviewedPaths.has(path))
    card.classList.toggle('is-collapsed', isCollapsed)
    card.querySelector('.file-toggle')?.setAttribute('aria-expanded', String(!isCollapsed))
  }

  function refreshProgress(): void {
    progressText.textContent = `${reviewedPaths.size} / ${payload.files.length} reviewed`
    const fill = progressBar.firstElementChild as HTMLElement | null
    if (fill) fill.style.width = `${payload.files.length === 0 ? 0 : (reviewedPaths.size / payload.files.length) * 100}%`
    orderedPathsByGroup.forEach((paths, groupIndex) => {
      const reviewedCount = paths.filter((path) => reviewedPaths.has(path)).length
      const countElement = groupCountElements[groupIndex]
      if (countElement) countElement.textContent = `${reviewedCount}/${paths.length}`
      groupButtons[groupIndex]?.classList.toggle('is-done', paths.length > 0 && reviewedCount === paths.length)
    })
  }

  function renderTree(): void {
    for (const [path, checkboxes] of checkboxesByPath) {
      checkboxesByPath.set(
        path,
        checkboxes.filter((checkbox) => !tree.contains(checkbox)),
      )
    }
    clear(tree)
    const query = filterText.trim().toLowerCase()
    if (!query) {
      appendTreeFiles(tree, orderedPathsByGroup[activeGroupIndex] ?? [])
      groupButtons.forEach((button) => button.classList.remove('is-filtered-out'))
      return
    }
    let matchCount = 0
    groups.forEach((group, groupIndex) => {
      const matches = (orderedPathsByGroup[groupIndex] ?? []).filter((path) => path.toLowerCase().includes(query))
      groupButtons[groupIndex]?.classList.toggle('is-filtered-out', matches.length === 0)
      if (matches.length === 0) return
      matchCount += matches.length
      tree.appendChild(element('p', { class: 'tree-group' }, group.label))
      appendTreeFiles(tree, matches)
    })
    if (matchCount === 0) tree.appendChild(element('p', { class: 'tree-empty' }, `No changed file path contains “${filterText.trim()}”.`))
  }

  function appendTreeFiles(container: HTMLElement, paths: string[]): void {
    for (const [directory, directoryPaths] of groupByDirectory(paths)) {
      if (directory) container.appendChild(element('p', { class: 'tree-directory-end-visible', title: directory }, element('span', {}, `${directory}/`)))
      const list = element('ul', { class: 'tree-files' })
      for (const path of directoryPaths) {
        const file = filesByPath.get(path)
        if (!file) continue
        const name = element(
          'button',
          { type: 'button', class: 'tree-name', title: path },
          path.slice(directory ? directory.length + 1 : 0),
        )
        name.addEventListener('click', () => jumpToFile(path, { isExpanding: true }))
        list.appendChild(
          element(
            'li',
            {
              class: ['tree-file', reviewedPaths.has(path) && 'is-reviewed', focusedPath === path && 'is-focused'].filter(Boolean).join(' '),
              'data-path': path,
              'data-status': file.status,
            },
            element('label', { class: 'reviewed-box' }, reviewedCheckbox(file)),
            name,
            element('span', { class: `tree-status status-${file.status}`, title: statusLabels[file.status] }, statusLetter(file.status)),
          ),
        )
      }
      container.appendChild(list)
    }
  }

  function focusFile(path: string, options: { isScrolling?: boolean } = {}): void {
    focusedPath = path
    for (const [cardPath, card] of cardsByPath) card.classList.toggle('is-focused', cardPath === path)
    for (const treeItem of tree.querySelectorAll<HTMLElement>('.tree-file')) {
      const isFocused = treeItem.dataset.path === path
      treeItem.classList.toggle('is-focused', isFocused)
      if (isFocused) treeItem.scrollIntoView({ block: 'nearest' })
    }
    if (options.isScrolling !== false) cardsByPath.get(path)?.scrollIntoView({ block: 'start' })
  }

  function jumpToFile(path: string, options: { isExpanding?: boolean } = {}): void {
    const groupIndex = groupIndexByPath.get(path)
    if (groupIndex === undefined) return
    if (groupIndex !== activeGroupIndex) selectGroup(groupIndex, { isScrolling: false })
    if (options.isExpanding) {
      personalCollapseOverrides.set(path, false)
      applyCollapse(path)
    }
    focusFile(path)
  }

  function moveFocus(step: 1 | -1): void {
    if (allPathsInOrder.length === 0) return
    const currentIndex = focusedPath === null ? -1 : allPathsInOrder.indexOf(focusedPath)
    const nextIndex =
      currentIndex === -1 ? (step === 1 ? 0 : allPathsInOrder.length - 1) : Math.min(allPathsInOrder.length - 1, Math.max(0, currentIndex + step))
    const nextPath = allPathsInOrder[nextIndex]
    if (nextPath !== undefined) jumpToFile(nextPath)
  }

  function setLayout(nextLayout: DiffLayout): void {
    layout = nextLayout
    writeLayout(layout)
    unifiedButton.setAttribute('aria-pressed', String(layout === DiffLayout.Unified))
    splitButton.setAttribute('aria-pressed', String(layout === DiffLayout.Split))
    for (const mounted of mountedDiffs.values()) mounted.setLayout(layout)
  }

  unifiedButton.addEventListener('click', () => setLayout(DiffLayout.Unified))
  splitButton.addEventListener('click', () => setLayout(DiffLayout.Split))
  collapseToggle.addEventListener('change', () => {
    isCollapsingReviewed = collapseToggle.checked
    writeCollapseReviewed(isCollapsingReviewed)
    personalCollapseOverrides.clear()
    for (const path of cardsByPath.keys()) applyCollapse(path)
  })
  filterInput.addEventListener('input', () => {
    filterText = filterInput.value
    renderTree()
  })
  filterInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    filterInput.value = ''
    filterText = ''
    renderTree()
    filterInput.blur()
  })

  document.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const target = event.target as HTMLElement | null
    if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) {
      if (!(target instanceof HTMLInputElement && target.type === 'checkbox')) return
    }
    const handlers: Record<string, () => void> = {
      j: () => moveFocus(1),
      k: () => moveFocus(-1),
      ']': () => selectGroup(activeGroupIndex + 1),
      '[': () => selectGroup(activeGroupIndex - 1),
      x: () => {
        if (focusedPath !== null) setReviewed(focusedPath, !reviewedPaths.has(focusedPath))
      },
      s: () => setLayout(layout === DiffLayout.Unified ? DiffLayout.Split : DiffLayout.Unified),
      '/': () => filterInput.focus(),
    }
    const handler = handlers[event.key]
    if (!handler) return
    event.preventDefault()
    handler()
  })

  setLayout(layout)
  renderActiveGroup()
}

function withUngroupedFiles(payload: ReviewPayload): ReviewGroup[] {
  const groupedPaths = new Set(payload.analysis.groups.flatMap((group) => group.filePaths))
  const ungroupedPaths = payload.files.map((file) => file.path).filter((path) => !groupedPaths.has(path))
  if (ungroupedPaths.length === 0) return payload.analysis.groups
  return [
    ...payload.analysis.groups,
    { key: 'ungrouped', label: 'Ungrouped', category: ReviewCategory.Other, summary: '', filePaths: ungroupedPaths, fileNotes: [], lineNotes: [] },
  ]
}

function directoryOf(path: string): string {
  const slashIndex = path.lastIndexOf('/')
  return slashIndex === -1 ? '' : path.slice(0, slashIndex)
}

function groupByDirectory(paths: string[]): Map<string, string[]> {
  const pathsByDirectory = new Map<string, string[]>()
  for (const path of paths) {
    const directory = directoryOf(path)
    pathsByDirectory.set(directory, [...(pathsByDirectory.get(directory) ?? []), path])
  }
  return pathsByDirectory
}

function orderByDirectory(paths: string[]): string[] {
  return [...groupByDirectory(paths).values()].flat()
}

function isGroupCritical(group: ReviewGroup): boolean {
  return Boolean(group.critical) || group.fileNotes.some((note) => note.critical) || group.lineNotes.some((note) => note.critical)
}

function collectCriticalItems(group: ReviewGroup): CriticalItem[] {
  return [
    ...group.fileNotes.filter((note) => note.critical).map((note) => ({ path: note.path, text: note.text })),
    ...group.lineNotes
      .filter((note) => note.critical)
      .map((note) => ({ path: note.path, line: note.line, side: note.side, text: note.text })),
  ]
}

function diffPlaceholder(file: ReviewFile): string | null {
  if (file.isBinary) return 'Binary file; no text diff to show.'
  if (file.isPatchOmitted) return 'This diff was left out to keep the page under its size limit. Open the file in your editor to review it.'
  if (file.hunks.length === 0) {
    return file.status === ReviewFileStatus.Renamed || file.status === ReviewFileStatus.Copied ? 'Moved without content changes.' : 'No content changes (empty file or mode change only).'
  }
  return null
}

function renderPath(file: ReviewFile): HTMLElement {
  if (file.previousPath && file.previousPath !== file.path) {
    return element(
      'span',
      { class: 'file-path' },
      element('span', { class: 'previous-path' }, file.previousPath),
      element('span', { class: 'rename-arrow', 'aria-label': 'renamed to' }, ' → '),
      file.path,
    )
  }
  return element('span', { class: 'file-path' }, file.path)
}

function statusLetter(status: ReviewFile['status']): string {
  return { added: 'A', removed: 'D', modified: 'M', renamed: 'R', copied: 'C' }[status]
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function shortcut(previousKey: string, nextKey: string, noun: string): Child[] {
  return [element('kbd', {}, previousKey), element('kbd', {}, nextKey), ` ${noun} `]
}

function targetMeta(target: ReviewTarget, title: string): Child[] {
  const label = target.label !== title && element('span', { class: 'meta-item target' }, target.label)
  switch (target.kind) {
    case ReviewTargetKind.PullRequest: {
      const href = httpUrlOrNull(target.url)
      return [
        href === null
          ? element('span', { class: 'meta-item target' }, `#${target.number}`)
          : element('a', { class: 'meta-item target', href, target: '_blank', rel: 'noopener noreferrer' }, `#${target.number}`),
        element('span', { class: 'meta-item' }, `${target.baseRef} ← ${target.headRef}`),
        target.author && element('span', { class: 'meta-item' }, target.author),
        element('span', { class: `meta-item state state-${target.state.toLowerCase()}` }, target.state.toLowerCase()),
      ]
    }
    case ReviewTargetKind.Worktree:
    case ReviewTargetKind.Range:
      return [label]
    case ReviewTargetKind.Commit:
      return [label, element('code', { class: 'meta-item' }, target.sha.slice(0, 10))]
  }
}

function renderOverview(payload: ReviewPayload): HTMLElement {
  const generatedAt = new Date(payload.generatedAt)
  const overview = element(
    'section',
    { class: 'overview' },
    payload.analysisError &&
      element(
        'p',
        { class: 'analysis-error' },
        'The analyzer’s answer could not be used, so the files are grouped without notes. ',
        element('span', { class: 'analysis-error-detail' }, payload.analysisError),
      ),
    payload.analysis.overallSummary && element('div', { class: 'markdown overall-summary' }, renderMarkdown(payload.analysis.overallSummary)),
  )
  const disclosures = element('div', { class: 'disclosures' })
  if (payload.commits.length > 0) {
    disclosures.appendChild(
      element(
        'details',
        { class: 'commits' },
        element('summary', {}, plural(payload.commits.length, 'commit')),
        element(
          'ol',
          {},
          ...payload.commits.map((commit) =>
            element(
              'li',
              {},
              element('code', { class: 'sha' }, commit.sha.slice(0, 7)),
              element('span', { class: 'commit-subject' }, commit.subject),
              element('span', { class: 'commit-author' }, commit.author),
            ),
          ),
        ),
      ),
    )
  }
  if (payload.description?.trim()) {
    disclosures.appendChild(
      element(
        'details',
        { class: 'description' },
        element('summary', {}, 'Description'),
        element('div', { class: 'markdown' }, renderMarkdown(payload.description)),
      ),
    )
  }
  if (disclosures.childElementCount > 0) overview.appendChild(disclosures)
  overview.appendChild(
    element(
      'p',
      { class: 'provenance' },
      `Written ${Number.isNaN(generatedAt.getTime()) ? payload.generatedAt : generatedAt.toLocaleString()}`,
      payload.analysisModel ? `, analyzed by ${payload.analysisModel}` : '',
      '. The notes point at what to look at; the review is yours.',
    ),
  )
  return overview
}
