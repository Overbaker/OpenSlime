# OpenSlime — notes for agents working on this repo

OpenSlime is a slim fork of ccg-workflow. It installs `/osm:*` commands, role prompts, on-demand skills and `codeagent-wrapper` into `~/.claude`. Read `PRINCIPLES.md` before adding anything; read `FORK.md` for what was removed and why.

## Layout
- `src/` — TypeScript CLI (`bin/ccg.mjs`, also `osm`): `commands/` (init, menu, doctor, skills, update), `utils/installer*.ts` (what gets written to `~/.claude`).
- `templates/commands/` — the five `/osm:*` command templates. `{{BACKEND_PRIMARY}}`-style placeholders are filled at install time (`utils/installer-template.ts`).
- `templates/prompts/<backend>/` — role prompts read by the wrapper via `ROLE_FILE:`; `prompts/claude/osm-report.md` is the stage-report spec.
- `templates/skills/`, `templates/output-styles/`, `templates/rules/` — copied as-is.
- `codeagent-wrapper/` — Go wrapper, unmodified from upstream; the installer downloads upstream release binaries.

## Rules
- Nothing may be injected per turn: no hooks, no always-on rules beyond `rules/ccg-codegraph.md`.
- Removed artifacts must be added to `SLIMMED_ARTIFACTS` in `src/utils/installer.ts` so upgrades retire them to `~/.claude/.ccg-retired/`.
- Keep `README.md`, `README.zh-CN.md` and `AGENTS.md` in sync with behaviour.

## Checks
```bash
pnpm install --frozen-lockfile && pnpm typecheck && pnpm test && pnpm build
cd codeagent-wrapper && go test -short ./...   # only when the wrapper changes; some tests fail as root
```
