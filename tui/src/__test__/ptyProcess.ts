import { PseudoTerminal } from './pseudoTerminal.ts'

export const COLUMNS = 140
export const ROWS = 40

const POLL_MILLISECONDS = 10

export class PtyProcess {
  readonly screen = new PseudoTerminal()
  readonly process: ReturnType<typeof Bun.spawn>
  private output = ''
  private readonly decoder = new TextDecoder('utf-8')

  constructor(command: string[], environment: Record<string, string> = {}) {
    this.process = Bun.spawn(command, {
      terminal: {
        cols: COLUMNS,
        rows: ROWS,
        data: (_terminal, data) => {
          const chunk = this.decoder.decode(data, { stream: true })
          this.output += chunk
          this.screen.feed(chunk)
        },
      },
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', NO_COLOR: '', ...environment },
    })
  }

  get received(): string {
    return this.output
  }

  clearReceived(): void {
    this.output = ''
  }

  async waitUntil(condition: () => boolean, timeoutMilliseconds: number): Promise<boolean> {
    const deadline = performance.now() + timeoutMilliseconds

    while (performance.now() < deadline) {
      if (condition()) return true

      await Bun.sleep(POLL_MILLISECONDS)
    }

    return condition()
  }

  waitForOutput(needle: string, timeoutMilliseconds: number): Promise<boolean> {
    return this.waitUntil(() => this.output.includes(needle), timeoutMilliseconds)
  }

  waitForScreenText(needle: string, timeoutMilliseconds: number): Promise<boolean> {
    return this.waitUntil(() => this.screen.locate(needle, ROWS) !== undefined, timeoutMilliseconds)
  }

  send(text: string): void {
    this.process.terminal!.write(text)
  }

  async exitCode(timeoutMilliseconds: number): Promise<number | undefined> {
    return Promise.race([this.process.exited, Bun.sleep(timeoutMilliseconds).then(() => undefined)])
  }

  dispose(): void {
    this.process.kill('SIGKILL')
    this.process.terminal?.close()
  }
}
