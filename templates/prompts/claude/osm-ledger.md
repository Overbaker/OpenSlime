# OpenSlime lessons and probes (Claude)

Read this once per `/osm:impl` phase and once per `/osm:review`.

The idea comes from Harness², kept small. A lesson is tried only on a challenger that differs from the main writer by that one lesson line. The two results are scored blind, and only the human adopts a lesson.

Every command here is `~/.claude/bin/osm ledger …`.

- **Skip this file entirely** (no lesson lines, no probes, no outcomes) in any of these cases: `$ARGUMENTS` contains `--no-ledger`, `~/.claude/bin/osm ledger status` prints `Ledger: off`, or `~/.claude/bin/osm ledger run-id` fails.
- **Otherwise get the run id first** (osm-report.md, Ledger §1) and use it for every event below.
- **A non-zero exit on any command here** means: note it in the report and go on without that step.

## Lessons in a brief (impl, per task)
- Run one query per task: `~/.claude/bin/osm ledger lessons query --files <task files, comma-separated> --kind <backend|frontend> --text "<task one-liner>"`. It prints at most 5 lines.
- Put at most **2** `adopted` lines into the main writer's brief, on one line: `LESSONS: <line>; <line>`.
- `trial` lessons never go into the main brief; they are tried only in a probe.
- If a line is marked `conflict`, show both lessons to the user before using either.

## When a probe runs
A probe tries one `trial` lesson against the unchanged main writer. Start one unasked only when **all** of these hold:
- a trial lesson from the query fits the task (say why in one line);
- the task has a VERIFY command and is not docs-only;
- `git status --porcelain -- . ':(exclude)openspec'` is empty, so the change's own OpenSpec docs don't count. Earlier code tasks must be committed; otherwise record `dirty-base`;
- unforced probes so far number fewer than **2** in this change and fewer than **3** in this session, and this lesson has had fewer than **2** probes in this change. Get the counts from `~/.claude/bin/osm ledger probes --change <change> [--lesson <id> --scope <project|global>]`; count this session's probes yourself;
- `$ARGUMENTS` has no `--no-probe`.

`--compare` without `explore` forces a probe; `--compare explore` never runs a lesson probe. A forced probe ignores the budget but still needs a clean tree and the same writer on both sides. When no trial lesson matches, print `no trial lesson matches; use --compare explore`.

When a trial lesson matches but a condition fails, record the skip:

```bash
~/.claude/bin/osm ledger append <<'JSON'
{"schema_version":1,"run_id":"<run id>","change_id":"<change>","stage":"impl","phase_id":"<phase>","kind":"probe","operation_key":"skip-<task>-<lesson>",
 "payload":{"lesson_id":"L-0007","lesson_scope":"project","mode":"lesson","skip_reason":"dirty-base","candidates":[],"interdiff_lines":null,"ab_map_recorded_after_reviews":null,"landed":null,"forced":false}}
JSON
```

`skip_reason` is one of `dirty-base`, `budget`, `no-verify` and `suppressed`.

## Probe procedure
1. **Worktree.** Create it with `git worktree add --detach "${TMPDIR:-/tmp}/osm-probe-<run>-<task>" HEAD`.
   - Make the main tree's gitignored dependencies visible in it before anything runs, e.g. `ln -s "$PWD/node_modules" <wt>/node_modules`. Do the same for `.venv` or `vendor` if they exist.
   - Then exclude each link, because `node_modules/` in `.gitignore` does not match a symlink: `echo /node_modules >> "$(git -C <wt> rev-parse --git-path info/exclude)"`.
   - Otherwise VERIFY fails for environmental reasons and the probe is void.
2. **Two writers in one message.** Launch the main writer and the challenger together.
   - Both use the same backend, model flag, `ROLE_FILE` and skill.
   - The challenger's brief is the main brief with two changes: the workdir path is the worktree, and one `LESSONS: <trial line>` is added. It runs in the worktree.
