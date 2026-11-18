import fs from 'fs-extra'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installHook, WRAPPER_ENV_DEFAULTS } from '../init'

let dir: string
let settingsPath: string

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'osm-wrapper-env-'))
  settingsPath = join(dir, 'settings.json')
})

afterEach(async () => {
  await fs.remove(dir)
})

describe('installHook wrapper env defaults', () => {
  it('writes the headless defaults into a fresh settings.json', async () => {
    expect(await installHook(settingsPath)).toBe('permission')
    const settings = await fs.readJSON(settingsPath)
    expect(settings.env).toEqual(WRAPPER_ENV_DEFAULTS)
    expect(settings.permissions.allow).toContain('Bash(*codeagent-wrapper*)')
  })

  it('keeps values the user already set and other env entries', async () => {
    await fs.writeJSON(settingsPath, { env: { CODEAGENT_LITE_MODE: 'false', OTHER: '1' } })
    await installHook(settingsPath)
    const settings = await fs.readJSON(settingsPath)
    expect(settings.env).toEqual({
      CODEAGENT_LITE_MODE: 'false',
      CODEAGENT_MAX_PARALLEL_WORKERS: '3',
      OTHER: '1',
    })
  })
})
