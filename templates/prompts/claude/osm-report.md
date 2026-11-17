# OpenSlime stage report (Claude)

Write one at the end of every /osm:research, /osm:plan and /osm:review run, and one per phase of /osm:impl.

Path: `${TMPDIR:-/tmp}/osm-reports/<repo-name>/<change-id>/<stage>.md` for research/plan/review; `${TMPDIR:-/tmp}/osm-reports/<repo-name>/<change-id>/impl-<phase>.md` for impl (use the phase identifier from tasks.md). Reports are temporary; overwrite the same stage or phase on re-run; never commit. Show the path and the Confidence line in chat.

```markdown
# <stage> — <change-id> — <date>
Confidence: High | Medium | Low (NN%) — <one-line reason>
Ledger: on (event <id>) | off | unavailable (<reason>)

## Decision
<what was decided or done, 1-3 lines>

## Models
| Point | codex | antigravity | Claude call |
|---|---|---|---|
<only points that matter; mark agree / disagree; for impl add the comparison writer column if used>

## Evidence
- <commands run and results, files read, tests passed/failed>

## Open risks / not checked
- <max 5>
```

## Confidence
Start at Medium (60%), then:
- +15 each: both models agree on the key points; VERIFY or tests pass; no open Critical findings.
- −15 each: the models disagree on a key point you resolved by judgement; a model failed and was skipped; something important was not checked; an ambiguity was assumed, not confirmed.
Cap at 95%. High ≥ 80%, Low < 50%. When Low, say what would raise it.

## Ledger
The decision ledger (`~/.claude/bin/osm ledger`) keeps stage confidence, human decisions and what later happened. It lives in `~/.claude/osm-ledger/` and is never committed.

1. **Run id.** At stage start, run `~/.claude/bin/osm ledger run-id` once. Use it as `run_id` for every event of this invocation, retries included.
   - With `--no-ledger` in `$ARGUMENTS`, skip every ledger step and write `Ledger: off`.
   - If it fails, skip every ledger step and write `Ledger: unavailable (<reason>)`.
   - If append returns `{"status":"disabled"}`, write `Ledger: off` and skip the rest.
2. **Human decisions.** After each material `AskUserQuestion` answer, append one `human_decision`. Material means its `dimension` is one of `scope`, `design`, `backend`, `skill`, `permissions`, `acceptance` (lesson adoption: `adoption`); routine acks don't count.
   - Recommend the smallest option that keeps the goal; after 3 fix rounds with a Critical open, commit-and-track. Never use `recommended` as an id.
   - With a recommendation, first run `~/.claude/bin/osm ledger position --run-id <run id> --decision-id <slug> --options <K>`, show it at that 0-based index, and set `"position":"run-hash-v1"`.
   - `options`: the option ids, in the order they were shown.
   - `recommendation`: the option marked Recommended, or null.
   - `initial_choice`: the user's choice before your input, else null.
   - `final_position`: the index of `final_choice` in `options`.
3. **Stage completed.** At report time, freeze the confidence first, then append `stage_completed`. Use `operation_key: "report"`; for impl use `"report-<phase_id>"` and also set `phase_id`.
   - Add one invocation per external model, subagent or skill call, with its accepted, rejected and unadjudicated finding counts (null if unknown).
   - Add Claude's own usage as one invocation with `role: "orchestrator"`.
   - Optional, never guessed: `model`; `mcp_tools` as `server:tool`; `practices` from `plan-first, tdd, pbt, repro-first, spec-read, callers-read, parallel-review, blind-review, worktree, typecheck, lint, small-commits`; `cost` `{"tokens":N,"usd":N}`.
   - Failed or skipped call: `failure` `timeout | quota | auth | region | crash | empty-output | bad-output | other`.
   - `ai_decisions`: per dimension, material decisions you made without asking (0 if none; omit if not counted). `change_kind`: `feature | fix | refactor | docs | test | chore`.
4. **The ledger never changes the confidence.** A missing CLI, an error exit or `Ledger: off` only changes the `Ledger:` line.

Append through a quoted heredoc. Exit 0 means the receipt is `appended`, `duplicate` or `disabled`.

```bash
~/.claude/bin/osm ledger append <<'JSON'
{"schema_version":1,"run_id":"<run id>","change_id":"<change id or null>","stage":"review","phase_id":null,"kind":"stage_completed","operation_key":"report",
 "payload":{"status":"completed","confidence":{"percent":75},"verify":"passed","change_kind":"fix","ai_decisions":{"design":2,"scope":0},"invocations":[{"backend":"codex","role":"reviewer","skills":[],"status":"succeeded","accepted":3,"rejected":1,"unadjudicated":0,"mcp_tools":["context7:query-docs"]}]}}
JSON
~/.claude/bin/osm ledger append <<'JSON'
{"schema_version":1,"run_id":"<run id>","change_id":"<change id>","stage":"plan","phase_id":null,"kind":"human_decision","operation_key":"<question slug>",
 "payload":{"decision_id":"<question slug>","topic":"<≤200 chars>","dimension":"design","options":["a","b"],"recommendation":"b","position":"run-hash-v1","initial_choice":null,"final_choice":"b","final_position":1,"blind":false}}
JSON
```

Fields hold ids, counts and short paraphrases: no source code, transcript text or absolute paths.

The user reads it with `~/.claude/bin/osm ledger summary` in another terminal (not `!`).
