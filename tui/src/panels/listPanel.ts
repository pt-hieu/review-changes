export type ListState = { cursor: number; scroll: number }

export function clampList(list: ListState, count: number, height: number): void {
  list.cursor = count === 0 ? 0 : Math.max(0, Math.min(count - 1, list.cursor))

  if (list.cursor < list.scroll) list.scroll = list.cursor
  if (list.cursor >= list.scroll + height) list.scroll = list.cursor - height + 1

  list.scroll = Math.max(0, Math.min(list.scroll, Math.max(0, count - height)))
}

export function compactCount(value: number): string {
  if (value < 10_000) return String(value)
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`

  return `${(value / 1_000_000).toFixed(1)}m`
}
