import { describe, expect, test } from 'claude-code/testing'

import { parseHookEnvironment } from '../rex.ts'

describe('parseHookEnvironment', () => {
  test('locates Rex from its block, session and binary directory', () => {
    expect(parseHookEnvironment({ block: 'block-1', session: 'session-1', binaryDirectory: '/rex/bin', home: '/home/ada' })).toEqual({
      rex: { block: 'block-1', session: 'session-1', binary: '/rex/bin/rex' },
      home: '/home/ada',
    })
  })

  test('falls back to rex on the path when no binary directory is set', () => {
    expect(parseHookEnvironment({ block: 'block-1', session: 'session-1' }).rex).toEqual({ block: 'block-1', session: 'session-1', binary: 'rex' })
  })

  test('is outside Rex when the block or session is missing or empty', () => {
    expect(parseHookEnvironment({ session: 'session-1' }).rex).toBeNull()
    expect(parseHookEnvironment({ block: 'block-1', session: '' }).rex).toBeNull()
  })

  test('treats an empty HOME as no home', () => {
    expect(parseHookEnvironment({ home: '' }).home).toBeUndefined()
  })
})
