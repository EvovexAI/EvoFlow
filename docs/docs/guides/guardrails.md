# 安全护栏配置

## 适用场景
在 Agent 执行工具调用前增加策略授权层，防止 Agent 执行危险操作（如 `rm -rf /`）。适用于生产环境、多用户场景或需要对 Agent 行为施加约束的场景。

## 前置条件
- EvoFlow 已运行
- 了解 Agent 可用工具列表

## 什么是安全护栏

安全护栏（Guardrails）是一种中间件，在 Agent 的每次工具调用**执行前**进行策略评估。被拒绝的调用会返回错误 ToolMessage，Agent 可以看到拒绝信息并调整行为。

```
无护栏：                    有护栏：
  Agent                      Agent
    │                          │
    ▼                          ▼
  bash ──▶ 立即执行          bash ──▶ GuardrailMiddleware
  rm -rf /                            │
                                      ▼
                                Provider 评估
                                 ┌──┴──┐
                               ALLOW  DENY
                                 │      │
                                 ▼      ▼
                              执行     "Guardrail denied"
```

## 配置方式

在 `config.yaml` 中配置 `guardrails` 段：

```yaml
guardrails:
  enabled: true
  fail_closed: true      # Provider 出错时是否阻断（默认 true）
  passport: null         # 护照引用（传递给 Provider 作为 agent_id）
  provider:
    use: evoflow.guardrails.builtin:AllowlistProvider
    config:
      denied_tools: ["bash", "write_file"]
```

## 三种 Provider 选项

### 选项一：内置 AllowlistProvider（零依赖）

最简单的方案，随 EvoFlow 自带。按工具名黑白名单控制。

**黑名单模式**（仅阻止指定工具）：
```yaml
guardrails:
  enabled: true
  provider:
    use: evoflow.guardrails.builtin:AllowlistProvider
    config:
      denied_tools: ["bash", "write_file"]
```

**白名单模式**（仅允许指定工具）：
```yaml
guardrails:
  enabled: true
  provider:
    use: evoflow.guardrails.builtin:AllowlistProvider
    config:
      allowed_tools: ["web_search", "read_file", "ls"]
```

### 选项二：OAP 策略 Provider（基于策略）

基于 [Open Agent Passport (OAP)](https://github.com/aporthq/aport-spec) 开放标准。支持更精细的策略（如允许特定命令、阻止特定模式）。

以 APort 参考实现为例：

```bash
pip install aport-agent-guardrails
aport setup --framework evoflow
```

生成配置文件：
- `~/.aport/evoflow/config.yaml` — 评估器配置
- `~/.aport/evoflow/aport/passport.json` — OAP 护照

```yaml
guardrails:
  enabled: true
  provider:
    use: aport_guardrails.providers.generic:OAPGuardrailProvider
```

**护照控制内容：**

| 护照字段 | 作用 | 示例 |
|----------|------|------|
| `capabilities[].id` | 允许的工具类别 | `system.command.execute`, `data.file.read` |
| `limits.*.allowed_commands` | 允许的命令 | `["git", "npm", "node"]` 或 `["*"]` |
| `limits.*.blocked_patterns` | 始终阻止的模式 | `["rm -rf", "sudo", "chmod 777"]` |
| `status` | 总开关 | `active`, `suspended`, `revoked` |

### 选项三：自定义 Provider

实现 `evaluate` 和 `aevaluate` 方法的任意 Python 类：

```python
# my_guardrail.py
class MyGuardrailProvider:
    name = "my-company"

    def evaluate(self, request):
        from evoflow.guardrails.provider import GuardrailDecision, GuardrailReason

        if request.tool_name == "bash" and "delete" in str(request.tool_input):
            return GuardrailDecision(
                allow=False,
                reasons=[GuardrailReason(code="custom.blocked", message="delete not allowed")],
                policy_id="custom.v1",
            )
        return GuardrailDecision(allow=True, reasons=[GuardrailReason(code="oap.allowed")])

    async def aevaluate(self, request):
        return self.evaluate(request)
```

```yaml
guardrails:
  enabled: true
  provider:
    use: my_guardrail:MyGuardrailProvider
```

## 被拒绝的调用如何处理

1. Provider 返回 `deny` 决策
2. `GuardrailMiddleware` 构造 `ToolMessage(status="error")`
3. Agent 看到错误信息（如 `"Guardrail denied: tool 'bash' was blocked (oap.tool_not_allowed)"`）
4. Agent 可自行调整策略或向用户报告

## Provider 接口

任何 Provider 需实现以下协议：

| 方法 | 签名 |
|------|------|
| `evaluate` | `(request: GuardrailRequest) -> GuardrailDecision` |
| `aevaluate` | `async (request: GuardrailRequest) -> GuardrailDecision` |

`GuardrailRequest` 包含：`tool_name`、`tool_input`、`agent_id`、`thread_id`、`is_subagent`。

`GuardrailDecision` 包含：`allow`（bool）、`reasons`、`policy_id`。

## Agent 工具名列表

Provider 的 `request.tool_name` 会收到以下值：

| 工具名 | 功能 |
|--------|------|
| `bash` | Shell 命令执行 |
| `write_file` | 创建/覆盖文件 |
| `str_replace` | 编辑文件 |
| `read_file` | 读取文件 |
| `ls` | 列出目录 |
| `web_search` | 网络搜索 |
| `web_fetch` | 获取 URL 内容 |
| `image_search` | 图片搜索 |
| `task` | 委派子代理 |
| `mcp__*` | MCP 工具（动态） |

## 验证是否生效

1. 配置 guardrails 并重启
2. 让 Agent 执行被拒绝的操作（如 `bash rm -rf /`）
3. Agent 应返回拒绝信息而非执行命令

## 常见问题

**Q: `execute_command` 被自动从 denied_tools 中移除了？**
这是开发时的便利行为，方便子代理执行 shell 辅助命令。若需保留，设置环境变量 `EVOFLOW_GUARDRAILS_DENY_EXECUTE_COMMAND=1`。

**Q: Provider 报错时会怎样？**
取决于 `fail_closed` 配置。`true`（默认）时阻断调用；`false` 时放行。

**Q: 子代理的工具调用也受护栏限制吗？**
是的。`GuardrailMiddleware` 对所有工具调用生效，包括子代理的 `task` 工具触发的操作。

**Q: 可以针对特定用户/线程设置不同策略吗？**
当前配置是全局的。如需差异化，可通过自定义 Provider 根据 `request.thread_id` 或 `request.agent_id` 实现不同策略。

## 相关文档
- [沙箱模式配置](./sandbox-config.md)
- [Plan 模式使用](./plan-mode.md)

---

**最后验证**：2026-05-10；适用范围：默认分支。
