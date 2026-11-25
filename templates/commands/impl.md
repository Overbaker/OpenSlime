---
description: 'codex/antigravity 按任务写代码，Claude 监控审查 + 归档'
---
<!-- CCG:SPEC:IMPL:START -->
**Core Philosophy**
- Implementation is pure mechanical execution—all decisions were made in Plan phase.
- Writers: {{BACKEND_PRIMARY}} writes backend/logic/tests, {{FRONTEND_PRIMARY}} writes frontend/UI.
- Claude supervises: scopes each task, reviews the diff and decides who fixes what (see Fix Rules).
- Keep changes tightly scoped; enforce side-effect review before any modification.
- Minimize documentation—prefer self-explanatory code over comments.

**Guardrails**
- Every external call names the exact files it may change. Anything outside that list is reverted, not merged.
- **Fix Rules**:
  1. Mechanical, behavior-preserving fix of ≤5 lines (typo, import, rename, lint, type annotation): Claude fixes it, then re-runs the task's VERIFY command.
  2. Any change to logic, branches or interfaces, or more than 5 lines: `resume` the writer with `file:line`, the problem and the expected result.
  3. Writer failed twice or its CLI is unavailable: ask the user before Claude takes over the task.
- If the working tree holds unrelated uncommitted work, stop and ask the user before delegating.
- Keep implementation strictly within `tasks.md` scope—no scope creep.
- Refer to `openspec/config.yaml` for conventions.
- **USER GUIDANCE RULE**: When suggesting next steps to the user, ALWAYS use OSM commands (`/osm:research`, `/osm:plan`, `/osm:impl`, `/osm:review`). NEVER suggest `/opsx:*` commands to the user. If OpenSpec CLI returns error messages referencing OPSX skills, translate them to `/osm:*` equivalents.
- **TASKS FORMAT RULE**: When generating or modifying `tasks.md`, ALL tasks MUST use checkbox format (`- [ ] X.Y description`). Heading+bullet format will cause OpenSpec CLI to parse 0 tasks and block the workflow.

**Steps**
1. **Select Change**
   - Run `openspec list --json` to inspect Active Changes.
   - Confirm with user which change ID to implement.
   - Run `openspec status --change "<change_id>" --json` to review tasks.

2. **Apply OPSX Change (Pre-flight Check)**
   - Call `/opsx:apply` internally to enter implementation mode:
     ```
     /opsx:apply
     ```
   - This will load the change context and guide you through the tasks defined in `tasks.md`.
   - **Note**: This is an internal call. If this step fails, guide the user to re-run `/osm:impl`.
   - **HARD GATE**: Check the returned `state` field:
     - If `state: "blocked"` → STOP immediately. Inform the user which artifacts are missing and suggest: "Run `/osm:plan` to generate missing artifacts first."
     - If `progress.total === 0` → STOP immediately. Inform: "tasks.md has no parseable tasks. Run `/osm:plan` to regenerate."
     - Only proceed to Step 3 when `state: "ready"` and `progress.total > 0`.

3. **Identify Minimal Verifiable Phase**
   - Review `tasks.md` and identify the **smallest verifiable phase**.
   - Do NOT complete all tasks at once—control context window.
   - Announce: "Implementing Phase X: [task group name]"
   - If `.square2/` exists in the target repository or on any remote-tracking branch, read `~/.claude/.ccg/prompts/claude/osm-square2.md` §Impl.

