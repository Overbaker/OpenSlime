# OpenSlime

基于 OpenSpec 的极简 Claude 主导多 agent 协同开发框架；Claude 统筹编排，Codex 编写后端，Antigravity 编写前端。

[fengshao1227/ccg-workflow](https://github.com/fengshao1227/ccg-workflow) 的精简 fork（MIT）。[English](README.md)

## 让 AI Agent 安装

将以下内容发送给你的 AI coding agent（Claude Code、Codex）：

```text
Install OpenSlime from https://github.com/Overbaker/OpenSlime. Follow AGENTS.md in that repo, then run its doctor check and tell me the result.
```

手动安装步骤详见 [AGENTS.md](AGENTS.md)。

## 工作流程

1. `/osm:init`：配置 OpenSpec 并检查模型 CLI。
2. `/osm:research`：需求分析 &rarr; 约束提取与 OpenSpec 提案。
3. `/osm:plan`：零决策方案设计（specs、design、`tasks.md`）。
4. `/osm:impl`：分发执行各任务。
5. `/osm:review`：归档前的独立会话复审。

- **`/osm:impl` 角色分工**：`codex` 编写后端/逻辑/测试；`antigravity` 编写前端/UI（仅限 UI 范围）。每个任务显式列出执行者允许修改的文件白名单。
- **Claude 监督审查**：Claude 划定任务范围并审查代码 diff。
- **修复规则（Fix Rules）**：保持行为不变的 &le;5 行机械性修改（拼写、import、类型标注等）由 Claude 直接修复并重新执行 `VERIFY`；涉及逻辑、分支、接口变更或 >5 行的问题通过 `resume` 退回原执行者修改；同一执行者连续失败 2 次后 Claude 征求用户意见再决定是否接管。
- **独立审查**：审查在全新的独立会话中运行，且该会话未参与代码编写。
- **可选对比模式**：`/osm:impl --compare[=<skill>]` 会在独立 git worktree 中启动 Claude 子 agent 编写同一任务（可指定加载 skill）；复审者选择通过 `VERIFY` 且 Critical 缺陷更少的结果（双倍编写成本，适用于高风险任务）。

## 为何轻量

- **无每轮注入**：唯一常驻文本是一个精简规则文件（`rules/ccg-codegraph.md`）；无 hooks。内置技能（`frontend-design`、`scrapling`、`seo-page-builder`、`bt-panel`、`adsense-site-auditor`）仅在调用时按需加载。输出样式保留 Claude Code 内置的工程规范（`keep-coding-instructions: true`）。
- **单一主循环**：Claude 负责规划、决策并与用户交互，前面无路由层或多层规划 agent。
- **外部模型物尽其用**：仅在划定范围的代码编写（`codex` 后端、`antigravity` 前端）或新会话独立复审中调用外部模型。不支持把 DeepSeek Harness 作为宿主；保留 Codex 主导模式（`node bin/ccg.mjs codex-mode install`）与所有 wrapper 后端（`codex`、`claude`、`gemini`、`antigravity`、`grok`、`kimi`、`opencode`）。

设计原则详见 [PRINCIPLES.md](PRINCIPLES.md)，上游移除组件与原因详见 [FORK.md](FORK.md)。

## 环境要求

- Node.js 20+、pnpm、git、Claude Code。
- Codex CLI（`codex`，已登录）。
- 可选：Antigravity CLI（`agy`）。
- OpenSpec CLI：`npm i -g @fission-ai/openspec`（或由 `/osm:init` 自动引导安装）。

## 更新与卸载

```bash
# Update
cd ~/OpenSlime && git pull && pnpm install && pnpm build && node bin/ccg.mjs init --skip-prompt --skip-mcp --force

# Uninstall
cd ~/OpenSlime && node bin/ccg.mjs uninstall
```

> 致谢：上游 [fengshao1227/ccg-workflow](https://github.com/fengshao1227/ccg-workflow) 及其贡献者；[stellarlinkco/myclaude](https://github.com/stellarlinkco/myclaude)（codeagent-wrapper）；审查标准改编自 [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail)；输出形态精简自 [ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd)；ace-tool。均遵循 MIT 协议。许可证：MIT（[LICENSE](LICENSE)）。
