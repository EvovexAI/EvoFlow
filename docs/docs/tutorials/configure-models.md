# 配置你的第一个模型

## 你将学到什么

- 理解模型配置的基本结构
- 配置一个 OpenAI 兼容的模型
- 配置一个 CLI 后端（Codex / Claude Code）
- 多模型切换

## 前置条件

- 已完成 [安装](../getting-started/installation.md)

## 预计用时

10 分钟

## 步骤

### 1. 打开配置文件

编辑项目根目录的 `config.yaml`。

### 2. 添加一个 OpenAI 兼容模型

在 `models` 下添加：

```yaml
models:
  - name: gpt-4
    display_name: GPT-4
    use: langchain_openai:ChatOpenAI
    model: gpt-4
    api_key: $OPENAI_API_KEY
    max_tokens: 4096
    temperature: 0.7
```

各字段含义：
- `name`：内部标识符，代码中引用
- `display_name`：UI 中显示的名称
- `use`：LangChain 类路径，决定用哪个 SDK
- `model`：API 端的模型名
- `api_key`：以 `$` 开头表示读取环境变量

### 3. 设置 API 密钥

在 `.env` 文件中：

```bash
OPENAI_API_KEY=your-api-key
```

### 4. 添加一个 CLI 后端（可选）

```yaml
models:
  - name: codex
    display_name: Codex CLI
    use: evoflow.models.openai_codex_provider:CodexChatModel
    model: gpt-5.4
    supports_thinking: true

  - name: claude
    display_name: Claude Code
    use: evoflow.models.claude_provider:ClaudeChatModel
    model: claude-sonnet-4-6
    supports_thinking: true
```

CLI 后端的认证通过本地凭证文件完成：
- Codex CLI：`~/.codex/auth.json`
- Claude Code：`~/.claude/.credentials.json` 或环境变量

### 5. 启用思考模式

```yaml
models:
  - name: claude-thinking
    display_name: Claude (Thinking)
    use: langchain_anthropic:ChatAnthropic
    model: claude-sonnet-4-6
    api_key: $ANTHROPIC_API_KEY
    supports_thinking: true
    max_tokens: 8192
    when_thinking_enabled:
      thinking:
        type: enabled
```

### 6. 启用视觉理解

```yaml
models:
  - name: gpt-4-vision
    display_name: GPT-4 Vision
    use: langchain_openai:ChatOpenAI
    model: gpt-4-turbo
    api_key: $OPENAI_API_KEY
    supports_vision: true
```

## 验证是否生效

在 EvoPanel 的模型列表中能看到你配置的模型，点击测试按钮能连通。

## 常见问题

### 如何切换模型？

在 EvoPanel 聊天界面的模型选择器中切换，或通过 `/models` 命令。

### 支持哪些厂商？

任何提供 OpenAI 兼容 API 的厂商：OpenAI、DeepSeek、Kimi、Gemini（通过网关）、Claude（通过 Anthropic SDK）等。

## 下一步

- [完成第一个任务](../getting-started/first-task.md)
- [创建自定义 Agent](create-agent.md)
- [配置参考](../reference/config-reference.md)

---

**最后验证**：2026-05-10；适用范围：默认分支。
