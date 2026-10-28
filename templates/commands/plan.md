---
description: 'codex + antigravity 交叉分析 → 消除歧义 → 零决策可执行计划'
---
<!-- CCG:SPEC:PLAN:START -->
**Core Philosophy**
- The goal is to eliminate ALL decision points—implementation should be pure mechanical execution.
- Every ambiguity must be resolved into explicit constraints before proceeding.
- Multi-model collaboration surfaces blind spots and conflicting assumptions.
- Every requirement must have Property-Based Testing (PBT) properties—focus on invariants.

**Guardrails**
- Do not proceed to implementation until every ambiguity is resolved.
- Both {{BACKEND_PRIMARY}} and {{FRONTEND_PRIMARY}} analyses are mandatory, run independently.
- If constraints cannot be fully specified, escalate to user or return to research phase.
- Refer to `openspec/config.yaml` for project conventions.
- **USER GUIDANCE RULE**: When suggesting next steps to the user, ALWAYS use OSM commands (`/osm:research`, `/osm:plan`, `/osm:impl`, `/osm:review`). NEVER suggest `/opsx:*` commands to the user. If OpenSpec CLI returns error messages referencing OPSX skills, translate them to `/osm:*` equivalents.
- **TASKS FORMAT RULE**: When generating or modifying `tasks.md`, ALL tasks MUST use checkbox format (`- [ ] X.Y description`). Heading+bullet format will cause OpenSpec CLI to parse 0 tasks and block the workflow.
- **PHASE BOUNDARY**: This phase ONLY generates OPSX artifacts (specs.md, design.md, tasks.md). Do NOT modify any source code. Do NOT proceed to implementation. After artifacts are generated, STOP and inform the user: "Plan complete. Run `/osm:impl` to start implementation."

**Steps**
1. **Select Change**
   - Run `openspec list --json` to display Active Changes.
   - Confirm with user which change ID to refine.
   - Run `openspec status --change "<change_id>" --json` to review current state.

2. **Multi-Model Implementation Analysis (PARALLEL)**
   - Always run both {{BACKEND_PRIMARY}} and {{FRONTEND_PRIMARY}}, launched in ONE message with `run_in_background: true`. They answer independently; Claude cross-checks where they agree and disagree.
   - **工作目录**：`{{WORKDIR}}` **必须通过 Bash 执行 `pwd`（Unix）或 `cd`（Windows CMD）获取当前工作目录的绝对路径**，禁止从 `$HOME` 或环境变量推断。如果用户通过 `/add-dir` 添加了多个工作区，先确定任务相关的工作区。

   **Step 2.1**: Launch the calls below in ONE message:

   **FIRST Bash call ({{BACKEND_PRIMARY}})**:
   ```
   Bash({
     command: "~/.claude/bin/codeagent-wrapper --progress --backend {{BACKEND_PRIMARY}} {{GEMINI_MODEL_FLAG}}{{GROK_MODEL_FLAG}}{{KIMI_MODEL_FLAG}}{{OPENCODE_MODEL_FLAG}}- \"{{WORKDIR}}\" <<'EOF'\nAnalyze change <change_id> from backend perspective:\n- Implementation approach\n- Technical risks\n- Alternative architectures\n- Edge cases and failure modes\nOUTPUT: JSON with analysis\nEOF",
     run_in_background: true,
     timeout: 300000,
     description: "{{BACKEND_PRIMARY}}: backend analysis"
   })
   ```

   **SECOND Bash call ({{FRONTEND_PRIMARY}}) — same message**:
   ```
   Bash({
     command: "~/.claude/bin/codeagent-wrapper --progress --backend {{FRONTEND_PRIMARY}} {{GEMINI_MODEL_FLAG}}{{GROK_MODEL_FLAG}}{{KIMI_MODEL_FLAG}}{{OPENCODE_MODEL_FLAG}}- \"{{WORKDIR}}\" <<'EOF'\nAnalyze change <change_id> from frontend/integration perspective:\n- Maintainability assessment\n- Scalability considerations\n- Integration conflicts\nOUTPUT: JSON with analysis\nEOF",
     run_in_background: true,
     timeout: 300000,
     description: "{{FRONTEND_PRIMARY}}: integration analysis"
   })
   ```

   **Step 2.2**: Wait for every launched call to finish before synthesizing.

   - 后台调用完成时会自动通知，不要轮询。后端模型常需 5-15 分钟；超过 timeout 就报告用户，不要无限等待。
   - 某个模型失败：重试一次；仍失败就用另一方的结果继续，并在阶段报告里把置信度下调一档。

   - Synthesize responses and present consolidated options to user.

