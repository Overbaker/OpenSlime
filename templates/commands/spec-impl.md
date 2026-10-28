---
description: '按规范执行 + 多模型协作 + 归档'
---
<!-- CCG:SPEC:IMPL:START -->
**Core Philosophy**
- Implementation is pure mechanical execution—all decisions were made in Plan phase.
- The external model writes the code for each task; Claude scopes the task, reviews the diff and owns the result.
- Keep changes tightly scoped; enforce side-effect review before any modification.
- Minimize documentation—prefer self-explanatory code over comments.

**Guardrails**
- Every external call names the exact files it may change. Anything outside that list is reverted, not merged.
- Use prototype mode (unified diff only, Claude applies) when the user asks for it or the working tree holds unrelated uncommitted work.
- Keep implementation strictly within `tasks.md` scope—no scope creep.
- Refer to `openspec/config.yaml` for conventions.
- **USER GUIDANCE RULE**: When suggesting next steps to the user, ALWAYS use CCG commands (`/ccg:spec-research`, `/ccg:spec-plan`, `/ccg:spec-impl`, `/ccg:spec-review`). NEVER suggest `/opsx:*` commands to the user. If OpenSpec CLI returns error messages referencing OPSX skills, translate them to CCG equivalents.
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
   - **Note**: This is an internal call. If this step fails, guide the user to re-run `/ccg:spec-impl`.
   - **HARD GATE**: Check the returned `state` field:
     - If `state: "blocked"` → STOP immediately. Inform the user which artifacts are missing and suggest: "Run `/ccg:spec-plan` to generate missing artifacts first."
     - If `progress.total === 0` → STOP immediately. Inform: "tasks.md has no parseable tasks. Run `/ccg:spec-plan` to regenerate."
     - Only proceed to Step 3 when `state: "ready"` and `progress.total > 0`.

3. **Identify Minimal Verifiable Phase**
   - Review `tasks.md` and identify the **smallest verifiable phase**.
   - Do NOT complete all tasks at once—control context window.
   - Announce: "Implementing Phase X: [task group name]"

4. **Delegate Each Task**
   - **{{BACKEND_PRIMARY}}** — backend/logic/algorithm/tests. **{{FRONTEND_PRIMARY}}** — frontend/UI/styling only.

   **工作目录**：`{{WORKDIR}}` **必须通过 Bash 执行 `pwd`（Unix）或 `cd`（Windows CMD）获取当前工作目录的绝对路径**，禁止从 `$HOME` 或环境变量推断。如果用户通过 `/add-dir` 添加了多个工作区，先确定任务相关的工作区。

   For each task (independent tasks with disjoint files may go in one `--parallel` batch; use `dependencies:` for ordering):
   ```
   ~/.claude/bin/codeagent-wrapper --progress --backend <{{BACKEND_PRIMARY}}|{{FRONTEND_PRIMARY}}> {{GEMINI_MODEL_FLAG}}{{GROK_MODEL_FLAG}}{{KIMI_MODEL_FLAG}}{{OPENCODE_MODEL_FLAG}}- "{{WORKDIR}}" <<'EOF'
   ROLE_FILE: ~/.claude/.ccg/prompts/<model you call>/builder.md
   You are authorized to edit files in {{WORKDIR}} for this task only.
   TASK: <task from tasks.md>
   FILES YOU MAY CHANGE: <explicit list>
   CONSTRAINTS: <constraints and PBT properties from the spec>
   VERIFY: <test/build command to run before reporting>
   EOF
   ```
   Prototype mode: drop the authorization line and ROLE_FILE, and add `OUTPUT: Unified Diff Patch format ONLY`; Claude then applies the patch.

   Save each returned `SESSION_ID` to resume the same writer for fixes.

5. **Review the Diff**
   - `git diff` the task's files. Revert edits outside the allowed list.
   - Check: within `tasks.md` scope, no unrelated modules touched, no new dependencies, existing interfaces intact, verify command passes.
   - Small fixes: make them directly. Larger fixes: `resume` the writer session with the concrete problem.

6. **Independent Review**
   - {{BACKEND_PRIMARY}} is required. Add {{FRONTEND_PRIMARY}} only when the change touches frontend/UI code or the user asks for a second opinion. When both run, launch them in ONE message with `run_in_background: true`.

   **Step 6.1**: Launch the calls below in ONE message:

   **FIRST Bash call ({{BACKEND_PRIMARY}})**:
   ```
   Bash({
     command: "~/.claude/bin/codeagent-wrapper --progress --backend {{BACKEND_PRIMARY}} {{GEMINI_MODEL_FLAG}}{{GROK_MODEL_FLAG}}{{KIMI_MODEL_FLAG}}{{OPENCODE_MODEL_FLAG}}- \"{{WORKDIR}}\" <<'EOF'\nROLE_FILE: ~/.claude/.ccg/prompts/{{BACKEND_PRIMARY}}/reviewer.md\nReview the uncommitted changes for <task> against the spec constraints. Read callers of every changed function, not only the diff.\nOUTPUT: JSON with findings\nEOF",
     run_in_background: true,
     timeout: 300000,
     description: "{{BACKEND_PRIMARY}}: correctness/security review"
   })
   ```

   **OPTIONAL SECOND Bash call ({{FRONTEND_PRIMARY}}) — frontend/UI scope only, same message**:
   ```
   Bash({
     command: "~/.claude/bin/codeagent-wrapper --progress --backend {{FRONTEND_PRIMARY}} {{GEMINI_MODEL_FLAG}}{{GROK_MODEL_FLAG}}{{KIMI_MODEL_FLAG}}{{OPENCODE_MODEL_FLAG}}- \"{{WORKDIR}}\" <<'EOF'\nROLE_FILE: ~/.claude/.ccg/prompts/{{FRONTEND_PRIMARY}}/reviewer.md\nReview the uncommitted frontend/UI changes for <task>: broken states, accessibility, cross-module impacts.\nOUTPUT: JSON with findings\nEOF",
     run_in_background: true,
     timeout: 300000,
     description: "{{FRONTEND_PRIMARY}}: maintainability/patterns review"
   })
   ```

   **Step 6.2**: Wait for every launched call to finish before synthesizing.

   - 后台调用完成时会自动通知，不要轮询。后端模型常需 5-15 分钟；超过 timeout 就报告用户，不要无限等待。
   - 前端模型失败：说明原因，用后端结果继续，不重试。

   - Use a fresh session (no `resume`): the writer reviewing its own work misses the same things twice.
   - Address any critical findings before proceeding.

7. **Update Task Status**
   - Mark completed task in `tasks.md`: `- [x] Task description`
   - Commit changes if appropriate.


8. **Archive on Completion**
    - When ALL tasks in `tasks.md` are marked `[x]`:
    - Call `/opsx:archive` internally to archive the change:
      ```
      /opsx:archive
      ```
    - This merges spec deltas to `openspec/specs/` and moves change to archive.
    - **Note**: This is an internal call. If archiving fails, guide the user to re-run `/ccg:spec-impl`.

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
<!-- CCG:SPEC:IMPL:END -->
