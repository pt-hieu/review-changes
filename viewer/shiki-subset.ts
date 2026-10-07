import { createBundledHighlighter, createSingletonShorthands, guessEmbeddedLanguages } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

export * from 'shiki/core'
export { createJavaScriptRegexEngine }

export const createOnigurumaEngine = (): never => {
  throw new Error('review-changes ships only the JavaScript regex engine; use preferredHighlighter "shiki-js"')
}

type LanguageModule = Promise<{ default: unknown }>

const shellscript = (): LanguageModule => import('@shikijs/langs/shellscript')
const yaml = (): LanguageModule => import('@shikijs/langs/yaml')
const docker = (): LanguageModule => import('@shikijs/langs/docker')

export const bundledLanguages = {
  typescript: () => import('@shikijs/langs/typescript'),
  tsx: () => import('@shikijs/langs/tsx'),
  javascript: () => import('@shikijs/langs/javascript'),
  jsx: () => import('@shikijs/langs/jsx'),
  json: () => import('@shikijs/langs/json'),
  jsonc: () => import('@shikijs/langs/jsonc'),
  css: () => import('@shikijs/langs/css'),
  scss: () => import('@shikijs/langs/scss'),
  html: () => import('@shikijs/langs/html'),
  markdown: () => import('@shikijs/langs/markdown'),
  yaml,
  yml: yaml,
  shellscript,
  zsh: shellscript,
  bash: shellscript,
  sh: shellscript,
  python: () => import('@shikijs/langs/python'),
  go: () => import('@shikijs/langs/go'),
  rust: () => import('@shikijs/langs/rust'),
  sql: () => import('@shikijs/langs/sql'),
  toml: () => import('@shikijs/langs/toml'),
  diff: () => import('@shikijs/langs/diff'),
  docker,
  dockerfile: docker,
  ini: () => import('@shikijs/langs/ini'),
  xml: () => import('@shikijs/langs/xml'),
  java: () => import('@shikijs/langs/java'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  graphql: () => import('@shikijs/langs/graphql'),
} as Record<string, () => LanguageModule>

export const bundledThemes: Record<string, () => LanguageModule> = {}

export const createHighlighter = createBundledHighlighter<string, string>({
  langs: bundledLanguages as never,
  themes: bundledThemes as never,
  engine: () => createJavaScriptRegexEngine(),
})

export const { codeToHtml, codeToHast, codeToTokens, codeToTokensBase, codeToTokensWithThemes, getSingletonHighlighter, getLastGrammarState } =
  createSingletonShorthands(createHighlighter, { guessEmbeddedLanguages })
