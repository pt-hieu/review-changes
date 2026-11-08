export function wrapWords(text: string, width: number): string[] {
  const lines: string[] = []

  for (const paragraph of text.replace(/\r\n/g, '\n').split('\n')) {
    let current = ''

    for (const word of paragraph.split(' ')) {
      const candidate = current === '' ? word : `${current} ${word}`

      if (candidate.length <= width || current === '') {
        current = candidate
        continue
      }

      lines.push(current)
      current = word
    }

    lines.push(current)
  }

  return lines
}
