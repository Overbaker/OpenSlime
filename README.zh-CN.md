<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/openslime-lockup-dark.svg">
    <img src="assets/brand/openslime-lockup-light.svg" width="360" alt="OpenSlime">
  </picture>
</p>

<p align="center">
  <em>Claude 规划与审查，Codex 写后端，Antigravity 写前端。</em><br>
  <sub>基于 OpenSpec 的极简 Claude Code 多 agent 协同开发。</sub>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/for-Claude%20Code-111111?style=flat-square" alt="For Claude Code">
  <img src="https://img.shields.io/badge/built%20on-OpenSpec-111111?style=flat-square" alt="Built on OpenSpec">
  <img src="https://img.shields.io/badge/hooks-none-111111?style=flat-square" alt="No hooks">
  <img src="https://img.shields.io/badge/license-MIT-111111?style=flat-square" alt="MIT license">
</p>

<p align="center"><sub><a href="README.md">English</a> &middot; 简体中文</sub></p>

---

## 安装

把下面这段发给你的 coding agent（Claude Code、Codex）：

```text
Install OpenSlime from https://github.com/Overbaker/OpenSlime. Follow AGENTS.md in that repo, then run its doctor check and tell me the result.
```

手动安装见 [AGENTS.md](AGENTS.md)。

## 五个命令

| 命令 | 作用 |
| --- | --- |
| `/osm:init` | 配置 OpenSpec，检查模型 CLI。 |
| `/osm:research` | 需求 &rarr; 约束集 + OpenSpec 提案。 |
| `/osm:plan` | 零决策计划：specs、design、`tasks.md`。 |
| `/osm:impl` | 把任务交给执行者写，Claude 审查 diff。 |
| `/osm:review` | 归档前的独立会话复审。 |

## 工作方式

- **限定范围的执行者。** `/osm:impl` 中 `codex` 写后端、逻辑和测试，`antigravity` 写 UI；每个任务列出执行者可改的文件。
- **Claude 监督。** 不改变行为、&le;5 行的机械问题由 Claude 直接修并重跑 `VERIFY`；更大的改动通过 `resume` 退回执行者；同一执行者失败两次后，先问你再决定是否接管。
- **始终交叉。** research、plan、review 都让 codex 和 antigravity 在各自的新会话里独立完成，Claude 对比一致与分歧。
- **可选对比。** `/osm:impl --compare` 在独立 git worktree 里加一个子 agent，由它自己选执行者和 skill；交叉审查留下更好的结果。
- **阶段报告。** 每次运行结束都在 `${TMPDIR:-/tmp}/osm-reports/` 生成报告，附置信度（高/中/低，百分比）。

## 为何轻量

- **不做每轮注入。** 无 hooks，只有一个常驻小规则（`rules/ccg-codegraph.md`）。技能（`frontend-design`、`scrapling`、`seo-page-builder`、`bt-panel`、`adsense-site-auditor`）调用时才加载。输出样式保留 Claude Code 内置的编码规范。
- **单一主循环。** Claude 规划、决策并与你对话，前面没有路由层。
- **外部模型只用在值得的地方：** 限定范围的编写，或新会话里的第二意见。保留 Codex 主导模式（`node bin/ccg.mjs codex-mode install`）和全部 wrapper 后端（`codex`、`claude`、`gemini`、`antigravity`、`grok`、`kimi`、`opencode`）；不支持把 DeepSeek Harness 作为宿主。

设计原则见 [PRINCIPLES.md](PRINCIPLES.md)。

## 环境要求

Node.js 20+、pnpm、git、Claude Code；已登录的 `codex` 与 `agy`（Antigravity）CLI；OpenSpec（`npm i -g @fission-ai/openspec`，或由 `/osm:init` 引导安装）。

## 更新与卸载

```bash
# Update
cd ~/OpenSlime && git pull && pnpm install && pnpm build && node bin/ccg.mjs init --skip-prompt --skip-mcp --force

# Uninstall
cd ~/OpenSlime && node bin/ccg.mjs uninstall
```

## 致谢

OpenSlime 是 [fengshao1227/ccg-workflow](https://github.com/fengshao1227/ccg-workflow) 的精简 fork，移除了什么、为什么见 [FORK.md](FORK.md)。感谢上游贡献者，以及：

- [stellarlinkco/myclaude](https://github.com/stellarlinkco/myclaude)：`codeagent-wrapper`
- [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail)：审查标准
- [ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd)：输出形态
- ace-tool

均为 MIT 协议。OpenSlime 同样采用 [MIT](LICENSE)。
