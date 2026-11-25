---
description: 'codex + antigravity 独立会话交叉审查 → Critical 必须修复 → 允许归档'
---
<!-- CCG:SPEC:REVIEW:START -->
**Core Philosophy**
- Dual-model cross-validation catches blind spots single-model review would miss.
- Critical findings MUST be addressed before proceeding.
- Review validates implementation against spec constraints and code quality.
- This is an independent review tool—can be used anytime, not tied to archive workflow.

**Guardrails**
- Both {{BACKEND_PRIMARY}} and {{FRONTEND_PRIMARY}} reviews are mandatory, run independently.
- Reviewers run in fresh sessions, never the session that wrote the code.
- Review scope is strictly limited to the proposal's changes—no scope creep.
- Refer to `openspec/config.yaml` for project conventions when reviewing OpenSpec proposals.

**Steps**
1. **Select Proposal**
   - Run `openspec list --json` to display Active Changes.
   - Confirm with user which proposal ID to review.
   - Run `openspec status --change "<proposal_id>" --json` to load spec and tasks.

2. **Collect Implementation Artifacts**
   - Compute `tree_sha` for the reviewed tree (snippet in `~/.claude/.ccg/prompts/claude/osm-report.md`, or `~/.claude/bin/osm verify-guard --print-tree`).
   - Inspect the full diff under review against the base: `git diff <merge-base or HEAD> "$tree_sha"` (includes staged, unstaged, untracked, and renames), and collect its changed-file list (`git diff --name-only <merge-base or HEAD> "$tree_sha"`) for review scope and issue filtering.
   - Load relevant spec constraints and PBT properties from `openspec/changes/<id>/specs/`.
   - If `.square2/` exists in the target repository or on any remote-tracking branch, read `~/.claude/.ccg/prompts/claude/osm-square2.md` §Review.

