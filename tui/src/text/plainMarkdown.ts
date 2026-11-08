export function plainMarkdown(markdown: string): string {
  return markdown
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1 ($2)')
}
