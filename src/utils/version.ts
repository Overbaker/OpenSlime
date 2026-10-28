import fs from 'fs-extra'
import { dirname, join } from 'pathe'
import { fileURLToPath } from 'node:url'
import { version as bundledVersion } from '../../package.json'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Find package root by looking for package.json (walk all the way to filesystem root)
function findPackageRoot(startDir: string): string {
  let dir = startDir

  while (true) {
    if (fs.existsSync(join(dir, 'package.json'))) {
      return dir
    }

    const parentDir = dirname(dir)
    if (parentDir === dir) {
      return dir
    }

    dir = parentDir
  }
}

const PACKAGE_ROOT = findPackageRoot(__dirname)

/**
 * Read version field from a package.json path
 */
async function readPackageVersion(pkgPath: string): Promise<string | null> {
  try {
    if (!(await fs.pathExists(pkgPath))) {
      return null
    }
    const pkg = await fs.readJSON(pkgPath)
    return pkg.version || null
  }
  catch {
    return null
  }
}

/**
 * Get current installed version from package.json
 */
export async function getCurrentVersion(): Promise<string> {
  // Prefer build-time bundled version (always available after unbuild)
  if (bundledVersion) {
    return bundledVersion
  }

  // Fallback: path relative to this file
  const relativePkgPath = fileURLToPath(new URL('../../package.json', import.meta.url))
  const relativeVersion = await readPackageVersion(relativePkgPath)
  if (relativeVersion) {
    return relativeVersion
  }

  // Fallback: walk up to find package root (for unusual runtime layouts)
  const rootPkgPath = join(PACKAGE_ROOT, 'package.json')
  const rootVersion = await readPackageVersion(rootPkgPath)
  if (rootVersion) {
    return rootVersion
  }

  return process.env.npm_package_version || '0.0.0'
}

/**
 * Compare two semantic versions
 * @returns 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
export function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split('.').map(Number)
  const parts2 = v2.split('.').map(Number)

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const num1 = parts1[i] || 0
    const num2 = parts2[i] || 0

    if (num1 > num2)
      return 1
    if (num1 < num2)
      return -1
  }

  return 0
}
