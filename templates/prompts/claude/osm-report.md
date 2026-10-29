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
- −15 each: the models disagree on a key point you resolved by judgement; a model failed and was skipped; something important was not checked; an ambiguity was assumed, not confirmed by the user.
Cap at 95%. High ≥ 80%, Low < 50%. When Low, say what would raise it.

## Ledger
The decision ledger (`~/.claude/bin/osm ledger`) keeps what reports forget: stage confidence, human decisions, and later what actually happened. It lives in `~/.claude/osm-ledger/`, belongs to this user, and is never committed.

1. **Run id.** At stage start, run `~/.claude/bin/osm ledger run-id` once. Use it as `run_id` for every event of this invocation, retries included.
   - With `--no-ledger` in `$ARGUMENTS`, skip every ledger step and write `Ledger: off`.
   - If the command fails, skip every ledger step and write `Ledger: unavailable (<reason>)`.
   - If an append returns `{"status":"disabled"}`, recording is off. Write `Ledger: off` and skip the rest.
2. **Human decisions.** After each material `AskUserQuestion` answer, append one `human_decision`. Material means scope, design, backend, skill, permissions or acceptance; routine acknowledgements don't count.
   - `options`: the option ids, in the order they were shown.
   - `recommendation`: the option marked Recommended, or null.
   - `initial_choice`: only if the user stated a choice before your input; otherwise null.
   - `final_position`: the index of `final_choice` in `options`.
3. **Stage completed.** At report time, freeze the confidence first, then append `stage_completed`. Use `operation_key: "report"`; for impl use `"report-<phase_id>"` and also set `phase_id`.
   - Add one invocation per external model, subagent or skill call.
   - Give each its accepted, rejected and unadjudicated finding counts, or null when unknown.
4. **The ledger never changes the confidence.** A missing CLI, an error exit or `Ledger: off` only changes the `Ledger:` line.

Append through a quoted heredoc. Exit 0 means the receipt is `appended`, `duplicate` or `disabled`.

```bash
~/.claude/bin/osm ledger append <<'JSON'
{"schema_version":1,"run_id":"<run id>","change_id":"<change id or null>","stage":"review","phase_id":null,"kind":"stage_completed","operation_key":"report",
 "payload":{"status":"completed","confidence":{"percent":75},"verify":"passed","invocations":[{"backend":"codex","role":"reviewer","skills":[],"status":"succeeded","accepted":3,"rejected":1,"unadjudicated":0}]}}
JSON
~/.claude/bin/osm ledger append <<'JSON'
{"schema_version":1,"run_id":"<run id>","change_id":"<change id>","stage":"plan","phase_id":null,"kind":"human_decision","operation_key":"<question slug>",
 "payload":{"decision_id":"<question slug>","topic":"<≤200 chars>","options":["a","b"],"recommendation":"a","initial_choice":null,"final_choice":"a","final_position":0,"blind":false}}
JSON
```

Fields hold ids, counts and short paraphrases. Never put source code, transcript text or absolute paths in them; the CLI rejects paths.

To read the ledger without spending this session's context, the user runs `~/.claude/bin/osm ledger summary` in their own terminal. Output from `!` commands enters the conversation.
