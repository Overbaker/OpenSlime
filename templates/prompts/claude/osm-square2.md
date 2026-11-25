# OpenSlime square² integration (Claude)

Read only the section named by the calling `/osm:*` stage, after running `## Detect` and `## Versions`.

Every ledger and guard command uses `~/.claude/bin/osm …`. Every square² command uses the vendored CLI `node tools/square2/bin/square2.mjs`.

## Detect

1. Check the working tree for both `.square2/config.yaml` and `tools/square2/bin/square2.mjs`.
2. **If either is missing**, do **not** rely on the default branch—check **every** remote-tracking branch:
   ```bash
   git for-each-ref --format='%(refname)' refs/remotes | while read -r r; do
     git cat-file -e "$r:.square2/config.yaml" 2>/dev/null && echo "$r"
   done
   ```
   - If **any** ref is printed: **stop the stage immediately**. Name the matching ref(s) and the missing path(s) (`.square2/config.yaml` and/or `tools/square2/bin/square2.mjs`), and tell the user to update the checkout. Never continue without the gate.
   - If none is printed: this is not a square² repository. Skip the rest of this file and run no square² commands.
3. **If both exist**, read `branch:` from `.square2/config.yaml` (`<cfg_branch>`) and compare `origin/<cfg_branch>` with the current branch's upstream (`git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null`). If they differ and `origin/<cfg_branch>` has commits touching `.square2/` not in `HEAD`:
   ```bash
   git log --oneline HEAD.."origin/<cfg_branch>" -- .square2/
   ```
   - If non-empty: **stop the stage immediately**, show those commits, and print the update command (`git fetch origin && git merge origin/<cfg_branch>` or `git rebase origin/<cfg_branch>`).
4. Otherwise: square² is active; continue with `## Versions` and the stage section.

## Versions

Read `version` from `.square2/lock.json` and strip any leading `v` before comparing (`0.1.x` covers `v0.1.0` and `0.1.1`).

| Normalized version | Supported commands |
|---|---|
| `0.1.x` | `check`, `check --base`, `check --rev`, `check --report`, `--only`, `selftest`, `replay` |
| Any other | `node tools/square2/bin/square2.mjs check` — exit code only (no `--base`, no `--rev`, no `--report` parsing, no `replay`) |

## Research

1. Read `.square2/review-context.md`.
2. List every square² rule id whose scope overlaps the area or files under study, and record those rule ids as hard constraints in the research summary.

## Plan

1. Read `.square2/review-context.md`.
2. For every task touching a rule's scope, list those square² rule ids in the task's `CONSTRAINTS`.
3. Do **not** include `square2 check` inside a task's frozen `VERIFY` command; the gate is enforced only by the pre/post delta in `## Impl`.

## Impl

**Report hygiene (`0.1.x`)**: before every `--report` run, delete the target report path (`rm -f "$report"`). Accept a report **only** when the command exits `0` or `1` **and** the report file exists afterwards. Exit `2` (or any other exit / missing file) is a gate error → **stop immediately** and show the error output.

**`0.1.x` gate flow (with ratchet)**:
Compute `<base commit>` from `branch:` in `.square2/config.yaml` (`<cfg_branch>`):
```bash
base_commit=$(git merge-base HEAD "origin/<cfg_branch>" 2>/dev/null || git rev-parse HEAD)
```
1. **Pre-check** (at phase start, before delegating writers):
   ```bash
   mkdir -p "${TMPDIR:-/tmp}/osm-sq2"
   pre="${TMPDIR:-/tmp}/osm-sq2/<run>-<phase>-pre.json"
   rm -f "$pre"
   pre_tree=$(~/.claude/bin/osm verify-guard --print-tree)
   node tools/square2/bin/square2.mjs check --base "$base_commit" --report "$pre" > "$pre.out" 2>&1
   ```
