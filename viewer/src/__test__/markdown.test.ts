import { describe, expect, test } from 'bun:test'
import { renderMarkdown } from '../markdown.ts'

function render(source: string): HTMLElement {
  const container = document.createElement('div')
  container.appendChild(renderMarkdown(source))
  return container
}

function topLevelTags(container: HTMLElement): string[] {
  return Array.from(container.children).map((child) => child.tagName)
}

describe('renderMarkdown security', () => {
  test('shows HTML in the input as text instead of creating elements', () => {
    const container = render('<script>alert(1)</script> <img src=x onerror=alert(1)>')

    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toBe('<script>alert(1)</script> <img src=x onerror=alert(1)>')
  })

  test('shows HTML inside emphasis, links and code as text', () => {
    const container = render('**<b onclick=x>** [<i>](https://example.com) `<u>`')

    expect(container.querySelector('b')).toBeNull()
    expect(container.querySelector('i')).toBeNull()
    expect(container.querySelector('u')).toBeNull()
    expect(container.querySelector('code')?.textContent).toBe('<u>')
  })

  test('links open in a new tab without giving the target access to the opener', () => {
    const anchor = render('[docs](https://example.com/docs)').querySelector('a')

    expect(anchor?.getAttribute('href')).toBe('https://example.com/docs')
    expect(anchor?.getAttribute('target')).toBe('_blank')
    expect(anchor?.getAttribute('rel')).toBe('noopener noreferrer')
  })

  test.each(['javascript:alert(1)', 'data:text/html,hi', 'vbscript:x', '/relative/path', '//evil.example/x'])(
    'leaves a link to %s as plain text',
    (target) => {
      const container = render(`[click](${target})`)

      expect(container.querySelector('a')).toBeNull()
      expect(container.textContent).toBe(`[click](${target})`)
    },
  )

  test('turns a bare http or https URL into a link and leaves trailing punctuation outside it', () => {
    const container = render('See https://example.com/a?b=1, or http://example.org.')
    const hrefs = Array.from(container.querySelectorAll('a')).map((anchor) => anchor.getAttribute('href'))

    expect(hrefs).toEqual(['https://example.com/a?b=1', 'http://example.org/'])
    expect(container.textContent).toBe('See https://example.com/a?b=1, or http://example.org.')
  })

  test('does not link a bare URL with another scheme', () => {
    expect(render('ftp://example.com/file').querySelector('a')).toBeNull()
  })
})

describe('renderMarkdown inline', () => {
  test('renders code spans verbatim without interpreting markdown inside', () => {
    const container = render('use `**not bold** [x](https://a.com)` here')

    expect(container.querySelector('code')?.textContent).toBe('**not bold** [x](https://a.com)')
    expect(container.querySelector('strong')).toBeNull()
    expect(container.querySelector('a')).toBeNull()
  })

  test('renders bold with stars or underscores', () => {
    const container = render('**one** and __two__')

    expect(Array.from(container.querySelectorAll('strong')).map((strong) => strong.textContent)).toEqual(['one', 'two'])
  })

  test('renders italics with stars or underscores', () => {
    const container = render('*one* and _two_')

    expect(Array.from(container.querySelectorAll('em')).map((emphasis) => emphasis.textContent)).toEqual(['one', 'two'])
  })

  test('does not italicize underscores inside a word', () => {
    const container = render('snake_case_name stays')

    expect(container.querySelector('em')).toBeNull()
    expect(container.textContent).toBe('snake_case_name stays')
  })

  test('nests emphasis inside a link label', () => {
    const anchor = render('[**bold** label](https://example.com)').querySelector('a')

    expect(anchor?.querySelector('strong')?.textContent).toBe('bold')
    expect(anchor?.textContent).toBe('bold label')
  })
})

