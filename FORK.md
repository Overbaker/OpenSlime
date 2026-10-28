# ccg-workflow — slim fork

Fork of [fengshao1227/ccg-workflow](https://github.com/fengshao1227/ccg-workflow) that keeps the
multi-model serial chain and drops everything that is injected on every turn or that strong
models (Claude Opus/Fable, GPT-codex) already do better without it.

## Kept

- `codeagent-wrapper` (codex / antigravity / gemini / … backends, `resume`, `--parallel` with `dependencies:`).
- `/osm:init → /osm:research → /osm:plan → /osm:impl → /osm:review` on OpenSpec.
- Role prompts in `~/.claude/.ccg/prompts/<backend>/`.
- On-demand skills: `frontend-design` (+ impeccable playbooks), `scrapling`, `seo-page-builder` (+ `domains/seo`), `bt-panel`, `adsense-site-auditor`.
- `rules/ccg-codegraph.md`, optional legacy commands, output styles, Codex-led mode (`ccg codex-mode`).
- Every worker backend of `codeagent-wrapper`: codex, claude, gemini, antigravity, grok, kimi, opencode.

## Removed

| Removed | Why |
|---|---|
| All Claude hooks (`workflow-state`, `skill-router`, `session-start`, `subagent-context`) | Ran on every prompt / tool call. `skill-router` matched substrings such as `rest`, `cache`, `source` and injected 120-line excerpts; the others only mattered for `/osm:go` task state. |
| `rules/ccg-skills.md`, `rules/ccg-skill-routing.md` | ~10 KB in every session; forced quality gates after any 30-line change. |
| `/osm:go`, `engine/` strategies, phase guide | Self-contradictory (read-only external models vs. builder mode), mandatory gates, hard-coded agent models. |
| `verify-quality/security/change/module`, `gen-docs` | Regex scanners with fixed thresholds (e.g. snake_case function names in TypeScript); noise for capable models. |
| `/osm:hi` (override-refusal) | Rewrote the session transcript to replace refusals. |
| `domains/` except `frontend-design` and `seo`, `orchestration/multi-agent` | Textbook content the models already know. |
| DeepSeek Harness plugin (`dsh-ccg/`, `ccg dsh`, menu D) | Installing CCG *into* DSH as a host is out of scope; DSH is not a wrapper backend either. |
| `/osm:init`, `context`, `commit`, `rollback`, `clean-branches`, `worktree`, `agents/ccg/*` | Native Claude Code covers them. |

## Behaviour changes in the spec chain

- The backend model is required; the frontend model joins only for frontend/UI scope. No retry loops, no "never stop polling".
- `/osm:impl`: codex writes backend, antigravity writes frontend, each inside an explicit file allow-list (the wrapper already runs them with write access). Claude supervises and reviews; it fixes only mechanical ≤5-line issues itself and sends logic changes back to the writer via `resume`. Opt-in `--compare[=<skill>]` runs a Claude subagent on the same task in an isolated worktree for comparison.
- Commands are `/osm:init|research|plan|impl|review`; the non-OpenSpec legacy commands are removed.
- Reviews run in a fresh session and every finding needs a concrete failing case (`prompts/*/reviewer.md`, adapted from [ponytail-review](https://github.com/DietrichGebert/ponytail), MIT).

## Output styles

Every bundled style sets `keep-coding-instructions: true`. Without it a custom output style drops Claude Code's built-in software-engineering instructions (scoping, comments, verification) and leaves only the style's own text. `engineer-professional` is cut to output-shape rules condensed from [i-have-adhd](https://github.com/ayghri/i-have-adhd) (MIT) plus the confirm-before-risky-actions list.

Running `ccg init` / `ccg update` from this fork also moves the artifacts above from an earlier full install to `~/.claude/.ccg-retired/<timestamp>/` and unregisters only the CCG hook commands, keeping your own hooks and rules.

## Install

```bash
git clone https://gitea.aimo3d.org/han/OpenSlime.git && cd OpenSlime
pnpm install && pnpm build
node bin/ccg.mjs init            # or: node bin/ccg.mjs init --skip-prompt --skip-mcp --force
```

Do not run `npx ccg-workflow` afterwards: it installs upstream and brings the removed parts back.
