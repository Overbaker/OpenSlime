import fs from 'fs-extra'
import { join } from 'pathe'

/** POSIX single-quote quoting: survives spaces, `$`, backticks and quotes. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** cmd.exe: double quotes, with `%` doubled so it is not expanded. */
function cmdQuote(s: string): string {
  return `"${s.replace(/%/g, '%%')}"`
}

/** `osm` (POSIX sh) everywhere, because Claude Code runs Bash, also Git Bash on Windows; plus `osm.cmd` for cmd/PowerShell. */
export function shimNames(platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32' ? ['osm', 'osm.cmd'] : ['osm']
}

/**
 * The launcher templates call as `~/.claude/bin/osm`: it needs no PATH entry, runs the Node that installed
 * OpenSlime on this checkout's CLI, and exports the install dir so harness fingerprints read the right files.
 */
export function shimContent(node: string, entry: string, installDir: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return `@echo off\r\nsetlocal\r\nset ${cmdQuote(`OSM_INSTALL_DIR=${installDir}`)}\r\n${cmdQuote(node)} ${cmdQuote(entry)} %*\r\n`
  }
  return `#!/bin/sh\nOSM_INSTALL_DIR=${shQuote(installDir)} exec ${shQuote(node)} ${shQuote(entry)} "$@"\n`
}

export async function writeShim(installDir: string, entry: string, node: string = process.execPath, platform: NodeJS.Platform = process.platform): Promise<string> {
  const binDir = join(installDir, 'bin')
  await fs.ensureDir(binDir)
  const path = join(binDir, 'osm')
  await fs.writeFile(path, shimContent(node, entry, installDir, 'linux'), { mode: 0o755 })
  await fs.chmod(path, 0o755)
  if (platform === 'win32') await fs.writeFile(join(binDir, 'osm.cmd'), shimContent(node, entry, installDir, 'win32'))
  return path
}

export async function removeShim(installDir: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  let removed = false
  for (const name of shimNames(platform)) {
    const path = join(installDir, 'bin', name)
    if (await fs.pathExists(path)) {
      await fs.remove(path)
      removed = true
    }
  }
  return removed
}

const SH_LINE = /exec '((?:[^']|'\\'')*)' '((?:[^']|'\\'')*ccg\.mjs)' "\$@"/

/** The Node binary and CLI entry the `osm` shim runs, or null when it is missing or unreadable. */
export async function shimPaths(installDir: string): Promise<{ node: string, entry: string } | null> {
  try {
    const m = SH_LINE.exec(await fs.readFile(join(installDir, 'bin', 'osm'), 'utf8'))
    const unq = (s: string) => s.replace(/'\\''/g, '\'')
    return m ? { node: unq(m[1]), entry: unq(m[2]) } : null
  }
  catch {
    return null
  }
}

export async function shimTarget(installDir: string): Promise<string | null> {
  return (await shimPaths(installDir))?.entry ?? null
}
