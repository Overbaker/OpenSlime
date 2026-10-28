import { PACKAGE_ROOT } from './installer-template'

export const FORK_UPDATE_COMMAND = `cd '${PACKAGE_ROOT.replace(/'/g, "'\\''")}' && git pull && pnpm install && pnpm build && node bin/ccg.mjs init --skip-prompt --skip-mcp --force`