3. **Uncertainty Elimination Audit**
   - **{{BACKEND_PRIMARY}}**: "Review proposal for unspecified decision points. List each as: [AMBIGUITY] → [REQUIRED CONSTRAINT]"
   - **{{FRONTEND_PRIMARY}}**: "Identify implicit assumptions. Specify: [ASSUMPTION] → [EXPLICIT CONSTRAINT NEEDED]"

   **Anti-Pattern Detection** (flag and reject):
   - Information collection without decision boundaries
   - Technical comparisons without selection criteria
   - Deferred decisions marked "to be determined during implementation"

   **Target Pattern** (required for approval):
   - Explicit technology choices with parameters (e.g., "JWT with TTL=15min")
   - Concrete algorithm selections with configs (e.g., "bcrypt cost=12")
   - Precise behavioral rules (e.g., "Lock account 30min after 5 failed attempts")

   Iterate with user until ALL ambiguities resolved.

4. **PBT Property Extraction**
   - **{{BACKEND_PRIMARY}}**: "Extract PBT properties. For each requirement: [INVARIANT] → [FALSIFICATION STRATEGY]"
   - **{{FRONTEND_PRIMARY}}**: "Define system properties: [PROPERTY] | [DEFINITION] | [BOUNDARY CONDITIONS] | [COUNTEREXAMPLE GENERATION]"

   **Property Categories**:
   - **Commutativity/Associativity**: Order-independent operations
   - **Idempotency**: Repeated operations yield same result
   - **Round-trip**: Encode→Decode returns original
   - **Invariant Preservation**: State constraints maintained
   - **Monotonicity**: Ordering guarantees (e.g., timestamps increase)
   - **Bounds**: Value ranges, size limits, rate constraints

5. **Update OPSX Artifacts**
   - **BEFORE calling `/opsx:continue`** (internal skill call — do NOT expose this command to user), output a structured summary for OPSX context:
     ```markdown
     ## Planning Summary for OPSX

     **Multi-Model Analysis Results**:
     - {{BACKEND_PRIMARY}} (Backend): [Key findings and recommendations]
     - {{FRONTEND_PRIMARY}} (Frontend): [Key findings and recommendations]
     - Consolidated Approach: [Selected implementation strategy]

     **Resolved Constraints**:
     - [All explicit constraints from Step 3]

     **PBT Properties**:
     - [All extracted properties from Step 4 with falsification strategies]

     **Technical Decisions**:
     - [All finalized technology choices, algorithms, configurations]

     **Implementation Tasks**:
     - [High-level task breakdown ready for tasks.md]
     ```

   - Then call `/opsx:continue` internally to generate next artifacts:
     ```
     /opsx:continue
     ```
   - The OPSX skill will use the above summary to create specs.md, design.md, and tasks.md.
   - **Note**: This is an internal call. If this step fails, guide the user to re-run `/osm:plan`.
   - **STOP**: After artifacts are generated, verify they exist and inform user:
     "Plan phase complete. Artifacts generated: specs.md, design.md, tasks.md. Run `/osm:impl` to start implementation."
     Do NOT proceed to modify source code.


**Exit Criteria**
A change is ready for implementation only when:
- [ ] Required model analyses completed and synthesized
- [ ] Zero ambiguities remain (verified by step 3 audit)
- [ ] All PBT properties documented with falsification strategies
- [ ] Artifacts (specs, design, tasks) generated via OpenSpec skills
- [ ] User has explicitly approved all constraint decisions

**Reference**
- Inspect change: `openspec status --change "<id>" --json`
- List changes: `openspec list --json`
- Search patterns: `rg -n "INVARIANT:|PROPERTY:" openspec/`
- Use `AskUserQuestion` for ANY ambiguity—never assume
**Stage report**: before finishing, write the `plan` report as specified in `~/.claude/.ccg/prompts/claude/osm-report.md` (read it then; temporary file, includes a confidence estimate).
<!-- CCG:SPEC:PLAN:END -->