describe('renderMarkdown blocks', () => {
  test('returns an empty fragment for empty input', () => {
    expect(render('').childNodes.length).toBe(0)
  })

  test('splits paragraphs on blank lines and breaks lines inside one', () => {
    const container = render('first line\nsecond line\n\nnext paragraph')

    expect(topLevelTags(container)).toEqual(['P', 'P'])
    expect(container.children[0]?.querySelectorAll('br').length).toBe(1)
    expect(container.children[0]?.textContent).toBe('first linesecond line')
    expect(container.children[1]?.textContent).toBe('next paragraph')
  })

  test('normalizes Windows and old Mac line endings', () => {
    expect(topLevelTags(render('one\r\n\r\ntwo\r\rthree'))).toEqual(['P', 'P', 'P'])
  })

  test('renders fenced code verbatim with its language and without interpreting markdown or HTML', () => {
    const container = render('```ts\nconst a = "<b>**x**</b>"\n  indented\n```\nafter')
    const code = container.querySelector('pre > code')

    expect(code?.textContent).toBe('const a = "<b>**x**</b>"\n  indented')
    expect(code?.getAttribute('data-language')).toBe('ts')
    expect(container.querySelector('b')).toBeNull()
    expect(container.querySelector('strong')).toBeNull()
    expect(container.querySelector('p')?.textContent).toBe('after')
  })

  test('removes the common indentation of fenced code', () => {
    const container = render('```\n    a\n      b\n```')

    expect(container.querySelector('code')?.textContent).toBe('a\n  b')
  })

  test('treats an unclosed fence as code up to the end of the input', () => {
    const container = render('```\nstill code\n- not a list')

    expect(topLevelTags(container)).toEqual(['PRE'])
    expect(container.querySelector('code')?.textContent).toBe('still code\n- not a list')
  })

  test('renders each heading level one level lower than written, capped at six', () => {
    const container = render('# one\n## two\n#### four\n###### six')

    expect(topLevelTags(container)).toEqual(['H3', 'H4', 'H6', 'H6'])
    expect(Array.from(container.children).map((heading) => heading.textContent)).toEqual(['one', 'two', 'four', 'six'])
  })

  test('renders inline markdown inside a heading', () => {
    expect(render('## the `code` heading').querySelector('h4 code')?.textContent).toBe('code')
  })

  test('renders a thematic break', () => {
    expect(topLevelTags(render('above\n\n---\n\nbelow'))).toEqual(['P', 'HR', 'P'])
  })

  test('renders a block quote containing other blocks', () => {
    const container = render('> quoted **text**\n> - item')
    const quote = container.querySelector('blockquote')

    expect(topLevelTags(container)).toEqual(['BLOCKQUOTE'])
    expect(quote?.querySelector('strong')?.textContent).toBe('text')
    expect(quote?.querySelector('ul > li')?.textContent).toBe('item')
  })
})

describe('renderMarkdown lists', () => {
  test('renders an unordered list for each bullet marker', () => {
    for (const marker of ['-', '*', '+']) {
      const items = Array.from(render(`${marker} one\n${marker} two`).querySelectorAll('ul > li'))

      expect(items.map((item) => item.textContent)).toEqual(['one', 'two'])
    }
  })

  test('renders an ordered list for numbered items', () => {
    const container = render('1. first\n2) second')

    expect(topLevelTags(container)).toEqual(['OL'])
    expect(Array.from(container.querySelectorAll('li')).map((item) => item.textContent)).toEqual(['first', 'second'])
  })

  test('renders markdown inside an item', () => {
    const item = render('- fix `parse()` in [docs](https://example.com)').querySelector('li')

    expect(item?.querySelector('code')?.textContent).toBe('parse()')
    expect(item?.querySelector('a')?.getAttribute('href')).toBe('https://example.com/')
  })

  test('nests an indented list inside its parent item', () => {
    const container = render('- parent\n  - child one\n  - child two\n- sibling')
    const parentItems = container.querySelectorAll(':scope > ul > li')

    expect(parentItems.length).toBe(2)
    expect(Array.from(parentItems[0]?.querySelectorAll('ul > li') ?? []).map((item) => item.textContent)).toEqual(['child one', 'child two'])
    expect(parentItems[1]?.textContent).toBe('sibling')
  })

  test('keeps blank lines between items inside one list', () => {
    const container = render('- one\n\n- two')

    expect(topLevelTags(container)).toEqual(['UL'])
    expect(container.querySelectorAll('li').length).toBe(2)
  })

  test('ends the list at a non-list line', () => {
    expect(topLevelTags(render('- one\n- two\n\nparagraph'))).toEqual(['UL', 'P'])
  })
})
