export type WordDiff = { oldRanges: number[]; newRanges: number[] }

const MAXIMUM_LINE_LENGTH = 1000
const MAXIMUM_TOKEN_CELLS = 40_000
const TOKEN_PATTERN = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu

type Token = { start: number; end: number; text: string }

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff
}

function tokensOf(text: string, offset: number): Token[] {
  const tokens: Token[] = []

  for (const match of text.matchAll(TOKEN_PATTERN)) {
    tokens.push({ start: offset + match.index, end: offset + match.index + match[0].length, text: match[0] })
  }

  return tokens
}

function mergedRanges(tokens: Token[], isChanged: boolean[]): number[] {
  const ranges: number[] = []

  for (let index = 0; index < tokens.length; index++) {
    if (!isChanged[index]) continue

    const token = tokens[index]!
    const lastEnd = ranges[ranges.length - 1]

    if (lastEnd === token.start) ranges[ranges.length - 1] = token.end
    else ranges.push(token.start, token.end)
  }

  return ranges
}

export function wordDiff(oldText: string, newText: string): WordDiff | undefined {
  if (oldText.length > MAXIMUM_LINE_LENGTH || newText.length > MAXIMUM_LINE_LENGTH) return undefined
  if (oldText === newText) return { oldRanges: [], newRanges: [] }

  const shared = Math.min(oldText.length, newText.length)
  let prefix = 0

  while (prefix < shared && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) prefix++

  if (prefix > 0 && isHighSurrogate(oldText.charCodeAt(prefix - 1))) prefix--

  let suffix = 0

  while (
    suffix < shared - prefix &&
    oldText.charCodeAt(oldText.length - 1 - suffix) === newText.charCodeAt(newText.length - 1 - suffix)
  ) {
    suffix++
  }

  if (suffix > 0 && isLowSurrogate(oldText.charCodeAt(oldText.length - suffix))) suffix--

  const oldTokens = tokensOf(oldText.slice(prefix, oldText.length - suffix), prefix)
  const newTokens = tokensOf(newText.slice(prefix, newText.length - suffix), prefix)
  const isOldChanged = oldTokens.map(() => true)
  const isNewChanged = newTokens.map(() => true)

  if (oldTokens.length * newTokens.length <= MAXIMUM_TOKEN_CELLS) {
    const width = newTokens.length + 1
    const lengths = new Uint16Array((oldTokens.length + 1) * width)

    for (let row = oldTokens.length - 1; row >= 0; row--) {
      for (let column = newTokens.length - 1; column >= 0; column--) {
        lengths[row * width + column] =
          oldTokens[row]!.text === newTokens[column]!.text
            ? lengths[(row + 1) * width + column + 1]! + 1
            : Math.max(lengths[(row + 1) * width + column]!, lengths[row * width + column + 1]!)
      }
    }

    let row = 0
    let column = 0

    while (row < oldTokens.length && column < newTokens.length) {
      if (oldTokens[row]!.text === newTokens[column]!.text) {
        isOldChanged[row] = false
        isNewChanged[column] = false
        row++
        column++
      } else if (lengths[(row + 1) * width + column]! >= lengths[row * width + column + 1]!) row++
      else column++
    }
  }

  return { oldRanges: mergedRanges(oldTokens, isOldChanged), newRanges: mergedRanges(newTokens, isNewChanged) }
}
