# CCG Slim — Claude-led multi-model workflow

> **This is a slimmed-down fork** of [fengshao1227/ccg-workflow](https://github.com/fengshao1227/ccg-workflow).
> It keeps the multi-model serial chain and removes per-turn hooks, always-on routing rules, the `/ccg:go` engine,
> regex quality gates and the DeepSeek Harness (`dsh-ccg`) plugin. **DSH as a host is not supported.**
> Claude stays the orchestrator; Codex, Gemini, Antigravity, Grok, Kimi, OpenCode and Claude are called as workers
> through `codeagent-wrapper`. The optional Codex-led mode (`ccg codex-mode`) is unchanged from upstream.
> What was removed and why: [FORK.md](FORK.md). 中文：[README.zh-CN.md](README.zh-CN.md)

## What it installs

| Part | Purpose |
|---|---|
| `/ccg:spec-init → spec-research → spec-plan → spec-impl → spec-review` | OpenSpec chain. The backend model is required; the frontend model joins only for UI work. `spec-impl` lets the worker edit an explicit file list, Claude reviews the diff, a fresh session reviews the result. |
| `~/.claude/bin/codeagent-wrapper` | One CLI for every backend, with `resume <session>` and `--parallel` tasks ordered by `dependencies:`. |
| `~/.claude/.ccg/prompts/<backend>/` | Role prompts (analyzer, architect, builder, reviewer, …). |
| On-demand skills | `frontend-design`, `scrapling`, `seo-page-builder`, `bt-panel`, `adsense-site-auditor`. Nothing is injected until you call them. |
| Output styles | All set `keep-coding-instructions: true`, so Claude Code's built-in engineering instructions stay active. |

Per session, the only always-on text is `rules/ccg-codegraph.md`. No hooks are registered.

## Install

Requires Node.js 20+, pnpm and Claude Code. Backend CLIs (codex, gemini, agy, grok, kimi, opencode) are optional.

```bash
git clone -b slim <this-repo-url> ccg-slim && cd ccg-slim
pnpm install && pnpm build
node bin/ccg.mjs init                                  # interactive
node bin/ccg.mjs init --skip-prompt --skip-mcp --force # defaults
```

Do not run `npx ccg-workflow` afterwards: that installs upstream and brings the removed parts back.

Upgrading over an upstream install moves retired files to `~/.claude/.ccg-retired/<timestamp>/` and unregisters only CCG's own hook commands; your hooks, rules and settings stay.

## CLI

```bash
node bin/ccg.mjs                 # menu
node bin/ccg.mjs init            # install / reinstall
node bin/ccg.mjs doctor [--json] # health check
node bin/ccg.mjs skills list     # native skill selection
node bin/ccg.mjs codex-mode install|uninstall
node bin/ccg.mjs uninstall
```

## Layout

```
~/.claude/
├── commands/ccg/          # spec-* and skill commands
├── skills/ccg/            # on-demand skills
├── rules/ccg-codegraph.md
├── .ccg/config.toml       # model routing
├── .ccg/prompts/          # role prompts per backend
└── bin/codeagent-wrapper
```

Wrapper environment (in `~/.claude/settings.json` → `env`): `CODEX_TIMEOUT` (ms, default 7200000), `CODEX_REQUIRE_APPROVAL` (`true` disables Codex's bypass mode).

## Credits

Upstream [fengshao1227/ccg-workflow](https://github.com/fengshao1227/ccg-workflow) and its contributors · [stellarlinkco/myclaude](https://github.com/stellarlinkco/myclaude) (wrapper inspiration) · [ace-tool](https://linux.do/t/topic/1344562).

## License

MIT, see [LICENSE](LICENSE).
