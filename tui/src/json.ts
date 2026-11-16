export type JsonRecord = Record<string, unknown>

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function memberOf<Member>(members: readonly Member[], value: unknown): Member | undefined {
  return members.find(member => member === value)
}

export function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

export function errorCodeOf(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('code' in error)) return undefined

  return typeof error.code === 'string' ? error.code : undefined
}