3. **Fingerprint.** For each side, take `sha256` of: writer, model flag, role file, skill, base commit, VERIFY command, and the brief.
   - Before hashing the brief, remove its `LESSONS:` line and replace its workdir path with `<WORKDIR>`.
   - If the two fingerprints differ, the probe is `confounded`.
4. **Score first attempts, before any fix.** Re-run VERIFY yourself in both trees. An environmental failure such as a missing dependency or `command not found` is recorded as `error`.
5. **Blind review.**
   - Symlink both trees as `"${TMPDIR:-/tmp}/osm-ab-<run>/A"` and `…/B`. Look at the first hex digit of `sha256(run_id + task)`: even puts main on A, odd puts main on B.
   - Both reviewers inspect both A and B. Their prompts contain no lesson text and none of the words main, comparison, champion or challenger. Use this shape for each reviewer (`ROLE_FILE` as usual):
     `Review two candidate solutions for <task> against the spec constraints. Candidate A: <ab>/A, inspect `git -C <ab>/A add -N . && git -C <ab>/A diff HEAD`. Candidate B: <ab>/B, the same. Read callers of every changed function. Report findings per candidate, each tagged A or B, with a concrete failing case. OUTPUT: JSON`
   - A finding is confirmed when both reviewers report it, or when one reports a concrete case that you reproduce.
6. **Record**, only after both reviews. The CLI computes the result, and it retires a losing lesson by itself:

```bash
~/.claude/bin/osm ledger append <<'JSON'
{"schema_version":1,"run_id":"<run id>","change_id":"<change>","stage":"impl","phase_id":"<phase>","kind":"probe","operation_key":"probe-<task>",
 "payload":{"lesson_id":"L-0007","lesson_scope":"project","mode":"lesson","skip_reason":null,"forced":false,"interdiff_lines":16,"ab_map_recorded_after_reviews":true,"landed":"B",
  "candidates":[{"label":"A","has_lesson":false,"fingerprint":"<sha>","verify":"passed","critical_confirmed":1,"warning_confirmed":0,"diff_lines":45},
                {"label":"B","has_lesson":true,"fingerprint":"<sha>","verify":"passed","critical_confirmed":0,"warning_confirmed":0,"diff_lines":61}]}}
JSON
```

   - `interdiff_lines` counts the lines that differ between the two candidates. Count the diffs with new files included: run `git add -A` in each tree, then `git diff --cached HEAD`. The interdiff is `diff <(git -C <main> diff --cached HEAD) <(git -C <wt> diff --cached HEAD) | grep -c '^[<>]'`.
   - The result is decided by VERIFY first, then confirmed Criticals, then confirmed Warnings. Diff size never counts.
   - On a tie, the main side lands.
7. **Land.**
   - Apply the Fix Rules only to the side that lands.
   - If the challenger won, take its full diff (new files included), clear the main writer's edits to the task files, then apply:
     `git -C <wt> add -A && git -C <wt> diff --cached HEAD --binary > "${TMPDIR:-/tmp}/osm-probe.patch" && git reset -q --hard HEAD && git clean -fdq -- <task files> && git apply "${TMPDIR:-/tmp}/osm-probe.patch"`. The reset is safe here because a probe starts only from a clean tree.
   - Then run `git worktree remove --force <path>`, and `git worktree prune` at the end of the phase.

## What the user sees
After a credited probe, show at most 12 lines in chat and in the impl report:

```
Probe · task 2.3 · L-0007 trial → W3 L0 T1 (ask at W≥4, W−L≥3, wins from ≥2 changes)
Input differs only by:  + LESSONS: <line>
Held equal: writer codex · skill none · base 1a2b3c4 · VERIFY `pnpm test` · reviewers blind (A/B)
                  VERIFY  Critical  Warning  diff
  without lesson  pass    1         0        +42 −3
  with lesson     pass    0         0        +58 −3
Output differs in: parser.test.ts +16 — tests parse("") → the crash behind C1
Result: WIN · landed: with lesson · event 9f3e…
```

