# Pi RPC 后端

Pi 已作为一等后端接入 `codeagent-wrapper`。OpenSlime 保留原有编排层与 worker 边界，
在运行 wrapper 的机器上启动 **Pi 本地 RPC 子进程**，通过 stdin 发送协议命令，并持续
读取 stdout 的结构化事件。Pi 自己管理 provider、凭据、工具权限和上下文窗口；provider
可以调用本地模型或远程 API。本功能**不是独立远程 Pi 服务器连接**，不要把两者混为一谈。

## 先配置 Pi

1. 在运行 `codeagent-wrapper` 的机器安装 `pi`，并保证其在 `PATH` 中。
   Windows 的诊断检查使用 `pi.exe`。
2. 在 Pi 中配置 provider、模型、权限和所需的长上下文 variant。凭据保存在 Pi 的
   配置或环境中，不要写入 OpenSlime 配置、提示词、模板或日志。
3. 执行 `pi --list-models`，取得唯一模型 ID 或 `provider/model` 名称。
4. 在 `osm init` 或模型路由菜单选择 **Pi (RPC)**。输入对应模型；留空则沿用 Pi 默认模型。

需要 1M 上下文时，应选择 Pi 中实际配置为 1M 的模型 variant，例如
`your-provider/your-1m-model`；这只是命名示例，实际值以 `pi --list-models` 和 Pi 配置为准。
OpenSlime 不检测、扩大、截断或覆盖上下文窗口。名字包含 `1m` 不等于已验证支持 1M。
必须同时保留 Pi 的 provider/model 相关配置，并确认额度和 reasoning token 限制。
模型不可用或认证失败时任务退出非零，不会静默降级到其它模型。

```toml
# ~/.claude/.ccg/config.toml
[routing]
primary = "claude"

[routing.backend]
primary = "pi"
models = ["pi"]

piModel = "your-provider/your-1m-model"
```

## 调用与恢复

```bash
# 新会话（安装后的 wrapper 通常位于 ~/.claude/bin）
codeagent-wrapper --lite --backend pi \
  --pi-model your-provider/your-1m-model \
  '检查当前变更，报告回归问题；不要修改文件。' /path/to/project

# stdin 任务仍然被序列化为 Pi RPC 输入，不会触发 @file 展开
codeagent-wrapper --lite --backend pi - /path/to/project <<'EOF'
检查请求提到的 diff。
@这里只是字面上的文本。

请按指定 JSON 格式返回。
EOF

# 沿用第一次输出的 SESSION_ID
codeagent-wrapper --lite --backend pi \
  resume <session_id> '继续执行，先核对上次结论。' /path/to/project
```

`PI_MODEL` 是默认模型，CLI 的 `--pi-model`/`--pi-model=<值>` 覆盖它；安装后的工作流
通过 `{{PI_MODEL_FLAG}}` 只给 Pi 调用注入该参数。并行输入模式不接受针对后端的模型
CLI 参数，应在调用前设置 `PI_MODEL`。并行任务字段可以指定 `backend: "pi"`。
`CODEAGENT_PI_COMMAND` 可覆盖 Pi 可执行文件，用于测试或自定义安装路径。

## 协议、完成条件和错误

1. 新进程使用 `pi --mode rpc`；恢复时额外传入 `--session <session_id>`。
2. wrapper 发送 `get_state` 与 `prompt` JSONL 命令。前者的 `session_id` 用于发现会话，
   不代表 prompt 已完成；后者返回 `success: true` 也只表示 prompt 已被接收。
3. 持续读取 `agent_event`：`message_update/text_delta` 用于流式文本，工具调用和重试
   用于进度。最终消息用于结果；以 `agent_settled` 作为完成信号，再关闭 stdin。
4. resume 打开同一 Pi 会话并继续加入 prompt。新任务正常消耗上下文；恢复会话也不是
   独立、免费的新上下文，实际价格以 Pi/provider 为准。
5. RPC command 被拒绝、重试耗尽、provider 错误、assistant 的 `error`/`aborted` stop
   reason、协议读取失败均返回非零退出码。已经返回的协议错误不会被 EOF 吞掉。

结果保留原有 `SESSION_ID: <id>` 标记；stderr 用于进程诊断及可选进度。超时、取消和
强制终止沿用现有进程组清理，且会关闭 stdin，不留下等待下一次 RPC 命令的子进程。

为保持委派任务确定性，Pi 默认使用 `--no-extensions`、`--no-skills`、
`--no-prompt-templates`，避免扩展交互审批或意外项目行为；MCP 默认关闭，只有显式
`--with-mcp` 才开启。只读提示词不替代操作系统权限。`--lite` 只关闭 OpenSlime 辅助
Web UI，不改变 Pi provider、上下文窗口或安全策略。

调试 Pi 本身时可直接使用 `pi --mode rpc`，但不要把委托输入当成交互终端，也不要依赖
终端渲染或加入 `exit` 命令。`osm doctor --json` 会检查通过路由选中的 Pi，并报告
缺失或可执行文件错误；该检查不收集 provider 密钥。
