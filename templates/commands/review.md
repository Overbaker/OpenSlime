---
description: '独立会话审查（codex 必选，antigravity 仅前端）→ Critical 必须修复 → 允许归档'
---
<!-- CCG:SPEC:REVIEW:START -->
**Core Philosophy**
- Dual-model cross-validation catches blind spots single-model review would miss.
- Critical findings SHOULD be addressed before proceeding.
- Review validates implementation against spec constraints and code quality.
- This is an independent review tool—can be used anytime, not tied to archive workflow.

**Guardrails**
- {{BACKEND_PRIMARY}} review is mandatory; {{FRONTEND_PRIMARY}} reviews only frontend/UI changes.
- Reviewers run in fresh sessions, never the session that wrote the code.
- Review scope is strictly limited to the proposal's changes—no scope creep.
- Refer to `openspec/config.yaml` for project conventions when reviewing OpenSpec proposals.

**Steps**
1. **Select Proposal**
   - Run `openspec list --json` to display Active Changes.
   - Confirm with user which proposal ID to review.
   - Run `openspec status --change "<proposal_id>" --json` to load spec and tasks.

2. **Collect Implementation Artifacts**
   - Identify all files modified by this proposal.
   - Use `git diff` to get change summary.
   - Load relevant spec constraints and PBT properties from `openspec/changes/<id>/specs/`.

3. **Multi-Model Review (PARALLEL)**
   - {{BACKEND_PRIMARY}} is required. Add {{FRONTEND_PRIMARY}} only when the change touches frontend/UI code or the user asks for a second opinion. When both run, launch them in ONE message with `run_in_background: true`.
   - **工作目录**：`{{WORKDIR}}` **必须通过 Bash 执行 `pwd`（Unix）或 `cd`（Windows CMD）获取当前工作目录的绝对路径**，禁止从 `$HOME` 或环境变量推断。如果用户通过 `/add-dir` 添加了多个工作区，先确定任务相关的工作区。

   **Step 3.1**: Launch the calls below in ONE message:

   **FIRST Bash call ({{BACKEND_PRIMARY}})**:
   ```
   Bash({
     command: "~/.claude/bin/codeagent-wrapper --progress --backend {{BACKEND_PRIMARY}} {{GEMINI_MODEL_FLAG}}{{GROK_MODEL_FLAG}}{{KIMI_MODEL_FLAG}}{{OPENCODE_MODEL_FLAG}}- \"{{WORKDIR}}\" <<'EOF'\nReview proposal <proposal_id> implementation:\n\n## {{BACKEND_PRIMARY}} Review Dimensions\n1. **Spec Compliance**: Verify ALL constraints from spec are satisfied\n2. **PBT Properties**: Check invariants, idempotency, bounds are correctly implemented\n3. **Logic Correctness**: Edge cases, error handling, algorithm correctness\n4. **Backend Security**: Injection vulnerabilities, auth checks, input validation\n5. **Regression Risk**: Callers broken by changed signatures or behavior\n\n## Rules\n- Read callers of every changed function and the tests, not only the diff.\n- Every finding needs a concrete case: this input or state leads to this wrong result. No case, no finding.\n- No style taste, no vague worries. Propose the smallest fix.\n\n## Output Format (JSON)\n{\n  \"findings\": [\n    {\n      \"severity\": \"Critical|Warning|Info\",\n      \"dimension\": \"spec_compliance|pbt|logic|security|regression\",\n      \"file\": \"path/to/file.ts\",\n      \"line\": 42,\n      \"description\": \"What is wrong\",\n      \"constraint_violated\": \"Constraint ID from spec (if applicable)\",\n      \"fix_suggestion\": \"How to fix\"\n    }\n  ],\n  \"passed_checks\": [\"List of verified constraints/properties\"],\n  \"summary\": \"Overall assessment\"\n}\nEOF",
     run_in_background: true,
     timeout: 300000,
     description: "{{BACKEND_PRIMARY}}: backend/logic review"
   })
   ```

   **OPTIONAL SECOND Bash call ({{FRONTEND_PRIMARY}}) — frontend/UI scope only, same message**:
   ```
   Bash({
     command: "~/.claude/bin/codeagent-wrapper --progress --backend {{FRONTEND_PRIMARY}} {{GEMINI_MODEL_FLAG}}{{GROK_MODEL_FLAG}}{{KIMI_MODEL_FLAG}}{{OPENCODE_MODEL_FLAG}}- \"{{WORKDIR}}\" <<'EOF'\nReview proposal <proposal_id> implementation:\n\n## {{FRONTEND_PRIMARY}} Review Dimensions\n1. **UI Correctness**: Broken loading/empty/error states, wrong data shown\n2. **Accessibility**: Keyboard, focus, labels, contrast\n3. **Integration Risk**: Cross-module impacts, dependency changes\n4. **Frontend Security**: XSS, CSRF, sensitive data exposure\n5. **Spec Alignment**: Implementation matches spec intent (not just letter)\n\n## Rules\n- Read callers of every changed function and the tests, not only the diff.\n- Every finding needs a concrete case: this input or state leads to this wrong result. No case, no finding.\n- No style taste, no vague worries. Propose the smallest fix.\n\n## Output Format (JSON)\n{\n  \"findings\": [\n    {\n      \"severity\": \"Critical|Warning|Info\",\n      \"dimension\": \"ui|a11y|integration|security|alignment\",\n      \"file\": \"path/to/file.ts\",\n      \"line\": 42,\n      \"description\": \"What is wrong\",\n      \"spec_reference\": \"Spec section (if applicable)\",\n      \"fix_suggestion\": \"How to fix\"\n    }\n  ],\n  \"passed_checks\": [\"List of verified aspects\"],\n  \"summary\": \"Overall assessment\"\n}\nEOF",
     run_in_background: true,
     timeout: 300000,
     description: "{{FRONTEND_PRIMARY}}: patterns/integration review"
   })
   ```

   **Step 3.2**: Wait for every launched call to finish before synthesizing.

   - 后台调用完成时会自动通知，不要轮询。后端模型常需 5-15 分钟；超过 timeout 就报告用户，不要无限等待。
   - 前端模型失败：说明原因，用后端结果继续，不重试。

