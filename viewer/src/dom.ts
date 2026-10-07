export type Child = Node | string | null | undefined | false

type Attributes = Record<string, string | number | boolean | null | undefined>

export function element<Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  attributes: Attributes = {},
  ...children: Child[]
): HTMLElementTagNameMap[Tag] {
  const created = document.createElement(tag)

  for (const [name, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue

    created.setAttribute(name, value === true ? '' : String(value))
  }

  append(created, children)
  return created
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue

    parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
  }
}

export function clear(parent: Element): void {
  parent.replaceChildren()
}

export function httpUrlOrNull(text: string): string | null {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }

  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
}
