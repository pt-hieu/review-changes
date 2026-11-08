import { StyleRole, SyntaxSlot } from '../types.ts'

const ESCAPE = String.fromCharCode(27)

function sequence(parameters: string): string {
  return `${ESCAPE}[${parameters}m`
}

export const STYLE_CONTROL_ON = sequence('2')
export const STYLE_CONTROL_OFF = sequence('22')
export const STYLE_WARNING_ON = sequence('1;33')
export const STYLE_WARNING_OFF = sequence('22;39')
export const STYLE_RESET = sequence('0')
export const STYLE_REVERSE = sequence('7')
export const STYLE_BOLD = sequence('1')
export const STYLE_DIM = sequence('2')

export function joinStyles(first: string, second: string): string {
  return `${first.slice(0, -1)};${second.slice(2)}`
}

export type Theme = {
  role: Record<StyleRole, string>
  syntax: Record<SyntaxSlot, string>
  isColorEnabled: boolean
}

export function createTheme(isColorEnabled: boolean): Theme {
  if (!isColorEnabled) {
    return {
      isColorEnabled,
      role: {
        [StyleRole.Accent]: sequence('1'),
        [StyleRole.Muted]: sequence('2'),
        [StyleRole.Addition]: sequence('1'),
        [StyleRole.Deletion]: sequence('2'),
        [StyleRole.Critical]: sequence('1;4'),
        [StyleRole.Reviewed]: sequence('2'),
        [StyleRole.Selected]: sequence('7'),
        [StyleRole.Title]: sequence('1'),
        [StyleRole.Emphasis]: sequence('7'),
        [StyleRole.Hunk]: sequence('2'),
        [StyleRole.Note]: sequence('1'),
      },
      syntax: {
        [SyntaxSlot.Plain]: sequence('0'),
        [SyntaxSlot.Comment]: sequence('2'),
        [SyntaxSlot.String]: sequence('0'),
        [SyntaxSlot.Constant]: sequence('0'),
        [SyntaxSlot.Keyword]: sequence('1'),
        [SyntaxSlot.Function]: sequence('0'),
        [SyntaxSlot.Type]: sequence('0'),
        [SyntaxSlot.Parameter]: sequence('0'),
      },
    }
  }

  return {
    isColorEnabled,
    role: {
      [StyleRole.Accent]: sequence('1;36'),
      [StyleRole.Muted]: sequence('2'),
      [StyleRole.Addition]: sequence('32'),
      [StyleRole.Deletion]: sequence('31'),
      [StyleRole.Critical]: sequence('1;33'),
      [StyleRole.Reviewed]: sequence('32'),
      [StyleRole.Selected]: sequence('7'),
      [StyleRole.Title]: sequence('1'),
      [StyleRole.Emphasis]: sequence('7'),
      [StyleRole.Hunk]: sequence('36'),
      [StyleRole.Note]: sequence('35'),
    },
    syntax: {
      [SyntaxSlot.Plain]: sequence('39'),
      [SyntaxSlot.Comment]: sequence('2'),
      [SyntaxSlot.String]: sequence('32'),
      [SyntaxSlot.Constant]: sequence('33'),
      [SyntaxSlot.Keyword]: sequence('35'),
      [SyntaxSlot.Function]: sequence('34'),
      [SyntaxSlot.Type]: sequence('36'),
      [SyntaxSlot.Parameter]: sequence('39'),
    },
  }
}
