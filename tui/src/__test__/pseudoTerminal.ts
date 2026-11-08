const ESCAPE = String.fromCharCode(27)
const CONTROL_PATTERN = new RegExp(`${ESCAPE}\\[(\\?)?([0-9;]*)([A-Za-z])`, 'g')

export const FRAME_END = `${ESCAPE}[?2026l`
export const ALTERNATE_SCREEN_ENTER = `${ESCAPE}[?1049h`
export const ALTERNATE_SCREEN_LEAVE = `${ESCAPE}[?1049l`

export type Cell = { character: string; style: string }

export class PseudoTerminal {
  private readonly cells = new Map<string, Cell>()
  private row = 0
  private column = 0
  private style = ''

  feed(output: string): void {
    let position = 0

    for (const match of output.matchAll(CONTROL_PATTERN)) {
      this.write(output.slice(position, match.index))
      position = match.index + match[0].length
      this.apply(match[1] === '?', match[2] ?? '', match[3] ?? '')
    }

    this.write(output.slice(position))
  }

  textOfRow(row: number): string {
    let text = ''

    for (let column = 0; column < 400; column++) text += this.cells.get(`${row},${column}`)?.character ?? ' '

    return text.trimEnd()
  }

  screenText(rowCount: number): string {
    return Array.from({ length: rowCount }, (_unused, row) => this.textOfRow(row)).join('\n')
  }

  locate(needle: string, rowCount: number): { row: number; column: number } | undefined {
    for (let row = 0; row < rowCount; row++) {
      const column = this.textOfRow(row).indexOf(needle)

      if (column >= 0) return { row, column }
    }

    return undefined
  }

  styleAt(row: number, column: number): string {
    return this.cells.get(`${row},${column}`)?.style ?? ''
  }

  private write(text: string): void {
    for (const character of text) {
      if (character === ESCAPE) continue

      this.cells.set(`${this.row},${this.column}`, { character, style: this.style })
      this.column++
    }
  }

  private apply(isPrivate: boolean, parameters: string, final: string): void {
    if (isPrivate) return

    if (final === 'H') {
      const [row, column] = parameters.split(';').map(Number)
      this.row = (row ?? 1) - 1
      this.column = (column ?? 1) - 1
    } else if (final === 'J') {
      this.cells.clear()
    } else if (final === 'm') {
      this.style = parameters === '0' || parameters === '' ? '' : `${this.style};${parameters}`
    }
  }
}
