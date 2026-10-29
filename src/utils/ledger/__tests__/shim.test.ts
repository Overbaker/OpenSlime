import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'pathe'
import { describe, expect, it } from 'vitest'
import { removeShim, shimContent, shimTarget, writeShim } from '../shim'
import { tmp } from './fixtures'

const posix = process.platform !== 'win32'

describe.runIf(posix)('P15: shim quoting', () => {
  const names = ['plain', 'with space', "it's", 'dollar $HOME', 'back`tick`', 'ünï 字', 'semi;colon & amp']

  it('runs the intended entry with exact argv and OSM_INSTALL_DIR for awkward paths', async () => {
    for (const name of names) {
      const base = join(tmp(), name)
      const install = join(base, '.claude')
      mkdirSync(join(base, 'pkg', 'bin'), { recursive: true })
      const entry = join(base, 'pkg', 'bin', 'ccg.mjs')
      writeFileSync(entry, 'console.log(JSON.stringify({ argv: process.argv.slice(2), dir: process.env.OSM_INSTALL_DIR }))\n')
      const shim = await writeShim(install, entry)
      expect(statSync(shim).mode & 0o111).not.toBe(0)
      const args = ['ledger', 'status', 'a b', '$X', "q'uote", '--json']
      const out = JSON.parse(execFileSync(shim, args, { encoding: 'utf8' }))
      expect(out).toEqual({ argv: args, dir: install })
      expect(await shimTarget(install)).toBe(entry)
    }
  })

  it('every awkward name round-trips through shimTarget', async () => {
    for (const name of names) {
      const install = join(tmp(), '.claude')
      const entry = `/opt/${name}/bin/ccg.mjs`
      await writeShim(install, entry)
      expect(await shimTarget(install)).toBe(entry)
    }
  })
})

describe('shim lifecycle', () => {
  it('writes a cmd launcher on Windows with % doubled', () => {
    const text = shimContent('C:\\node\\node.exe', 'C:\\100%\\bin\\ccg.mjs', 'C:\\Users\\a\\.claude', 'win32')
    expect(text).toBe('@echo off\r\nsetlocal\r\nset "OSM_INSTALL_DIR=C:\\Users\\a\\.claude"\r\n"C:\\node\\node.exe" "C:\\100%%\\bin\\ccg.mjs" %*\r\n')
  })

  it('removes the shim and reports whether it existed', async () => {
    const install = join(tmp(), '.claude')
    expect(await removeShim(install)).toBe(false)
    await writeShim(install, '/x/bin/ccg.mjs')
    expect(await removeShim(install)).toBe(true)
    expect(await shimTarget(install)).toBeNull()
  })
})

describe('windows install writes both launchers', () => {
  it('writes osm (sh, for Git Bash) and osm.cmd', async () => {
    const install = join(tmp(), '.claude')
    await writeShim(install, 'C:/x/bin/ccg.mjs', 'C:/node/node.exe', 'win32')
    expect(await shimTarget(install)).toBe('C:/x/bin/ccg.mjs')
    expect(readFileSync(join(install, 'bin', 'osm.cmd'), 'utf8')).toContain('setlocal')
    expect(await removeShim(install, 'win32')).toBe(true)
  })
})