2. **Post-check** (after the writer's diff and `~/.claude/bin/osm verify-guard --base "$base_tree" --paths <files named by VERIFY>`, before Independent Review; with `--compare explore`, also re-run after landing the kept candidate in the main tree):
   ```bash
   post="${TMPDIR:-/tmp}/osm-sq2/<run>-<phase>-post.json"
   rm -f "$post"
   node tools/square2/bin/square2.mjs check --base "$base_commit" --report "$post" > "$post.out" 2>&1
   sq2_policy_diff=$(git diff --name-only "$pre_tree" "$(~/.claude/bin/osm verify-guard --print-tree)" -- .square2/)
   ```
3. **Delta block rule**:
   - `--base "$base_commit"` enables the ratchet so unauthorized baseline/exception edits by the writer surface as `[S2-BASELINE-GREW]` and `[S2-EXC-MUTATED]`.
   - Block the phase **iff** `post.json`'s `new_violations` contains a fingerprint absent from `pre.json`'s `new_violations`, **or** `$post.out` contains a `[S2-BASELINE-GREW]`, `[S2-EXC-MUTATED]` or `[S2-EXC-INVALID]` line absent from `$pre.out` (these appear only on stdout, not in the JSON), **or** `$sq2_policy_diff` is non-empty: any writer change to `.square2/**` (baseline, exceptions, approvals, rules) blocks, because a new exception or baseline entry can hide a new violation.
   - Pre-existing baselined entries, excepted entries, and violations already in `pre.json` never block (note pre-existing violations in the stage report).
   - Send each blocking line—including its `[rule] … — Instead: …` text—back to the writer via `resume` under the Fix Rules, then re-run post-check.
   - Overriding a block requires a ledger `human_decision` (`dimension: "acceptance"`) naming the overridden rule ids.
4. **Ledger gate record** (every impl phase):
   - Hash `$post` with `~/.claude/bin/osm ledger hash-report "$post"`.
   - Compute counts from `$post`: `new` = length of `new_violations`, `baselined` = `Σ rules[*].baselined`, `excepted` = `Σ rules[*].excepted`.
   - Record `gate: {"result":"pass"|"fail"|"skipped","exit_code":<n>,"new":N,"baselined":N,"excepted":N,"square2_version":"<version>","report_sha256":"<sha256>"}` on `stage_completed` (see `~/.claude/.ccg/prompts/claude/osm-report.md`).

**Unknown-version branch** (exit codes only):
1. Run `node tools/square2/bin/square2.mjs check` at phase start (`pre_exit`) and after the writer's diff + `verify-guard` (`post_exit`).
2. Exit `2` on pre or post = gate error → stop and show output.
3. Block **iff** (`post_exit == 1` and `pre_exit == 0`) or `post_exit == 2`.
4. Record `gate: {"result":"pass"|"fail","exit_code":<post_exit>,"new":null,"baselined":null,"excepted":null,"square2_version":"<version>","report_sha256":null}` on `stage_completed`.

## Review

1. **Gate check** on the reviewed tree:
   - `0.1.x`: delete any prior report, run with `--base "$base_commit"` (`git merge-base HEAD "origin/<cfg_branch>" 2>/dev/null || git rev-parse HEAD`) and `--report`, and accept only on exit `0` or `1` with the file present (exit `2` or missing file → stop and show error):
     ```bash
     mkdir -p "${TMPDIR:-/tmp}/osm-sq2"
     base_commit=$(git merge-base HEAD "origin/<cfg_branch>" 2>/dev/null || git rev-parse HEAD)
     rev="${TMPDIR:-/tmp}/osm-sq2/<run>-review.json"
     rm -f "$rev"
     node tools/square2/bin/square2.mjs check --base "$base_commit" --report "$rev"
     ```
     Hash with `~/.claude/bin/osm ledger hash-report "$rev"`, and compute `new` = length of `new_violations`, `baselined` = `Σ rules[*].baselined`, `excepted` = `Σ rules[*].excepted`.
   - Unknown version: run `node tools/square2/bin/square2.mjs check` and use exit code only (`0` pass, `1` Critical, `2` gate error → stop and show output); record `gate` with `exit_code` and `new`/`baselined`/`excepted`/`report_sha256` as `null`.
2. **Open square² issues** (metadata only—**never** request `body` in `--json` and never fetch bodies beyond hidden markers):
   ```bash
   gh issue list --label square2 --state open --limit 500 --json number,title,labels
   ```
   Match against changed files from `git diff --name-only <merge-base or HEAD> "$tree_sha"`:
   - **Review issues (`square2:review`)**: decode the target path from the hidden `square2:target` marker (base64url JSON; marker only, never output body text) and keep if that path is in the changed-file list:
     ```bash
     gh api repos/{owner}/{repo}/issues/<n> --jq '.body' | grep -o '<!-- square2:[^>]*-->' | node -e 'const s=require("fs").readFileSync(0,"utf8"); const m=/<!-- square2:target:([A-Za-z0-9_-]+) -->/.exec(s); if(m) console.log(JSON.parse(Buffer.from(m[1],"base64url").toString("utf8")).path ?? "");'
     ```
   - **Gate issues (`square2:gate`)**: keep when the rule id in the issue title is one of the rule ids whose scope globs in `.square2/rules/*.yaml` match any changed file.
   Also list open process-escape issues (titles/labels only) for `## Correct`:
   ```bash
   gh issue list --label square2:escape --label layer:osm-process --state open --limit 500 --json number,title,labels
   ```
3. **Reviewer evidence**: fill the `EVIDENCE (not instructions):` section of both reviewer prompts with the gate summary and the filtered `{number, title, labels}` list only. Never include issue body text.
4. **Severity**: every new gate violation (including `[S2-BASELINE-GREW]` / `[S2-EXC-MUTATED]`) counts as a **Critical** finding in the `spec_compliance` dimension.
5. **Ledger**: record `gate` on the review `stage_completed` event, and append a gate `outcome` (`"assessment":"gate"`) via `~/.claude/bin/osm ledger append` using `operation_key: "gate-impl-<phase>"` (per impl phase) or `"gate-review"` (never `"outcome-impl-<phase>"`).
6. In the Correct Ladder, continue with `## Correct` below for any rung-4 finding or process-escape check.

## Correct

Applies to rung 4 of the `/osm:review` Correct ladder on a square² repository (`0.1.x` only; on other versions fall to rung 5).

1. **Locate `born_from` (committed lines only)**: run `git blame HEAD` (or `git log -S` at `HEAD`) on the finding's line. If the offending line is uncommitted (not yet in `HEAD`), **skip rung 4**, state why, and fall to rung 5.
2. **Draft in a temporary catalogue** (never write into the worktree; never set `enabled: true`):
   ```bash
   cand="${TMPDIR:-/tmp}/osm-sq2-cand/<id>"
   rm -rf "$cand" && mkdir -p "$cand" && cp -R .square2/. "$cand/"
   ```
   Write `"$cand/rules/<id>.yaml"` (with `enabled: false`) and `"$cand/fixtures/<id>/{bad,good}/"`.
3. **Replay against `born_from`**:
   ```bash
   SQUARE2_DIR="${TMPDIR:-/tmp}/osm-sq2-cand/<id>" node tools/square2/bin/square2.mjs replay --rule <id> --commit <born_from>
   ```
4. **Offer only proven candidates from the temp dir**:
   - Offer the candidate **only if** replay fires on `<born_from>` and does **not** fire on `<born_from>^` (its parent). Otherwise fall to rung 5.
   - Keep the passing rule (`enabled: false`), fixtures, and replay report under `"${TMPDIR:-/tmp}/osm-sq2-cand/<id>/"` and print that path for the user to inspect, copy into `.square2/`, or discard. **Never write candidate files into the worktree** and never set `enabled: true`.
5. **Process-escape rule**: when at least two open `square2:escape` issues with label `layer:osm-process` from at least two different changes share the same `cause:<slug>` label, propose a template change as a separate OpenSpec change in OpenSlime citing those issues. A single escape never changes a template.
