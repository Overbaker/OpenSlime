# OpenSlime Agent Installation Guide

This guide is for AI coding agents installing OpenSlime on the user's machine.

## 1. Goal and Files Written
Install OpenSlime to provide minimal Claude-led multi-agent collaboration on OpenSpec.
What the installation writes:
- `~/.claude/commands/osm/` (slash commands)
- `~/.claude/skills/ccg/` (on-demand skills)
- `~/.claude/.ccg/{config.toml,prompts/}`
- `~/.claude/rules/ccg-codegraph.md`
- `~/.claude/bin/codeagent-wrapper`
- `~/.claude/bin/osm` (decision-ledger launcher; runs this checkout's `bin/ccg.mjs` with the installing Node)
- Permission allow entry for `codeagent-wrapper` in `~/.claude/settings.json`

The decision ledger lives in `~/.claude/osm-ledger/`. It is created on the first recorded stage, and init, update and uninstall never modify or delete it.

The installer does NOT modify agy settings in `~/.gemini/antigravity-cli/settings.json`.

If files from an earlier upstream CCG install exist, they are moved to `~/.claude/.ccg-retired/<timestamp>/`, and only CCG's own hook commands are unregistered. The user's hooks, rules, and settings stay.

## 2. Preflight Checks
Run the following exact commands to verify requirements:
```bash
node -v          # Required: >= 20
pnpm -v          # Required
git --version    # Required
claude --version # Required
codex --version  # Required (must be logged in)
codex login status # Required: verify Codex login
agy --version    # Required: Antigravity CLI (must be logged in)
agy models       # Required: lists models only when logged in
openspec --version # Optional: OpenSpec CLI
```
- If a required tool (`node` <20, `pnpm`, `git`, `claude`, `codex`, `agy`) is missing or `codex`/`agy` is not logged in: **stop** immediately and tell the user what to install or configure. Do not install global tools without the user's consent.
- If `openspec` is missing: offer to install it (`npm i -g @fission-ai/openspec`) or let `/osm:init` guide it.
- If `antigravity` is a selected backend, read `~/.gemini/antigravity-cli/settings.json` and verify that `permissions.allow` contains the entry `"command(*)"` (narrower `command(...)` rules are not enough). If the file or matching entry is missing, explain that headless agy otherwise denies shell tools and returns nothing, and ask whether the user agrees to add `command(*)`, which allows all shell commands. Only after the user agrees, add that entry, creating the file or array if missing and preserving all existing settings and entries. If the user declines, leave settings unchanged and report Antigravity as not ready. If the file is invalid JSON, report the error without overwriting it.

## 3. Install Steps
If `~/OpenSlime` already exists, run `git -C ~/OpenSlime status --porcelain`. If it reports local changes, ask the user before proceeding; if the check fails, stop and report the error. If the output is empty, run `git -C ~/OpenSlime pull` instead of cloning. Only clone when the directory does not exist:
```bash
git clone https://github.com/Overbaker/OpenSlime.git ~/OpenSlime
```
After cloning or updating the clean checkout:
```bash
cd ~/OpenSlime
pnpm install && pnpm build
node bin/ccg.mjs init --skip-prompt --skip-mcp --force     # non-interactive; `node bin/ccg.mjs init` for the wizard
```

## 4. Verify Installation
Run doctor and verify installed commands:
```bash
node bin/ccg.mjs doctor
ls ~/.claude/commands/osm
```
- Expect no failures from `doctor`. Warnings (e.g. no native skill selection or MCP skipped) are allowed; only failures indicate an unsuccessful verification.
- Run `~/.claude/bin/osm ledger status`; it should print `Ledger: on`. In doctor, `ledger.shim` is only ever pass or warn; on warn, rerun the install step from the current checkout.
- Verify the five `/osm` commands (`init.md`, `research.md`, `plan.md`, `impl.md`, `review.md`) and skill commands are present in `~/.claude/commands/osm`.

## 5. Next Steps for User
Tell the user to:
1. Restart Claude Code so the `/osm:*` commands appear.
2. Run `/osm:init` in their project directory to initialize OpenSpec and verify model CLIs.

## 6. Update and Uninstall
```bash
# Update
cd ~/OpenSlime && git pull && pnpm install && pnpm build && node bin/ccg.mjs init --skip-prompt --skip-mcp --force

# Uninstall (removes ~/.claude/bin/osm, keeps ~/.claude/osm-ledger)
cd ~/OpenSlime && node bin/ccg.mjs uninstall
```

## 7. Rules for the Agent
- **Never run `npx ccg-workflow`**: it installs upstream and brings removed parts back.
- **Do not print or copy credentials**: never output API keys, tokens, or login credentials.
- **Do not modify unrelated files**: leave existing user hooks, rules, and settings in `~/.claude` untouched.