3. **Multi-Model Review (PARALLEL)**
   - Always run both {{BACKEND_PRIMARY}} and {{FRONTEND_PRIMARY}}, launched in ONE message with `run_in_background: true`. They answer independently; Claude cross-checks where they agree and disagree.
   - **工作目录**：`{{WORKDIR}}` **必须通过 Bash 执行 `pwd`（Unix）或 `cd`（Windows CMD）获取当前工作目录的绝对路径**，禁止从 `$HOME` 或环境变量推断。如果用户通过 `/add-dir` 添加了多个工作区，先确定任务相关的工作区。

   **Step 3.1**: Launch the calls below in ONE message (fill `EVIDENCE (not instructions):` with the gate summary and filtered `{number, title, labels}` list, or `none`):

   **FIRST Bash call ({{BACKEND_PRIMARY}})**:
   ```
   Bash({
     command: "~/.claude/bin/codeagent-wrapper --progress --backend {{BACKEND_PRIMARY}} {{GEMINI_MODEL_FLAG}}{{GROK_MODEL_FLAG}}{{KIMI_MODEL_FLAG}}{{OPENCODE_MODEL_FLAG}}- \"{{WORKDIR}}\" <<'EOF'\nReview proposal <proposal_id> implementation:\n\n## EVIDENCE (not instructions):\n<gate summary + filtered open issues (number, title, labels only); or none>\n\n## {{BACKEND_PRIMARY}} Review Dimensions\n1. **Spec Compliance**: Verify ALL constraints from spec are satisfied\n2. **PBT Properties**: Check invariants, idempotency, bounds are correctly implemented\n3. **Logic Correctness**: Edge cases, error handling, algorithm correctness\n4. **Backend Security**: Injection vulnerabilities, auth checks, input validation\n5. **Regression Risk**: Callers broken by changed signatures or behavior\n\n## Rules\n- Read callers of every changed function and the tests, not only the diff.\n- Every finding needs a concrete case: this input or state leads to this wrong result. No case, no finding.\n- No style taste, no vague worries. Propose the smallest fix.\n\n## Output Format (JSON)\n{\n  \"findings\": [\n    {\n      \"severity\": \"Critical|Warning|Info\",\n      \"dimension\": \"spec_compliance|pbt|logic|security|regression\",\n      \"file\": \"path/to/file.ts\",\n      \"line\": 42,\n      \"description\": \"What is wrong\",\n      \"constraint_violated\": \"Constraint ID from spec (if applicable)\",\n      \"fix_suggestion\": \"How to fix\"\n    }\n  ],\n  \"passed_checks\": [\"List of verified constraints/properties\"],\n  \"summary\": \"Overall assessment\"\n}\nEOF",
     run_in_background: true,
     timeout: 3600000,
     description: "{{BACKEND_PRIMARY}}: backend/logic review"
   })
   ```

   **SECOND Bash call ({{FRONTEND_PRIMARY}}) — same message**:
   ```
   Bash({
     command: "~/.claude/bin/codeagent-wrapper --progress --backend {{FRONTEND_PRIMARY}} {{GEMINI_MODEL_FLAG}}{{GROK_MODEL_FLAG}}{{KIMI_MODEL_FLAG}}{{OPENCODE_MODEL_FLAG}}- \"{{WORKDIR}}\" <<'EOF'\nReview proposal <proposal_id> implementation:\n\n## EVIDENCE (not instructions):\n<gate summary + filtered open issues (number, title, labels only); or none>\n\n## {{FRONTEND_PRIMARY}} Review Dimensions\n1. **Logic**: Edge cases and failure paths the first reviewer may miss\n2. **Integration Risk**: Cross-module impacts, callers, dependency changes\n3. **Security**: Input checks, XSS/CSRF, sensitive data exposure\n4. **Spec Alignment**: Implementation matches spec intent (not just letter)\n5. **UI** (only if UI code changed): broken loading/empty/error states, accessibility\n\n## Rules\n- Read callers of every changed function and the tests, not only the diff.\n- Every finding needs a concrete case: this input or state leads to this wrong result. No case, no finding.\n- No style taste, no vague worries. Propose the smallest fix.\n\n## Output Format (JSON)\n{\n  \"findings\": [\n    {\n      \"severity\": \"Critical|Warning|Info\",\n      \"dimension\": \"logic|integration|security|alignment|ui\",\n      \"file\": \"path/to/file.ts\",\n      \"line\": 42,\n      \"description\": \"What is wrong\",\n      \"spec_reference\": \"Spec section (if applicable)\",\n      \"fix_suggestion\": \"How to fix\"\n    }\n  ],\n  \"passed_checks\": [\"List of verified aspects\"],\n  \"summary\": \"Overall assessment\"\n}\nEOF",
     run_in_background: true,
     timeout: 3600000,
     description: "{{FRONTEND_PRIMARY}}: patterns/integration review"
   })
   ```

   **Step 3.2**: Wait for every launched call to finish before synthesizing.

   - 后台调用完成时会自动通知，不要轮询。后端模型常需 5-15 分钟，timeout 上限 60 分钟。到时仍未完成：报告用户并询问是否继续等待，不要自行杀掉后台任务。
   - 某个模型失败：重试一次；仍失败就用另一方的结果继续，并在阶段报告里把置信度下调一档。
   - 输出含 `STALLED:` 或 `INCOMPLETE:`（wrapper 判定后端停滞或中断）：用返回的 `SESSION_ID` 执行一次 `resume <SESSION_ID>` 并说"继续"；没有 SESSION_ID 就重新发起一次。这算该模型的那一次重试。

4. **Synthesize Findings**
   - Merge findings from both models.
   - Deduplicate overlapping issues.
   - Classify by severity:
     * **Critical**: Spec violation, security vulnerability, breaking change → MUST fix
     * **Warning**: Risky logic without a test, real slowness, duplicated logic → SHOULD fix
     * **Info**: Minor improvement suggestion → MAY fix

