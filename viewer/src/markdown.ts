import { element, httpUrlOrNull, type Child } from './dom.ts'

const fencePattern = /^\s*(```+|~~~+)\s*([\w+-]*)\s*$/
const headingPattern = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const listItemPattern = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const quotePattern = /^\s{0,3}>\s?(.*)$/
const rulePattern = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/

const inlinePattern =
  /`([^`]+)`|\[([^\]]+)\]\(\s*([^()\s]+)\s*\)|\*\*(.+?)\*\*|__(.+?)__|(?<![\w*])\*(?![\s*])(.+?)(?<![\s*])\*(?![\w*])|(?<![\w_])_(?![\s_])(.+?)(?<![\s_])_(?![\w_])|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g

export function renderMarkdown(source: string): DocumentFragment {
  const fragment = document.createDocumentFragment()
  for (const block of renderBlocks(source.replace(/\r\n?/g, '\n').split('\n'))) fragment.appendChild(block)
  return fragment
}

function renderBlocks(lines: string[]): HTMLElement[] {
  const blocks: HTMLElement[] = []
  let paragraphLines: string[] = []

  const flushParagraph = () => {
    if (paragraphLines.length === 0) return

    const children = paragraphLines.flatMap((paragraphLine, lineIndex) => [lineIndex > 0 && element('br'), ...renderInline(paragraphLine)])
    blocks.push(element('p', {}, ...children))

    paragraphLines = []
  }

  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''

    const fence = fencePattern.exec(line)
    if (fence) {
      flushParagraph()

      const marker = fence[1] ?? '```'
      const codeLines: string[] = []
      index += 1
      while (index < lines.length && !(lines[index] ?? '').trim().startsWith(marker)) {
        codeLines.push(lines[index] ?? '')
        index += 1
      }
      index += 1

      const indentation = Math.min(...codeLines.filter((codeLine) => codeLine.trim()).map((codeLine) => /^\s*/.exec(codeLine)?.[0].length ?? 0))
      const dedented = Number.isFinite(indentation) ? codeLines.map((codeLine) => codeLine.slice(indentation)) : codeLines
      blocks.push(element('pre', {}, element('code', { 'data-language': fence[2] || null }, dedented.join('\n'))))
      continue
    }

    if (!line.trim()) {
      flushParagraph()
      index += 1
      continue
    }

    if (rulePattern.test(line)) {
      flushParagraph()
      blocks.push(element('hr'))
      index += 1
      continue
    }

    const heading = headingPattern.exec(line)
    if (heading) {
      flushParagraph()

      const level = Math.min(6, (heading[1] ?? '#').length + 2) as 3 | 4 | 5 | 6
      blocks.push(element(`h${level}`, { class: 'markdown-heading' }, ...renderInline(heading[2] ?? '')))
      index += 1
      continue
    }

    if (quotePattern.test(line)) {
      flushParagraph()

      const quoted: string[] = []
      while (index < lines.length && quotePattern.test(lines[index] ?? '')) {
        quoted.push(quotePattern.exec(lines[index] ?? '')?.[1] ?? '')
        index += 1
      }

      blocks.push(element('blockquote', {}, ...renderBlocks(quoted)))
      continue
    }

    const firstItem = listItemPattern.exec(line)
    if (firstItem) {
      flushParagraph()

      const isOrdered = /\d/.test(firstItem[2] ?? '')
      const baseIndentation = (firstItem[1] ?? '').length
      const items: string[][] = []

      while (index < lines.length) {
        const current = lines[index] ?? ''
        const item = listItemPattern.exec(current)
        if (item && (item[1] ?? '').length <= baseIndentation + 1) {
          items.push([item[3] ?? ''])
        } else if (current.trim() && /^\s+/.test(current) && items.length > 0) {
          items[items.length - 1]?.push(current.slice(Math.min(baseIndentation + 2, /^\s*/.exec(current)?.[0].length ?? 0)))
        } else if (!current.trim() && listItemPattern.test(lines[index + 1] ?? '')) {
          index += 1
          continue
        } else if (!current.trim() && /^\s+\S/.test(lines[index + 1] ?? '') && items.length > 0) {
          items[items.length - 1]?.push('')
        } else {
          break
        }

        index += 1
      }

      const listElement = element(isOrdered ? 'ol' : 'ul')
      for (const itemLines of items) {
        const itemBlocks = renderBlocks(itemLines)
        const onlyParagraph = itemBlocks.length === 1 && itemBlocks[0]?.tagName === 'P'
        listElement.appendChild(element('li', {}, ...(onlyParagraph ? Array.from(itemBlocks[0]?.childNodes ?? []) : itemBlocks)))
      }
      blocks.push(listElement)
      continue
    }

    paragraphLines.push(line.trim())
    index += 1
  }

  flushParagraph()
  return blocks
}

function renderInline(text: string): Child[] {
  const nodes: Child[] = []
  let cursor = 0
  for (const match of text.matchAll(inlinePattern)) {
    const start = match.index ?? 0
    if (start > cursor) nodes.push(text.slice(cursor, start))

    const [whole, code, linkText, linkTarget, boldStars, boldUnderscores, italicStars, italicUnderscores, bareUrl] = match
    if (code !== undefined) nodes.push(element('code', {}, code))
    else if (linkText !== undefined && linkTarget !== undefined) nodes.push(renderLink(linkTarget, renderInline(linkText), whole))
    else if (boldStars !== undefined || boldUnderscores !== undefined)
      nodes.push(element('strong', {}, ...renderInline(boldStars ?? boldUnderscores ?? '')))
    else if (italicStars !== undefined || italicUnderscores !== undefined)
      nodes.push(element('em', {}, ...renderInline(italicStars ?? italicUnderscores ?? '')))
    else if (bareUrl !== undefined) nodes.push(renderLink(bareUrl, [bareUrl], whole))
    else nodes.push(whole)

    cursor = start + whole.length
  }

  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

function renderLink(target: string, content: Child[], original: string): Child {
  const href = httpUrlOrNull(target)
  if (href === null) return original

  return element('a', { href, target: '_blank', rel: 'noopener noreferrer' }, ...content)
}
