<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/openslime-lockup-dark.svg">
    <img src="assets/brand/openslime-lockup-light.svg" width="360" alt="OpenSlime">
  </picture>
</p>

<p align="center">
  <em>Claude plans and reviews. Codex writes the backend. Antigravity writes the frontend.</em><br>
  <sub>Minimal multi-agent development on OpenSpec, for Claude Code.</sub>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/for-Claude%20Code-111111?style=flat-square" alt="For Claude Code">
  <img src="https://img.shields.io/badge/built%20on-OpenSpec-111111?style=flat-square" alt="Built on OpenSpec">
  <img src="https://img.shields.io/badge/hooks-none-111111?style=flat-square" alt="No hooks">
  <img src="https://img.shields.io/badge/license-MIT-111111?style=flat-square" alt="MIT license">
</p>

<p align="center"><sub>English &middot; <a href="README.zh-CN.md">简体中文</a></sub></p>

---

## Install

Paste this to your coding agent (Claude Code, Codex):

```text
Install OpenSlime from https://github.com/Overbaker/OpenSlime. Follow AGENTS.md in that repo, then run its doctor check and tell me the result.
```

Manual steps: [AGENTS.md](AGENTS.md).

## Five commands

| Command | What it does |
| --- | --- |
| `/osm:init` | Set up OpenSpec and check the model CLIs. |
| `/osm:research` | Requirement &rarr; constraints + OpenSpec proposal. |
| `/osm:plan` | Zero-decision plan: specs, design, `tasks.md`. |
| `/osm:impl` | Hand each task to a writer; Claude reviews the diff. |
| `/osm:review` | Independent-session review before archive. |

## How it works

- **Scoped writers.** In `/osm:impl`, `codex` writes backend, logic and tests; `antigravity` writes UI. Each task lists the files its writer may touch.
- **Claude supervises.** It fixes behaviour-preserving slips of &le;5 lines itself and re-runs `VERIFY`. Anything bigger goes back to the writer via `resume`; after two failed tries it asks you before taking over.
- **Always cross-checked.** Research, plan and review run codex and antigravity in separate fresh sessions; Claude compares where they agree and where they don't.
- **Optional comparison.** `/osm:impl --compare` adds one subagent in its own git worktree. It picks the writer and skill for the task; the cross review keeps the better result.
- **Stage report.** Every run ends with a report in `${TMPDIR:-/tmp}/osm-reports/` and a confidence estimate (High/Medium/Low, %).

## Why it is small

- **Nothing per turn.** No hooks. One small always-on rule (`rules/ccg-codegraph.md`). Skills (`frontend-design`, `scrapling`, `seo-page-builder`, `bt-panel`, `adsense-site-auditor`) load only when called. Output styles keep Claude Code's built-in coding instructions.
- **One main loop.** Claude plans, decides and talks to you; no router in front of it.
- **Other models only where they earn it:** scoped writing, or a second opinion in a fresh session. Codex-led mode (`node bin/ccg.mjs codex-mode install`) and every wrapper backend (`codex`, `claude`, `gemini`, `antigravity`, `grok`, `kimi`, `opencode`) are kept; DeepSeek Harness as a host is not.

Design rules: [PRINCIPLES.md](PRINCIPLES.md).

## Requirements

Node.js 20+, pnpm, git, Claude Code; `codex` and `agy` (Antigravity) CLIs, logged in; OpenSpec (`npm i -g @fission-ai/openspec`, or let `/osm:init` guide you).

## Update and uninstall

```bash
# Update
cd ~/OpenSlime && git pull && pnpm install && pnpm build && node bin/ccg.mjs init --skip-prompt --skip-mcp --force

# Uninstall
cd ~/OpenSlime && node bin/ccg.mjs uninstall
```

## Credits

OpenSlime is a slim fork of [fengshao1227/ccg-workflow](https://github.com/fengshao1227/ccg-workflow); what was removed and why is in [FORK.md](FORK.md). Thanks to its contributors, and to:

- [stellarlinkco/myclaude](https://github.com/stellarlinkco/myclaude): `codeagent-wrapper`
- [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail): review criteria
- [ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd): output shape
- ace-tool

All MIT. OpenSlime is [MIT](LICENSE) too.
