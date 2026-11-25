# OpenSlime stage report (Claude)

Write after `/osm:research|plan|review` and each `/osm:impl` phase to `${TMPDIR:-/tmp}/osm-reports/<repo>/<change-id>/<stage>.md` (impl: `impl-<phase>.md`; use the phase identifier from tasks.md). Overwrite; never commit; show path + Confidence.

````markdown
# <stage> — <change-id> — <date>
Confidence: High|Medium|Low (NN%) — <reason>
Ledger: on (<id>) | off | unavailable (<reason>)
Tree: <tree_sha> | Reviewed tree: <sha|n/a> | Critical open: <N|n/a>
Gate: pass|fail|skipped (new N, baselined N, excepted N) | verify_sha256: <hex|map>

## Decision
<1-3 lines>

## Models
| Point | codex | antigravity | Claude |
|-|-|-|-|
<agree/disagree; +comparison col>

## Evidence
- <files, base_tree, commands>
```text
VERIFY <command>
exit <n>  tree <sha7>  base <sha>
<last ≤20 lines>
```

## Risks / not checked
- <max 5>
````

## Tree SHA
Temp-index `tree_sha` (no-index safe, aborts on error/empty; or `~/.claude/bin/osm verify-guard --print-tree`):
```bash
tree_sha=$(set -e; idx=$(mktemp); trap 'rm -f "$idx"' EXIT; src=$(git rev-parse --git-path index)
  if [ -f "$src" ]; then cp "$src" "$idx"; else rm -f "$idx"; fi
  GIT_INDEX_FILE="$idx" git add -A && GIT_INDEX_FILE="$idx" git write-tree) && [ -n "$tree_sha" ] || exit 1
```

## Confidence
Start 60% (Medium): +15 each (agree; VERIFY/tests pass; 0 Criticals); −15 each (unresolved split; fail/skip; check skipped; assumed ambiguity). Cap 95%; High ≥80%, Low <50% (say what raises it).

## Ledger (`~/.claude/osm-ledger/`, never committed)
1. **Run id.** `~/.claude/bin/osm ledger run-id` once; reuse on retries. `--no-ledger`/`"disabled"` → `Ledger: off`; error → `Ledger: unavailable (<reason>)`; skip ledger.
2. **Human decisions.** Material `AskUserQuestion` → `human_decision`: `dimension` is one of `scope`, `design`, `backend`, `skill`, `permissions`, `acceptance` (lesson adoption: `adoption`); routine acks don't count. Recommend smallest (3 rounds w/ open Critical → track issue, don't archive; never id `recommended`). With rec: `~/.claude/bin/osm ledger position --run-id <run id> --decision-id <slug> --options <K>`, put at 0-based index, set `"position":"run-hash-v1"`. `options`: shown ids; `recommendation`/`initial_choice`: id|null; `final_position`: index.
3. **Stage completed.** Freeze confidence; `operation_key`: `"report"` or `"report-<phase_id>"` + `phase_id`. Invocations: each model/subagent/skill (`accepted`/`rejected`/`unadjudicated`|null) + Claude (`role:"orchestrator"`). Optional: `model`, `mcp_tools` (`server:tool`), `practices` from `plan-first, tdd, pbt, repro-first, spec-read, callers-read, parallel-review, blind-review, worktree, typecheck, lint, small-commits`, `cost` `{"tokens":N,"usd":N}`, `failure` `timeout | quota | auth | region | crash | empty-output | bad-output | other` (fail/skip), `tree_sha`, `commit_sha`, `verify_sha256` (hex|`{task:hex}`), `gate` (`{result,exit_code?,new,baselined,excepted,square2_version,report_sha256}`; hash: `~/.claude/bin/osm ledger hash-report <path>`; `new`=len(`new_violations`), `baselined`=Σ `rules[*].baselined`, `excepted`=Σ `rules[*].excepted`; unknown ver: `exit_code` + null counts/hash), `ai_decisions` (0 if none; omit if not counted), `change_kind` (`feature | fix | refactor | docs | test | chore`). Gate outcomes: `"gate-impl-<phase>"`/`"gate-review"` (never `"outcome-impl-<phase>"`).
4. Ledger off/errors never alter confidence (only `Ledger:`).

Append via heredoc (exit 0: `appended`|`duplicate`|`disabled`):
```bash
~/.claude/bin/osm ledger append <<'JSON'
{"schema_version":1,"run_id":"<run id>","change_id":"<change id>","stage":"review","phase_id":null,"kind":"stage_completed","operation_key":"report","payload":{"status":"completed","confidence":{"percent":75},"verify":"passed","change_kind":"fix","tree_sha":"0123456789abcdef0123456789abcdef01234567","verify_sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","gate":{"result":"pass","new":0,"baselined":0,"excepted":0,"square2_version":"0.1.1","report_sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"},"ai_decisions":{"design":2},"invocations":[{"backend":"codex","role":"reviewer","skills":[],"status":"succeeded","accepted":3,"rejected":1,"unadjudicated":0}]}}
JSON
~/.claude/bin/osm ledger append <<'JSON'
{"schema_version":1,"run_id":"<run id>","change_id":"<change id>","stage":"plan","phase_id":null,"kind":"human_decision","operation_key":"<question slug>","payload":{"decision_id":"<question slug>","topic":"<≤200 chars>","dimension":"design","options":["a","b"],"recommendation":"b","position":"run-hash-v1","initial_choice":null,"final_choice":"b","final_position":1,"blind":false}}
JSON
~/.claude/bin/osm ledger append <<'JSON'
{"schema_version":1,"run_id":"<run id>","change_id":"<change id>","stage":"review","phase_id":null,"kind":"outcome","operation_key":"gate-impl-<phase>","payload":{"target":{"change_id":"<change id>","stage":"impl","phase_id":"<phase>"},"assessment":"gate","result":"passed","critical_count":0}}
JSON
```
Ids/counts/paraphrases only (no code/transcripts/abs paths). View: `~/.claude/bin/osm ledger summary` (not `!`).
