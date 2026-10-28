# OpenSlime stage report (Claude)

Write one at the end of every /osm:research, /osm:plan, /osm:impl and /osm:review run.

Path: `${TMPDIR:-/tmp}/osm-reports/<repo-name>/<change-id>/<stage>.md` (temporary; overwrite on re-run; never commit). Show the path and the Confidence line in chat.

```markdown
# <stage> — <change-id> — <date>
Confidence: High | Medium | Low (NN%) — <one-line reason>

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
