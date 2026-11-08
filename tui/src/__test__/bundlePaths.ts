import { dirname, join } from 'node:path'

const REPOSITORY_ROOT = join(import.meta.dir, '../../..')
const PLUGIN_NAME = 'review-changes'

export const PLUGIN_DIRECTORY = join(REPOSITORY_ROOT, 'plugins', PLUGIN_NAME)
export const BUNDLE_PATH = join(PLUGIN_DIRECTORY, 'assets', `${PLUGIN_NAME}.js`)
export const BUNDLE_DIRECTORY = dirname(BUNDLE_PATH)