4. **Delegate Each Task**
   - **{{BACKEND_PRIMARY}}** — backend/logic/algorithm/tests. **{{FRONTEND_PRIMARY}}** — frontend/UI/styling only.
   - **Lessons and probes**: read `~/.claude/.ccg/prompts/claude/osm-ledger.md` once per phase. Per task, query lessons and add at most 2 adopted lines to the brief as `LESSONS:`. When a trial lesson matches and the budget allows, run the probe it describes. `--compare` (without `explore`) forces a probe, `--compare explore` runs only the comparison below, and `--no-probe` suppresses probes.
   - **Frozen VERIFY**: compute `verify_sha256` (`sha256` of the task's planned single-line VERIFY command; record on ledger `stage_completed` as hex or `{task_id: hex}` map). The writer records `base_tree=$(~/.claude/bin/osm verify-guard --print-tree)` immediately before its **first** VERIFY run and reports it as `base <sha>` in the evidence block; Claude stores that reported `base_tree` (if missing, Claude records it immediately before the first VERIFY Claude runs itself). A fix round may not change VERIFY unless a ledger `human_decision` records the old text, new text and reason; otherwise reject the round and restore the planned VERIFY.

   **工作目录**：`{{WORKDIR}}` **必须通过 Bash 执行 `pwd`（Unix）或 `cd`（Windows CMD）获取当前工作目录的绝对路径**，禁止从 `$HOME` 或环境变量推断。如果用户通过 `/add-dir` 添加了多个工作区，先确定任务相关的工作区。

   For each task (independent tasks with disjoint files may go in one `--parallel` batch; use `dependencies:` for ordering):
   ```
   ~/.claude/bin/codeagent-wrapper --progress --backend <{{BACKEND_PRIMARY}}|{{FRONTEND_PRIMARY}}> {{GEMINI_MODEL_FLAG}}{{GROK_MODEL_FLAG}}{{KIMI_MODEL_FLAG}}{{OPENCODE_MODEL_FLAG}}- "{{WORKDIR}}" <<'EOF'
   ROLE_FILE: ~/.claude/.ccg/prompts/<model you call>/builder.md
   You are authorized to edit files in {{WORKDIR}} for this task only.
   TASK: <task from tasks.md>
   FILES YOU MAY CHANGE: <explicit list>
   CONSTRAINTS: <constraints and PBT properties from the spec>
   VERIFY: <exact single-line command from tasks.md>
   FINGERPRINT: verify_sha256=<sha256>
   EOF
   ```
   Run it with `Bash({ ..., run_in_background: true, timeout: 3600000 })`; the same waiting rules as Step 6.2 apply. Save each returned `SESSION_ID` to resume the same writer for fixes.

   **Exploratory comparison writer** (only when `$ARGUMENTS` contains `--compare explore` or the user asks; doubles writing cost; recorded as a confounded probe and never credited to a lesson, see `~/.claude/.ccg/prompts/claude/osm-ledger.md`):
   - In the same message as the writer call, spawn one subagent: `Agent({ subagent_type: "general-purpose", isolation: "worktree", run_in_background: true, prompt })`. Main Claude and the main writer never load its skills or see its draft until review.
   - Its prompt: same TASK, FILES, CONSTRAINTS (with the PBT properties) and VERIFY. It decides on its own, in one line each: who writes (itself, or {{FRONTEND_PRIMARY}} via `~/.claude/bin/codeagent-wrapper --backend {{FRONTEND_PRIMARY}}` inside its worktree) and which installed skill, if any, to load for this task. Then it writes, runs VERIFY, and reports: choice + reason, absolute worktree path, base commit (`git rev-parse HEAD` before writing), diff summary, VERIFY output. It must not touch the main working tree.
   - The worktree starts from `HEAD`: skip comparison for a task that depends on uncommitted earlier tasks.
   - Record the comparison worktree path and base commit from its report. Both diffs go to the cross review (Step 6). Keep the one that passes VERIFY with fewer Critical findings; on a tie keep the smaller diff. Only the kept result lands in the main tree.

5. **Review the Diff**
   - `git diff` the task's files. Revert edits outside the allowed list.
   - Check: within `tasks.md` scope, no unrelated modules touched, no new dependencies, existing interfaces intact.
   - **VERIFY evidence**: accept a task **only** when the writer's report includes the VERIFY evidence block (`VERIFY <command>`, `exit 0  tree <sha7>  base <sha>`, last ≤20 output lines showing the changed path ran) with `exit 0` and `<sha7>` equal to the first 7 chars of current `~/.claude/bin/osm verify-guard --print-tree`. Use the reported `base <sha>` as `base_tree`; if `base <sha>` is missing, record `base_tree=$(~/.claude/bin/osm verify-guard --print-tree)` right before Claude runs VERIFY itself. If missing, non-zero, or stale tree, treat as unverified and Claude re-runs VERIFY itself before accepting.
   - **Never-relax guard**: before accepting any fix round (after VERIFY has run once), confirm `verify_sha256` is unchanged and run `~/.claude/bin/osm verify-guard --base "$base_tree" --paths <files named by VERIFY>` using that recorded `base_tree` (omit `--paths` if VERIFY names no files). Any finding (exit 1) blocks the task until fixed or each `path:line` item is accepted via a ledger `human_decision`.
   - Apply the Fix Rules, then re-check the diff.

6. **Independent Review**
   - Always run both {{BACKEND_PRIMARY}} and {{FRONTEND_PRIMARY}}, launched in ONE message with `run_in_background: true`. They answer independently; Claude cross-checks where they agree and disagree.

   - **Lesson probe** (see osm-ledger.md): do not use the two prompts below. Use the neutral A/B prompts in osm-ledger.md step 5: no workdir, and none of the words main or comparison. Hold Step 5 fixes until the probe is scored. On a tie the main side lands.
   - With `--compare explore`, wait for both writers, then substitute the recorded absolute comparison worktree path and base commit into BOTH reviewer prompts below. Both reviewers must inspect both candidates before selection; without comparison, omit the comparison candidate instructions.

   **Step 6.1**: Launch the calls below in ONE message:

   **FIRST Bash call ({{BACKEND_PRIMARY}})**:
   ```
   Bash({
     command: "~/.claude/bin/codeagent-wrapper --progress --backend {{BACKEND_PRIMARY}} {{GEMINI_MODEL_FLAG}}{{GROK_MODEL_FLAG}}{{KIMI_MODEL_FLAG}}{{OPENCODE_MODEL_FLAG}}- \"{{WORKDIR}}\" <<'EOF'\nROLE_FILE: ~/.claude/.ccg/prompts/{{BACKEND_PRIMARY}}/reviewer.md\nReview the uncommitted changes for <task> against the spec constraints. Read callers of every changed function, not only the diff.\nMain candidate: {{WORKDIR}}; inspect `git -C \"{{WORKDIR}}\" diff` and its changed files. With --compare explore, also inspect comparison candidate at <worktree>, base commit <base>: `git -C \"<worktree>\" diff <base>` and its changed files. Report findings separately for each candidate, including candidate name on every finding.\nOUTPUT: JSON with findings per candidate\nEOF",
     run_in_background: true,
     timeout: 3600000,
     description: "{{BACKEND_PRIMARY}}: correctness/security review"
   })
   ```

   **SECOND Bash call ({{FRONTEND_PRIMARY}}) — same message**:
   ```
   Bash({
     command: "~/.claude/bin/codeagent-wrapper --progress --backend {{FRONTEND_PRIMARY}} {{GEMINI_MODEL_FLAG}}{{GROK_MODEL_FLAG}}{{KIMI_MODEL_FLAG}}{{OPENCODE_MODEL_FLAG}}- \"{{WORKDIR}}\" <<'EOF'\nROLE_FILE: ~/.claude/.ccg/prompts/{{FRONTEND_PRIMARY}}/reviewer.md\nIndependently review the uncommitted changes for <task>: logic, integration and security; UI states and accessibility if UI code changed.\nMain candidate: {{WORKDIR}}; inspect `git -C \"{{WORKDIR}}\" diff` and its changed files. With --compare explore, also inspect comparison candidate at <worktree>, base commit <base>: `git -C \"<worktree>\" diff <base>` and its changed files. Report findings separately for each candidate, including candidate name on every finding.\nOUTPUT: JSON with findings per candidate\nEOF",
     run_in_background: true,
     timeout: 3600000,
     description: "{{FRONTEND_PRIMARY}}: maintainability/patterns review"
   })
   ```

   **Step 6.2**: Wait for every launched call to finish before synthesizing.

   - 后台调用完成时会自动通知，不要轮询。后端模型常需 5-15 分钟，timeout 上限 60 分钟。到时仍未完成：报告用户并询问是否继续等待，不要自行杀掉后台任务。
   - 某个模型失败：重试一次；仍失败就用另一方的结果继续，并在阶段报告里把置信度下调一档。
   - 输出含 `STALLED:` 或 `INCOMPLETE:`（wrapper 判定后端停滞或中断）：用返回的 `SESSION_ID` 执行一次 `resume <SESSION_ID>` 并说"继续"；没有 SESSION_ID 就重新发起一次。这算该模型的那一次重试。

   - Use a fresh session (no `resume`): the writer reviewing its own work misses the same things twice.
   - With `--compare explore`, cross-check both reviewers' findings per candidate, then pick the candidate that passes VERIFY with fewer Critical findings (smaller diff on a tie). Only then bring the kept result into the main tree, and re-run the post gate (if loaded in Step 3) on the kept candidate after selection.
   - Handle Critical and Warning findings with the Fix Rules, then review the changed files again in a fresh session. Stop after 3 rounds and report to the user.

7. **Update Task Status**
   - Mark completed task in `tasks.md`: `- [x] Task description`
   - Commit only if the user asked for it.
   - When you do commit, end the message with the block below unless `$ARGUMENTS` contains `--no-trace`. Fill only what you know from this session; drop a line you cannot fill. Write `OSM-Reviewed: <tree_sha7> (Critical 0)` **only** when the committed tree equals the last `/osm:review` `tree_sha` with `critical_open = 0`—omit it otherwise (commits before the first `/osm:review` get no `OSM-Reviewed` trailer). Keep attribution lines your own instructions require, and put all trailers in one final block with no blank line inside it.
     ```
     via [OpenSlime](https://github.com/Overbaker/OpenSlime)

     OSM-Change: <change id>
     OSM-Specs: <capability names under the change's specs/, comma-separated>
     OSM-Writers: <backends that wrote the committed code; add claude if you fixed lines yourself>
     OSM-Reviewers: <backends whose review finished> (Critical <open count>)
     OSM-Reviewed: <tree_sha7> (Critical 0)
     ```
   - If you open a pull request for this change, end its description with the same block unless `$ARGUMENTS` contains `--no-trace`. Never write these lines, or any generated-by note, into source files, comments or docs.


8. **Archive on Completion**
    - This step is the sole archive owner. Compute the current `tree_sha` (snippet in `~/.claude/.ccg/prompts/claude/osm-report.md`). Archive only when ALL tasks in `tasks.md` are marked `[x]` and the current `tree_sha` equals the last `/osm:review` `tree_sha` with `critical_open = 0`. If any file changed after review or review has not passed with `critical_open = 0`, run `/osm:review` before archiving.
    - Call `/opsx:archive` internally to archive the change:
      ```
      /opsx:archive
      ```
    - This merges spec deltas to `openspec/specs/` and moves change to archive.
    - **Note**: This is an internal call. If archiving fails, guide the user to re-run `/osm:impl`.

**Reference**
- Check task status: `openspec status --change "<id>" --json`
- View active changes: `openspec list --json`
- Search existing patterns: `rg -n "function|class" <file>`

**Exit Criteria**
Implementation is complete when:
- [ ] All tasks in `tasks.md` marked `[x]`
- [ ] Independent reviews passed
- [ ] Side-effect review confirmed no regressions
- [ ] Change archived successfully
**Stage report**: before finishing, write the `impl` report (one per phase; include the comparison writer if used) as specified in `~/.claude/.ccg/prompts/claude/osm-report.md` (read it then; temporary file, includes a confidence estimate).
<!-- CCG:SPEC:IMPL:END -->
