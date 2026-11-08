import { ReviewCategory } from '../review/types.ts'
import type { IndexedGroup } from '../contract.ts'
import type { FileTable } from '../patch/fileTable.ts'
import { FileFlag } from '../types.ts'
import { FileClass } from './types.ts'

const MAXIMUM_FILES_PER_GROUP = 200
const MINIMUM_FILES_PER_GROUP = 3
const MAXIMUM_SEED_COUNT = 40
const ROOT_LABEL = '(root)'

const TEST_PATH = /(^|\/)(__tests?__|tests?|specs?)\/|\.(test|spec)\.[^/]+$/i
const DOCUMENTATION_PATH = /(^|\/)docs?\/|\.(md|mdx|markdown|rst|txt)$/i

const CLASS_ORDER = [FileClass.Tests, FileClass.Docs, FileClass.Assets, FileClass.Generated]

const CATEGORY_OF_CLASS: Record<FileClass, ReviewCategory> = {
  [FileClass.Code]: ReviewCategory.Other,
  [FileClass.Tests]: ReviewCategory.Tests,
  [FileClass.Docs]: ReviewCategory.Docs,
  [FileClass.Assets]: ReviewCategory.Assets,
  [FileClass.Generated]: ReviewCategory.Build,
}

type Entry = { fileIndex: number; directory: string[]; changedLines: number }

type Bucket = { label: string; entries: Entry[]; changedLines: number }

function classOf(table: FileTable, fileIndex: number, path: string): FileClass {
  if ((table.flags[fileIndex]! & FileFlag.Generated) !== 0) return FileClass.Generated
  if ((table.flags[fileIndex]! & FileFlag.Binary) !== 0) return FileClass.Assets
  if (TEST_PATH.test(path)) return FileClass.Tests
  if (DOCUMENTATION_PATH.test(path)) return FileClass.Docs

  return FileClass.Code
}

function bucketOf(label: string, entries: Entry[]): Bucket {
  return { label, entries, changedLines: entries.reduce((total, entry) => total + entry.changedLines, 0) }
}

function parentOf(label: string): string {
  const slash = label.lastIndexOf('/')

  return slash === -1 ? '' : label.slice(0, slash)
}

function splitByDepth(entries: Entry[], depth: number): Bucket[] {
  const byDirectory = new Map<string, Entry[]>()

  for (const entry of entries) {
    const label = entry.directory.slice(0, depth).join('/') || ROOT_LABEL
    const bucket = byDirectory.get(label)

    if (bucket === undefined) byDirectory.set(label, [entry])
    else bucket.push(entry)
  }

  const buckets: Bucket[] = []

  for (const [label, members] of byDirectory) {
    const isDeeper = members.some(member => member.directory.length > depth)

    if (members.length > MAXIMUM_FILES_PER_GROUP && isDeeper) buckets.push(...splitByDepth(members, depth + 1))
    else buckets.push(bucketOf(label, members))
  }

  return buckets
}

function mergedLabel(entries: Entry[]): string {
  let first = ''
  let last = ''
  let isFirstEntry = true

  for (const entry of entries) {
    const directory = entry.directory.join('/') || ROOT_LABEL

    if (isFirstEntry || directory < first) first = directory
    if (isFirstEntry || directory > last) last = directory

    isFirstEntry = false
  }

  return first === last ? first : `${first} … ${last}`
}

function mergeBuckets(buckets: Bucket[]): Bucket {
  const entries = buckets.flatMap(bucket => bucket.entries)

  return bucketOf(mergedLabel(entries), entries)
}

function mergeSmallSiblings(buckets: Bucket[]): Bucket[] {
  const smallByParent = new Map<string, Bucket[]>()
  const kept: Bucket[] = []

  for (const bucket of buckets) {
    if (bucket.entries.length >= MINIMUM_FILES_PER_GROUP) {
      kept.push(bucket)
      continue
    }

    const parent = parentOf(bucket.label)
    const siblings = smallByParent.get(parent)

    if (siblings === undefined) smallByParent.set(parent, [bucket])
    else siblings.push(bucket)
  }

  for (const siblings of smallByParent.values()) {
    kept.push(siblings.length > 1 ? mergeBuckets(siblings) : siblings[0]!)
  }

  return kept
}

function mergeSmallestUntilWithinLimit(buckets: Bucket[], limit: number): Bucket[] {
  const remaining = [...buckets].sort((left, right) => left.entries.length - right.entries.length)

  while (remaining.length > limit && remaining.length > 1) {
    const smallest = remaining.shift()!
    const second = remaining.shift()!
    const mergedEntries = [...smallest.entries, ...second.entries]
    const merged = bucketOf(mergedLabel(mergedEntries), mergedEntries)
    const insertAt = remaining.findIndex(bucket => bucket.entries.length >= merged.entries.length)

    remaining.splice(insertAt === -1 ? remaining.length : insertAt, 0, merged)
  }

  return remaining
}

function groupOf(position: number, bucket: Bucket, category: ReviewCategory, table: FileTable): IndexedGroup {
  const additions = bucket.entries.reduce((total, entry) => total + table.additions[entry.fileIndex]!, 0)
  const deletions = bucket.entries.reduce((total, entry) => total + table.deletions[entry.fileIndex]!, 0)
  const fileLabel = bucket.entries.length === 1 ? 'file' : 'files'

  return {
    key: `seed-${position}`,
    label: bucket.label,
    category,
    summary: `${bucket.entries.length} ${fileLabel}, +${additions}/-${deletions}`,
    fileIndexes: bucket.entries.map(entry => entry.fileIndex),
    fileNotes: [],
    lineNotes: [],
  }
}

export function seedGroups(table: FileTable): IndexedGroup[] {
  const entriesByClass = new Map<FileClass, Entry[]>()
  const order = table.sortedOrder()

  for (let position = 0; position < order.length; position++) {
    const fileIndex = order[position]!
    const path = table.pathOf(fileIndex)
    const segments = path.split('/')
    const fileClass = classOf(table, fileIndex, path)
    const entry: Entry = {
      fileIndex,
      directory: segments.slice(0, -1),
      changedLines: table.additions[fileIndex]! + table.deletions[fileIndex]!,
    }
    const entries = entriesByClass.get(fileClass)

    if (entries === undefined) entriesByClass.set(fileClass, [entry])
    else entries.push(entry)
  }

  const otherGroupCount = CLASS_ORDER.filter(fileClass => entriesByClass.has(fileClass)).length
  const codeEntries = entriesByClass.get(FileClass.Code) ?? []
  const codeBuckets = mergeSmallestUntilWithinLimit(
    mergeSmallSiblings(splitByDepth(codeEntries, 1)),
    Math.max(1, MAXIMUM_SEED_COUNT - otherGroupCount),
  ).sort((left, right) => right.changedLines - left.changedLines)

  const groups: IndexedGroup[] = []

  for (const bucket of codeBuckets) groups.push(groupOf(groups.length + 1, bucket, CATEGORY_OF_CLASS[FileClass.Code], table))

  for (const fileClass of CLASS_ORDER) {
    const entries = entriesByClass.get(fileClass)

    if (entries !== undefined) groups.push(groupOf(groups.length + 1, bucketOf(fileClass, entries), CATEGORY_OF_CLASS[fileClass], table))
  }

  return groups
}
