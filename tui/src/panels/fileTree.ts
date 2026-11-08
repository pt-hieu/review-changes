import type { FileTable } from '../patch/fileTable.ts'

export type FileList = {
  count: number
  fileAt(position: number): number
  depthAt(position: number): number
  directoryNameAt(position: number): string | undefined
  directoryKeyAt(position: number): string | undefined
  directoryFileCountAt(position: number): number
  positionOfFile(fileIndex: number): number
}

type DirectoryNode = { name: string; children: DirectoryNode[]; fileIndex: number; fileCount: number }

function flatList(files: Int32Array, length: number): FileList {
  return {
    count: length,
    fileAt: position => files[position]!,
    depthAt: () => 0,
    directoryNameAt: () => undefined,
    directoryKeyAt: () => undefined,
    directoryFileCountAt: () => 0,
    positionOfFile: fileIndex => {
      for (let position = 0; position < length; position++) if (files[position] === fileIndex) return position

      return -1
    },
  }
}

function directoryNode(name: string): DirectoryNode {
  return { name, children: [], fileIndex: -1, fileCount: 0 }
}

export function buildFileList(table: FileTable, files: Int32Array, length: number, collapsed: ReadonlySet<string>, isFlat: boolean): FileList {
  if (isFlat) return flatList(files, length)

  const root = directoryNode('')
  const stack: DirectoryNode[] = [root]
  let previousDirectories: string[] = []

  for (let position = 0; position < length; position++) {
    const fileIndex = files[position]!
    const segments = table.pathOf(fileIndex).split('/')
    const directories = segments.slice(0, -1)
    let common = 0

    while (common < directories.length && common < previousDirectories.length && directories[common] === previousDirectories[common]) common++

    stack.length = common + 1

    for (let depth = common; depth < directories.length; depth++) {
      const node = directoryNode(directories[depth]!)
      stack[depth]!.children.push(node)
      stack.push(node)
    }

    stack[stack.length - 1]!.children.push({ name: '', children: [], fileIndex, fileCount: 1 })

    for (const node of stack) node.fileCount++

    previousDirectories = directories
  }

  const fileIndexes: number[] = []
  const depths: number[] = []
  const names: (string | undefined)[] = []
  const keys: (string | undefined)[] = []
  const counts: number[] = []

  const visit = (start: DirectoryNode, depth: number, parentKey: string): void => {
    if (start.fileIndex >= 0) {
      fileIndexes.push(start.fileIndex)
      depths.push(depth)
      names.push(undefined)
      keys.push(undefined)
      counts.push(0)

      return
    }

    let node = start
    let name = node.name

    while (node.children.length === 1 && node.children[0]!.fileIndex < 0) {
      node = node.children[0]!
      name += `/${node.name}`
    }

    const key = parentKey === '' ? name : `${parentKey}/${name}`

    fileIndexes.push(-1)
    depths.push(depth)
    names.push(name)
    keys.push(key)
    counts.push(node.fileCount)

    if (collapsed.has(key)) return

    for (const child of node.children) visit(child, depth + 1, key)
  }

  for (const child of root.children) visit(child, 0, '')

  const positionByFile = new Map<number, number>()
  fileIndexes.forEach((fileIndex, position) => {
    if (fileIndex >= 0) positionByFile.set(fileIndex, position)
  })

  return {
    count: fileIndexes.length,
    fileAt: position => fileIndexes[position]!,
    depthAt: position => depths[position]!,
    directoryNameAt: position => names[position],
    directoryKeyAt: position => keys[position],
    directoryFileCountAt: position => counts[position]!,
    positionOfFile: fileIndex => positionByFile.get(fileIndex) ?? -1,
  }
}

export function allDirectoryKeys(table: FileTable, files: Int32Array, length: number): Set<string> {
  const list = buildFileList(table, files, length, new Set(), false)
  const keys = new Set<string>()

  for (let position = 0; position < list.count; position++) {
    const key = list.directoryKeyAt(position)
    if (key !== undefined) keys.add(key)
  }

  return keys
}