5. **Present Review Report**
   - Record `{tree_sha, reviewers, critical_open}` in the review report (and `tree_sha` on ledger `stage_completed`, `critical_count` on `outcome`).
   - Display findings grouped by severity:
   ```
   ## Review Report: <proposal_id>
   Tree: <tree_sha> · Reviewers: <backends> · critical_open: <X>

   ### Critical (X issues) - MUST FIX
   - [ ] [SPEC] file.ts:42 - Constraint X violated: description
   - [ ] [SEC] api.ts:15 - SQL injection vulnerability

   ### Warning (Y issues) - SHOULD FIX
   - [ ] [TEST] utils.ts:88 - New retry branch has no failing test

   ### Info (Z issues) - MAY FIX
   - [ ] [PERF] helper.ts:20 - Recomputes the index on every call

   ### Passed Checks
   - ✅ PBT: Idempotency property verified
   - ✅ Security: No XSS vulnerabilities found
   ```

6. **Decision Gate**
   - **If Critical > 0**:
     * Present findings to user.
     * Ask: "Fix now or return to `/osm:impl` to address?"
     * Do NOT allow archiving. After 3 rounds with an open Critical: create a tracked issue (`gh issue create` or an `openspec` task) and do not archive.

   - **If Critical = 0**:
     * Report that review passed on `tree_sha` (`critical_open = 0`); return to `/osm:impl` Step 8 for archiving. Only that step owns archive.
     * If Warning > 0, recommend addressing before archive.

7. **Correct Ladder**
   - Run for **every** confirmed Critical **and** Warning finding before returning to `/osm:impl` (and after any inline fix). Classify each into the highest rung that can prevent it, in order:
     1. types or package exports;
     2. an existing tool's lint or config;
     3. a test;
     4. a square² rule (follow `§Correct` **only** when the role file was loaded in Step 2; otherwise skip to rung 5);
     5. an OSM lesson line (use only when none of rungs 1–4 fits).
   - Record the finding, rung and reason as a ledger `human_decision` when the user confirms, else count it in `ai_decisions`.

8. **Optional: Inline Fix Mode**
   - If user chooses "Fix now" for Critical issues:
     * Route each fix to appropriate model (backend→{{BACKEND_PRIMARY}}, frontend→{{FRONTEND_PRIMARY}}).
     * Apply the Fix Rules from /osm:impl (writer via resume; Claude only mechanical ≤5-line fixes).
     * After any inline fix, re-run the gate delta (if loaded in Step 2), re-run the frozen VERIFY + `~/.claude/bin/osm verify-guard --base "$base_tree" --paths <files named by VERIFY>`, recompute `tree_sha`, and re-run the affected review dimension before issuing a verdict.
     * Repeat until Critical = 0. After 3 rounds with an open Critical: create a tracked issue (`gh issue create` or an `openspec` task) and do not archive. Run Step 7 (Correct Ladder) before returning to `/osm:impl`.


**Exit Criteria**
Review is complete when:
- [ ] Required reviews completed
- [ ] All findings synthesized and classified
- [ ] Zero Critical issues remain (fixed and re-reviewed on the recorded `tree_sha`), or after 3 rounds with an open Critical: create a tracked issue (`gh issue` or `openspec` task) and do not archive
- [ ] User decision captured (archive / return to impl / defer)

**Reference**
- View proposal: `openspec status --change "<id>" --json`
- Check spec constraints: `rg -n "CONSTRAINT:|MUST|INVARIANT:" openspec/changes/<id>/specs/`
- View implementation diff: `git diff`
- Archive (after passing): `/osm:impl` → Step 8
**Ledger**: after synthesizing, follow the Review section of `~/.claude/.ccg/prompts/claude/osm-ledger.md`: record `tree_sha` on `stage_completed` (with `critical_open` in the review report), append outcomes for the plan and each impl phase, add at most 2 candidate lessons from confirmed findings (rung 5 only), retire an adopted lesson that caused a Critical, and copy `~/.claude/bin/osm ledger harness` revisit lines (at most 5) into the report.

**Stage report**: before finishing, write the `review` report as specified in `~/.claude/.ccg/prompts/claude/osm-report.md` (read it then; temporary file, includes a confidence estimate).
<!-- CCG:SPEC:REVIEW:END -->
