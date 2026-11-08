const LANGUAGE_BY_EXTENSION = new Map<string, string>([
  ['ts', 'typescript'],
  ['mts', 'typescript'],
  ['cts', 'typescript'],
  ['tsx', 'tsx'],
  ['js', 'javascript'],
  ['mjs', 'javascript'],
  ['cjs', 'javascript'],
  ['jsx', 'jsx'],
  ['json', 'json'],
  ['jsonc', 'jsonc'],
  ['css', 'css'],
  ['scss', 'scss'],
  ['html', 'html'],
  ['htm', 'html'],
  ['md', 'markdown'],
  ['markdown', 'markdown'],
  ['yaml', 'yaml'],
  ['yml', 'yaml'],
  ['sh', 'shellscript'],
  ['bash', 'shellscript'],
  ['zsh', 'shellscript'],
  ['py', 'python'],
  ['go', 'go'],
  ['rs', 'rust'],
  ['sql', 'sql'],
  ['toml', 'toml'],
  ['ini', 'ini'],
  ['cfg', 'ini'],
  ['xml', 'xml'],
  ['java', 'java'],
  ['kt', 'kotlin'],
  ['kts', 'kotlin'],
  ['graphql', 'graphql'],
  ['gql', 'graphql'],
])

export function languageForPath(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1)

  if (name === 'Dockerfile' || name.startsWith('Dockerfile.')) return 'docker'

  const dot = name.lastIndexOf('.')

  return dot === -1 ? undefined : LANGUAGE_BY_EXTENSION.get(name.slice(dot + 1).toLowerCase())
}
