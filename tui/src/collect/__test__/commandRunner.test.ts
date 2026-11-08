import { afterEach, describe, expect, test } from 'bun:test'
import { environmentFor } from '../commandRunner.ts'

const INJECTED_NAMES = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_KEY_7', 'GIT_EXTERNAL_DIFF', 'GIT_DIR', 'GIT_WORK_TREE']

describe('environmentFor', () => {
  afterEach(() => {
    for (const name of INJECTED_NAMES) delete process.env[name]
  })

  test('keeps git from reading configuration or helpers the surrounding environment injects', () => {
    for (const name of INJECTED_NAMES) process.env[name] = '/tmp/attacker'

    const environment = environmentFor(undefined)

    for (const name of INJECTED_NAMES) expect(environment[name]).toBeUndefined()
    expect(environment.GIT_CONFIG_COUNT).toBe('2')
    expect(environment.GIT_CONFIG_VALUE_0).toBe('/dev/null')
  })

  test('passes unrelated variables through', () => {
    process.env.REVIEW_CHANGES_SAMPLE = 'kept'

    expect(environmentFor(undefined).REVIEW_CHANGES_SAMPLE).toBe('kept')

    delete process.env.REVIEW_CHANGES_SAMPLE
  })
})
