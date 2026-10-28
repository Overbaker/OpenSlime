# OpenSlime — 最简的 Claude 主导多 agent 协作

> 设计原则见 [PRINCIPLES.md](PRINCIPLES.md)。为兼容已有安装，CLI 仍叫 `ccg`，包名仍是 `ccg-workflow`。

> **这是 [fengshao1227/ccg-workflow](https://github.com/fengshao1227/ccg-workflow) 的精简 fork。**
> 保留多模型串行链；移除每轮注入的 hooks、常驻路由规则、`/osm:go` 引擎、正则质量关卡，以及 DeepSeek Harness（`dsh-ccg`）插件。**不支持把 DSH 作为宿主。**
> Claude 始终是编排者，Codex、Gemini、Antigravity、Grok、Kimi、OpenCode、Claude 通过 `codeagent-wrapper` 作为执行者被调用。可选的 Codex 主导模式（`ccg codex-mode`）与上游一致，未改动。
> 删了什么、为什么删：[FORK.md](FORK.md)。English: [README.md](README.md)

## 安装内容

| 部分 | 作用 |
|---|---|
| `/osm:init → /osm:research → /osm:plan → /osm:impl → /osm:review` | OpenSpec 串行链。`/osm:impl` 中 codex 写后端、antigravity 写前端，各自只改明确列出的文件。Claude 负责监控：拆任务、审 diff、把所有修复退回给执行者，自己不写产品代码。最后由新会话独立审查。 |
| `~/.claude/bin/codeagent-wrapper` | 统一调用各后端，支持 `resume <session>` 和带 `dependencies:` 的 `--parallel`。 |
| `~/.claude/.ccg/prompts/<backend>/` | 各后端的角色提示词（analyzer、architect、builder、reviewer 等）。 |
| 按需技能 | `frontend-design`、`scrapling`、`seo-page-builder`、`bt-panel`、`adsense-site-auditor`，调用前不注入任何内容。 |
| 输出样式 | 全部设置 `keep-coding-instructions: true`，保留 Claude Code 内置的工程规范。 |

每个会话唯一常驻的文本是 `rules/ccg-codegraph.md`，不注册任何 hook。

## 安装

需要 Node.js 20+、pnpm 和 Claude Code。各后端 CLI（codex、gemini、agy、grok、kimi、opencode）可选。

```bash
git clone https://gitea.aimo3d.org/han/OpenSlime.git && cd OpenSlime
pnpm install && pnpm build
node bin/ccg.mjs init                                  # 交互式
node bin/ccg.mjs init --skip-prompt --skip-mcp --force # 默认配置
```

之后不要再运行 `npx ccg-workflow`，那会装回上游版本，把删掉的部分带回来。

在上游安装之上升级时，退役文件会移到 `~/.claude/.ccg-retired/<时间戳>/`，只注销 CCG 自己的 hook 命令；你自己的 hooks、rules 和 settings 保持不变。

## 命令

```bash
node bin/ccg.mjs                 # 菜单（同时安装为 `osm`）
node bin/ccg.mjs init            # 安装 / 重装
node bin/ccg.mjs doctor [--json] # 健康检查
node bin/ccg.mjs skills list     # 原生技能选择
node bin/ccg.mjs codex-mode install|uninstall
node bin/ccg.mjs uninstall
```

## 致谢

上游 [fengshao1227/ccg-workflow](https://github.com/fengshao1227/ccg-workflow) 及其贡献者 · [stellarlinkco/myclaude](https://github.com/stellarlinkco/myclaude)（wrapper 灵感）· [ace-tool](https://linux.do/t/topic/1344562) · 审查标准改编自 [ponytail](https://github.com/DietrichGebert/ponytail) · 输出形态精简自 [i-have-adhd](https://github.com/ayghri/i-have-adhd)（均为 MIT）。

## 许可证

MIT，见 [LICENSE](LICENSE)。