- Use raw counts, never percentages.
- List at most 3 interdiff bullets, each tied to a VERIFY result or a confirmed finding.
- An inert, void or confounded probe gets one line: `L-0007: <result> — not credited`.
- After each credited probe, run `~/.claude/bin/osm ledger lessons show <id> [--scope global]`. If its tally now meets the bar, ask the adoption questions below in this phase.
  - Project lesson: W≥4, W−L≥3, wins from ≥2 changes, no severe loss.
  - Global lesson in this project: W≥2, L=0.

## Adoption: blind first, then reveal
When a lesson reaches the bar (see above), or `~/.claude/bin/osm ledger summary` lists it under **pending adoption**, ask two `AskUserQuestion` questions. Record both as `human_decision` events.

1. **Blind pick.**
   - Show the most informative interdiff, at most 20 lines, as X and Y in random order.
   - The option ids are `with-lesson`, `without-lesson` and `cant-tell`. List them in shown order: the id of X's side, the id of Y's side, then `cant-tell`. Labels are X, Y and "can't tell".
   - `decision_id` is `blind-<id>` with `blind: true`. Give no recommendation.
2. **Reveal.**
   - Say which side had the lesson.
   - Show the tally with losses and inert results first, then the brief diff `+LESSONS: <line>`.
   - Option ids: `adopt`, `keep-trial`, `retire`.
   - `decision_id` is `reveal-<id>`, or `reveal-global-<id>` for a global lesson.
   - Mark a recommendation only if the blind pick was `with-lesson`.

Then act on the answer:
- `adopt`: run `~/.claude/bin/osm ledger lessons adopt <id> [--scope global] --decision <reveal event id> --confirm`.
- `retire`: run `lessons retire <id> [--scope global] --reason "user: <why>"`. Add `--scope global` for a global lesson.
- Silence or `keep-trial`: change nothing.

## `--compare explore`
This is the old self-routing comparison. It is recorded as a probe with `"mode":"explore"`, `"lesson_id":null` and `"lesson_scope":null`, and it is never credited to a lesson. Its brief includes the task's CONSTRAINTS and PBT properties. If it wins, you may propose a candidate lesson (see Review) that cites the probe's event id.

## Review (in `/osm:review`)
1. **Outcomes.** Once both reviews are synthesized, append an `outcome` for the plan and for every impl phase of this change.
   - Set `"assessment":"review"` and `"critical_count"`.
   - `"result"` is `"passed"` when no Critical remains, otherwise `"failed"`.
   - Use `"target":{"change_id":"<change>","stage":"impl","phase_id":"<phase>"}`, or `"stage":"plan","phase_id":null` for the plan.
   - Set `operation_key` to `outcome-impl-<phase>` or `outcome-plan`.
   - Exit 2 with "no matching stage_completed" means that stage was not recorded: skip that target and continue.

```bash
~/.claude/bin/osm ledger append <<'JSON'
{"schema_version":1,"run_id":"<run id>","change_id":"<change>","stage":"review","phase_id":null,"kind":"outcome","operation_key":"outcome-impl-1",
 "payload":{"target":{"change_id":"<change>","stage":"impl","phase_id":"1"},"assessment":"review","result":"passed","critical_count":0}}
JSON
```
2. **Candidate lessons.** Propose at most **2** per review, and only from confirmed findings that one brief line would have prevented. Add each with `~/.claude/bin/osm ledger lessons add`, passing JSON on stdin with these fields:
   - `line`: one line of at most 160 characters, an instruction to the writer;
   - `cue`: when it applies;
   - `match`: `{globs, kind, keywords}`;
   - `evidence`: the event ids behind the finding;
   - `created_from`: `review <change> F<n>`.

   A new lesson starts as trial and only ever reaches challengers.
3. **Adopted lesson behind a Critical.** If a confirmed Critical traces to an adopted lesson's line, run `lessons retire <id> [--scope global] --reason "critical: <finding id>"`.
4. **OpenSlime's own rules.** Run `~/.claude/bin/osm ledger harness` once and copy any `revisit` lines (at most 5) into the review report. Never edit OpenSlime files because of them. Changing OpenSlime is its own `/osm:*` change that cites these numbers.