4. **Synthesize Findings**
   - Merge findings from both models.
   - Deduplicate overlapping issues.
   - Classify by severity:
     * **Critical**: Spec violation, security vulnerability, breaking change → MUST fix
     * **Warning**: Risky logic without a test, real slowness, duplicated logic → SHOULD fix
     * **Info**: Minor improvement suggestion → MAY fix

5. **Present Review Report**
   - Display findings grouped by severity:
   ```
   ## Review Report: <proposal_id>

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
     * Do NOT allow archiving.

   - **If Critical = 0**:
     * Ask user: "All critical checks passed. Proceed to archive?"
     * If Warning > 0, recommend addressing before archive.

7. **Optional: Inline Fix Mode**
   - If user chooses "Fix now" for Critical issues:
     * Route each fix to appropriate model (backend→{{BACKEND_PRIMARY}}, frontend→{{FRONTEND_PRIMARY}}).
     * Apply fix using unified diff patch pattern.
     * Re-run affected review dimension.
     * Repeat until Critical = 0.


**Exit Criteria**
Review is complete when:
- [ ] Required reviews completed
- [ ] All findings synthesized and classified
- [ ] Zero Critical issues remain (fixed or user-acknowledged)
- [ ] User decision captured (archive / return to impl / defer)

**Reference**
- View proposal: `openspec status --change "<id>" --json`
- Check spec constraints: `rg -n "CONSTRAINT:|MUST|INVARIANT:" openspec/changes/<id>/specs/`
- View implementation diff: `git diff`
- Archive (after passing): `/osm:impl` → Step 10
<!-- CCG:SPEC:REVIEW:END -->
