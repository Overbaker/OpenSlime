# OpenSlime

Minimal Claude-led multi-agent collaboration on OpenSpec; Claude orchestrates, codex writes backend, antigravity writes frontend.

Slim fork of [fengshao1227/ccg-workflow](https://github.com/fengshao1227/ccg-workflow) (MIT). [中文文档](README.zh-CN.md)

## Install with your AI agent

Paste this prompt to your AI coding agent (Claude Code, Codex):

```text
Install OpenSlime from https://github.com/Overbaker/OpenSlime. Follow AGENTS.md in that repo, then run its doctor check and tell me the result.
```

Manual install steps are in [AGENTS.md](AGENTS.md).

## How it works

1. `/osm:init`: Set up OpenSpec and check model CLIs.
2. `/osm:research`: Requirement &rarr; constraints + OpenSpec proposal.
3. `/osm:plan`: Zero-decision plan (specs, design, `tasks.md`).
4. `/osm:impl`: Delegate each task.
5. `/osm:review`: Independent-session review before archive.

- **Roles in `/osm:impl`**: `codex` writes backend/logic/tests; `antigravity` writes frontend/UI (only for UI scope). Each task lists the exact files the writer may change.
- **Claude supervises**: Claude scopes tasks and reviews the diff.
- **Fix Rules**: Claude fixes mechanical behavior-preserving issues of &le;5 lines itself and re-runs `VERIFY`; logic/interface changes or >5 lines go back to the writer via `resume`; after two writer failures Claude asks the user before taking over.
- **Independent reviews**: Reviews run in a fresh session that did not write the code.
- **Optional comparison**: `/osm:impl --compare[=<skill>]` has a Claude subagent write the same task in an isolated git worktree (optionally loading a skill); the reviewer keeps the result that passes `VERIFY` with fewer Critical findings (doubles writing cost; for high-risk tasks).

## Why it is small

- **No per-turn injection**: The only always-on text is one small rule file (`rules/ccg-codegraph.md`); no hooks. Skills (`frontend-design`, `scrapling`, `seo-page-builder`, `bt-panel`, `adsense-site-auditor`) load only when called. Output styles keep Claude Code's built-in coding instructions (`keep-coding-instructions: true`).
- **Single main loop**: Claude plans, decides, and talks to the user—no routers or orchestrators in front of it.
- **External models only where they earn it**: Used only for scoped writing (`codex` backend, `antigravity` frontend) or independent verification in a fresh session. DeepSeek Harness as a host is not supported; Codex-led mode (`node bin/ccg.mjs codex-mode install`) and all wrapper backends (`codex`, `claude`, `gemini`, `antigravity`, `grok`, `kimi`, `opencode`) are kept.

See [PRINCIPLES.md](PRINCIPLES.md) for design rules and [FORK.md](FORK.md) for removed parts and reasons.

## Requirements

- Node.js 20+, pnpm, git, Claude Code.
- Codex CLI (`codex`, logged in).
- Optional: Antigravity CLI (`agy`).
- OpenSpec CLI: `npm i -g @fission-ai/openspec` (or `/osm:init` installs/guides it).

## Update and uninstall

```bash
# Update
cd ~/OpenSlime && git pull && pnpm install && pnpm build && node bin/ccg.mjs init --skip-prompt --skip-mcp --force

# Uninstall
cd ~/OpenSlime && node bin/ccg.mjs uninstall
```

> Credits: upstream [fengshao1227/ccg-workflow](https://github.com/fengshao1227/ccg-workflow) and contributors; [stellarlinkco/myclaude](https://github.com/stellarlinkco/myclaude) (codeagent-wrapper); review criteria adapted from [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail); output shape condensed from [ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd); ace-tool. All MIT. License: MIT ([LICENSE](LICENSE)).
