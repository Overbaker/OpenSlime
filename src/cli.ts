#!/usr/bin/env node
import cac from 'cac'
import { setupCommands } from './cli-setup'

async function main(): Promise<void> {
  const cli = cac('ccg')
  await setupCommands(cli)
  cli.parse()
}

main().catch((error) => {
  console.error(error?.message ?? error)
  process.exitCode = error?.name === 'CACError' ? 2 : 1
})
