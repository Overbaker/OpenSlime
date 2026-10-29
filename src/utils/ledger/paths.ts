import { homedir } from 'node:os'
import { join } from 'pathe'

export function defaultLedgerRoot(): string {
  return join(homedir(), '.claude', 'osm-ledger')
}

export function defaultInstallDir(): string {
  return join(homedir(), '.claude')
}

export function projectDir(root: string, projectId: string): string {
  return join(root, 'projects', projectId)
}

export function projectLog(root: string, projectId: string): string {
  return join(projectDir(root, projectId), 'events.jsonl')
}

export function globalLog(root: string): string {
  return join(root, 'global', 'events.jsonl')
}

export function disabledMarker(root: string): string {
  return join(root, 'disabled')
}
