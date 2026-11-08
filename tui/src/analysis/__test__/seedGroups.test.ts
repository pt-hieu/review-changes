import { afterAll, describe, expect, test } from 'bun:test'
import { ReviewCategory } from '../../review/types.ts'
import { binaryFileSection, fileSection } from '../../__test__/reviewDirectory.ts'
import { closeScannedPatches, scanText } from '../../__test__/scannedPatch.ts'
import { seedGroups } from '../seedGroups.ts'

afterAll(closeScannedPatches)

function groupsOf(...sections: string[]) {
  const { table } = scanText(sections.join(''))

  return { table, groups: seedGroups(table) }
}

function labelsAndPaths(sections: string[]) {
  const { table, groups } = groupsOf(...sections)

  return groups.map(group => [group.label, group.fileIndexes.map(fileIndex => table.pathOf(fileIndex))] as const)
}

describe('seedGroups', () => {
  test('an empty patch has no groups', () => {
    expect(groupsOf().groups).toEqual([])
  })

  test('puts code of one directory together, summarised with its counts', () => {
    const { groups } = groupsOf(fileSection('src/api/a.ts', 3, 1), fileSection('src/api/b.ts', 1, 0), fileSection('src/api/c.ts', 0, 2))

    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ label: 'src', category: ReviewCategory.Other, summary: '3 files, +4/-3', fileIndexes: [0, 1, 2] })
  })

  test('says "1 file" for a single file', () => {
    expect(groupsOf(fileSection('main.ts', 1, 0)).groups[0]?.summary).toBe('1 file, +1/-0')
  })

  test('splits tests, docs and binary assets away from code, after the code groups', () => {
    const paths = labelsAndPaths([
      binaryFileSection('src/logo.png'),
      fileSection('README.md', 1, 0),
      fileSection('src/a.spec.ts', 1, 0),
      fileSection('docs/guide.txt', 1, 0),
      fileSection('lib/core.ts', 1, 0),
      fileSection('lib/more/x.ts', 1, 0),
      fileSection('lib/more/y.ts', 1, 0),
    ])

    expect(paths.map(([label]) => label)).toEqual(['lib', 'tests', 'docs', 'assets'])
    expect(paths.find(([label]) => label === 'tests')![1]).toEqual(['src/a.spec.ts'])
    expect(paths.find(([label]) => label === 'docs')![1]).toEqual(['README.md', 'docs/guide.txt'])
    expect(paths.find(([label]) => label === 'assets')![1]).toEqual(['src/logo.png'])
  })

  test('gives each group a category and orders code groups by changed lines, biggest first', () => {
    const { groups } = groupsOf(
      fileSection('small/a.ts', 1, 0),
      fileSection('small/b.ts', 1, 0),
      fileSection('small/c.ts', 1, 0),
      fileSection('big/a.ts', 9, 9),
      fileSection('big/b.ts', 9, 9),
      fileSection('big/c.ts', 9, 9),
      fileSection('x.test.ts', 1, 0),
    )

    expect(groups.map(group => [group.label, group.category])).toEqual([
      ['big', ReviewCategory.Other],
      ['small', ReviewCategory.Other],
      ['tests', ReviewCategory.Tests],
    ])
  })

  test('merges directories with fewer than three files into one group labelled by its range', () => {
    const { groups } = groupsOf(fileSection('alpha/a.ts', 1, 0), fileSection('beta/b.ts', 1, 0))

    expect(groups.map(group => group.label)).toEqual(['alpha … beta'])
    expect(groups[0]?.fileIndexes).toHaveLength(2)
  })

  test('numbers group keys from seed-1 without gaps', () => {
    const { groups } = groupsOf(fileSection('a/1.ts', 1, 0), fileSection('a/2.ts', 1, 0), fileSection('a/3.ts', 1, 0), fileSection('t.test.ts', 1, 0))

    expect(groups.map(group => group.key)).toEqual(['seed-1', 'seed-2'])
  })

  test('splits a directory of more than 200 files by its subdirectories', () => {
    const sections = [
      ...Array.from({ length: 150 }, (_unused, index) => fileSection(`src/models/m${index}.ts`, 1, 0)),
      ...Array.from({ length: 120 }, (_unused, index) => fileSection(`src/views/v${index}.ts`, 1, 0)),
    ]

    const { groups } = groupsOf(...sections)

    expect(groups.map(group => [group.label, group.fileIndexes.length]).sort()).toEqual([
      ['src/models', 150],
      ['src/views', 120],
    ])
  })

  test('never makes more than 40 groups and puts every file in exactly one', () => {
    const sections = Array.from({ length: 60 }, (_unused, index) => [fileSection(`dir${index}/a.ts`, 1, 0), fileSection(`dir${index}/b.ts`, 1, 0), fileSection(`dir${index}/c.ts`, 1, 0)]).flat()

    const { groups } = groupsOf(...sections)
    const placed = groups.flatMap(group => group.fileIndexes).sort((left, right) => left - right)

    expect(groups.length).toBeLessThanOrEqual(40)
    expect(placed).toEqual(Array.from({ length: 180 }, (_unused, index) => index))
  })

  test('files in the repository root form a "(root)" group', () => {
    const { groups } = groupsOf(fileSection('a.ts', 1, 0), fileSection('b.ts', 1, 0), fileSection('c.ts', 1, 0))

    expect(groups.map(group => group.label)).toEqual(['(root)'])
  })
})
