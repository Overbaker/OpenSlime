---
description: '需求 → 约束集（codex + antigravity 交叉探索 + OpenSpec 提案）'
---
<!-- CCG:SPEC:RESEARCH:START -->
**Core Philosophy**
- Research produces **constraint sets**, not information dumps. Each constraint narrows the solution space.
- Constraints tell subsequent stages "don't consider this direction," enabling mechanical execution without decisions.
- Output: 约束集合 + 可验证的成功判据 (constraint sets + verifiable success criteria).
- Strictly adhere to OPSX rules when writing spec-structured documents.

**Guardrails**
- Use `{{MCP_SEARCH_TOOL}}` to minimize grep/find operations.
- Do not make architectural decisions—surface constraints that guide decisions.
- **USER GUIDANCE RULE**: When suggesting next steps to the user, ALWAYS use OSM commands (`/osm:research`, `/osm:plan`, `/osm:impl`, `/osm:review`). NEVER suggest `/opsx:*` commands to the user. If OpenSpec CLI returns error messages referencing OPSX skills, translate them to `/osm:*` equivalents.
- **PHASE BOUNDARY**: This phase ONLY generates the OPSX proposal artifact. Do NOT modify any source code. Do NOT proceed to planning or implementation. After the proposal is generated, STOP and inform the user: "Research complete. Run `/osm:plan` to continue."

**Steps**
1. **Clarify the Requirement**
   - Restate $ARGUMENTS as goal, scope, constraints and acceptance criteria in a few lines. Ask only about gaps that change the outcome.

2. **Generate OPSX Change**
   - Check if change already exists:
     ```bash
     openspec list --json
     ```
   - If change doesn't exist, create it:
     ```bash
     openspec new change "<brief-descriptive-name>"
     ```
   - This scaffolds `openspec/changes/<name>/` with proposal.md.
   - If change already exists, continue with existing change.

3. **Initial Codebase Assessment**
   - Use `{{MCP_SEARCH_TOOL}}` to scan codebase.
   - Determine project scale: single vs multi-directory structure.

4. **Parallel Multi-Model Exploration**
   - Always run both {{BACKEND_PRIMARY}} and {{FRONTEND_PRIMARY}}, launched in ONE message with `run_in_background: true`. They answer independently; Claude cross-checks where they agree and disagree.
   - **工作目录**：`{{WORKDIR}}` **必须通过 Bash 执行 `pwd`（Unix）或 `cd`（Windows CMD）获取当前工作目录的绝对路径**，禁止从 `$HOME` 或环境变量推断。如果用户通过 `/add-dir` 添加了多个工作区，先确定任务相关的工作区。

   **Output Template** (instruct both models to use this format):
   ```json
   {
     "module_name": "context boundary explored",
     "existing_structures": ["key patterns found"],
     "existing_conventions": ["standards in use"],
     "constraints_discovered": ["hard constraints limiting solution space"],
     "open_questions": ["ambiguities requiring user input"],
     "dependencies": ["cross-module dependencies"],
     "risks": ["potential blockers"],
     "success_criteria_hints": ["observable success behaviors"]
   }
   ```

   **Step 4.1**: Launch the calls below in ONE message:

   **FIRST Bash call ({{BACKEND_PRIMARY}} — backend boundaries)**:
   ```
   Bash({
     command: "~/.claude/bin/codeagent-wrapper --progress --backend {{BACKEND_PRIMARY}} {{GEMINI_MODEL_FLAG}}{{GROK_MODEL_FLAG}}{{KIMI_MODEL_FLAG}}{{OPENCODE_MODEL_FLAG}}- \"{{WORKDIR}}\" <<'EOF'\nExplore backend context boundaries for <change description>:\n- Existing structures and patterns\n- Conventions in use\n- Hard constraints limiting solution space\n- Dependencies and risks\nOUTPUT: JSON using the output template above\nEOF",
     run_in_background: true,
     timeout: 300000,
     description: "{{BACKEND_PRIMARY}}: backend boundary exploration"
   })
   ```

   **SECOND Bash call ({{FRONTEND_PRIMARY}}) — same message**:
   ```
   Bash({
     command: "~/.claude/bin/codeagent-wrapper --progress --backend {{FRONTEND_PRIMARY}} {{GEMINI_MODEL_FLAG}}{{GROK_MODEL_FLAG}}{{KIMI_MODEL_FLAG}}{{OPENCODE_MODEL_FLAG}}- \"{{WORKDIR}}\" <<'EOF'\nIndependently explore context boundaries for <change description> from the integration and user-facing side (frontend if any):\n- Existing structures and patterns\n- Conventions in use\n- Hard constraints limiting solution space\n- Dependencies and risks\nOUTPUT: JSON using the output template above\nEOF",
     run_in_background: true,
     timeout: 300000,
     description: "{{FRONTEND_PRIMARY}}: integration/user-facing exploration"
   })
   ```

   **Step 4.2**: Wait for every launched call to finish before synthesizing.

   - 后台调用完成时会自动通知，不要轮询。后端模型常需 5-15 分钟；超过 timeout 就报告用户，不要无限等待。
   - 某个模型失败：重试一次；仍失败就用另一方的结果继续，并在阶段报告里把置信度下调一档。

5. **Aggregate and Synthesize**
   - Collect both model outputs.
   - Merge into unified constraint sets:
     * **Hard constraints**: Technical limitations, patterns that cannot be violated
     * **Soft constraints**: Conventions, preferences, style guides
     * **Dependencies**: Cross-module relationships affecting implementation order
     * **Risks**: Blockers needing mitigation

6. **User Interaction for Ambiguity Resolution**
   - Compile prioritized list of open questions.
   - Use `AskUserQuestion` tool to present systematically:
     * Group related questions
     * Provide context for each
     * Suggest defaults when applicable
   - Capture responses as additional constraints.

7. **Finalize OPSX Proposal**
   - **BEFORE calling `/opsx:continue`** (internal skill call — do NOT expose this command to user), output a structured summary for OPSX context:
     ```markdown
     ## Research Summary for OPSX

     **Discovered Constraints**:
     - [List all hard and soft constraints from Step 5]

     **Dependencies**:
     - [List cross-module dependencies]

     **Risks & Mitigations**:
     - [List identified risks and mitigation strategies]

     **Success Criteria**:
     - [List verifiable success behaviors]

     **User Confirmations**:
     - [List all user decisions from Step 6]
     ```

   - Then call `/opsx:continue` internally to generate proposal artifact:
     ```
     /opsx:continue
     ```
   - The OPSX skill will use the above summary to write proposal.md.
   - **Note**: This is an internal call. If this step fails, guide the user to re-run `/osm:research`.
   - **STOP**: After proposal is generated, verify it exists and inform user:
     "Research phase complete. Proposal generated. Run `/osm:plan` to continue planning."
     Do NOT proceed to planning or implementation.


**Reference**
- OPSX CLI: `openspec status --change "<id>" --json`, `openspec list --json`
- Check prior research: `ls openspec/changes/*/`
- Use `AskUserQuestion` for ANY ambiguity—never assume or guess
**Stage report**: before finishing, write the `research` report as specified in `~/.claude/.ccg/prompts/claude/osm-report.md` (read it then; temporary file, includes a confidence estimate).
<!-- CCG:SPEC:RESEARCH:END -->
