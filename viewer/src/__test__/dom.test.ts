import { describe, expect, test } from 'bun:test'
import { append, clear, element, httpUrlOrNull } from '../dom.ts'

describe('httpUrlOrNull', () => {
  test('accepts http and https URLs and returns them normalized', () => {
    expect(httpUrlOrNull('https://example.com')).toBe('https://example.com/')
    expect(httpUrlOrNull('http://example.com/a b?q=1#frag')).toBe('http://example.com/a%20b?q=1#frag')
  })

  test.each(['javascript:alert(1)', 'data:text/html,<b>hi</b>', 'file:///etc/passwd', 'ftp://example.com', 'mailto:a@example.com', 'vbscript:x'])(
    'refuses %s',
    (text) => {
      expect(httpUrlOrNull(text)).toBeNull()
    },
  )

  test.each(['/relative', 'relative/path', '//example.com/x', '', 'http://', 'not a url'])('refuses %p, which is not an absolute URL', (text) => {
    expect(httpUrlOrNull(text)).toBeNull()
  })

  test('refuses a scheme hidden by case or leading whitespace tricks', () => {
    expect(httpUrlOrNull('JaVaScRiPt:alert(1)')).toBeNull()
    expect(httpUrlOrNull('  javascript:alert(1)')).toBeNull()
  })
})

describe('element', () => {
  test('creates the tag with string attributes and mixed children', () => {
    const child = element('em', {}, 'inner')
    const created = element('a', { href: 'https://example.com', 'data-count': 3 }, 'text ', child)

    expect(created.tagName).toBe('A')
    expect(created.getAttribute('href')).toBe('https://example.com')
    expect(created.getAttribute('data-count')).toBe('3')
    expect(created.textContent).toBe('text inner')
  })

  test('sets a true attribute as present and skips false, null and undefined attributes', () => {
    const created = element('input', { disabled: true, hidden: false, title: null, name: undefined })

    expect(created.hasAttribute('disabled')).toBe(true)
    expect(created.hasAttribute('hidden')).toBe(false)
    expect(created.hasAttribute('title')).toBe(false)
    expect(created.hasAttribute('name')).toBe(false)
  })

  test('skips false, null and undefined children', () => {
    const created = element('p', {}, 'a', false, null, undefined, 'b')

    expect(created.childNodes.length).toBe(2)
    expect(created.textContent).toBe('ab')
  })

  test('treats string children as text, never as markup', () => {
    const created = element('p', {}, '<b>bold</b>')

    expect(created.querySelector('b')).toBeNull()
    expect(created.textContent).toBe('<b>bold</b>')
  })
})

describe('append and clear', () => {
  test('append adds children after the existing ones and skips empty values', () => {
    const parent = element('div', {}, 'start')

    append(parent, [' middle', false, element('b', {}, ' end'), null])

    expect(parent.textContent).toBe('start middle end')
    expect(parent.childNodes.length).toBe(3)
  })

  test('clear removes every child', () => {
    const parent = element('div', {}, 'a', element('b'), 'c')

    clear(parent)

    expect(parent.childNodes.length).toBe(0)
  })
})
