# 本地调通 Claude Code —— Python 客户端实操指南

> 给任何想在自己的本地环境用 Python 调通 Claude Code 的同学的实操指南。目标:跑通"一问一答"、"流式输出"、"多轮会话"三种最小场景。
>
> 适用读者:已有 Python ≥ 3.10 环境、能在本机跑终端的工程师。

---

## 0. 是什么

- **Claude Code** = Anthropic 官方的本地 CLI/Agent 形态,负责"真的在本地读代码、跑命令、写文件"。
- **Claude Agent SDK**(`claude-agent-sdk`,PyPI 包名)是 Anthropic 为其提供的**官方 Python 客户端**,用于在自己的程序里驱动 Claude Code 干活。
- 你不需要自己手写 HTTP,SDK 会把消息/工具调用/流式输出都包好。

> 有些项目历史上内置过一份对 Claude Code 的 Python 封装,底层就是直接 `from claude_agent_sdk import ClaudeSDKClient` 包出来的。本文教你跳过中间层、直接用官方 SDK——更轻、更可控。

---

## 1. 前置条件

| 项 | 要求 |
|---|---|
| OS | macOS / Linux / WSL2(Windows 原生命令行在沙箱里跑 `claude` CLI 会失败,推荐 WSL) |
| Python | 3.10+ |
| Node.js | 18+(`claude` CLI 用 Node 启动) |
| 账号 | 已经在 [console.anthropic.com](https://console.anthropic.com/) 拿到 API Key,或已登录 Claude 订阅(Pro/Team/Enterprise) |

先确认 Node 在 PATH 里:

```bash
node -v    # 应 >= v18
npm -v
```

---

## 2. 安装 Claude Code CLI

Claude Agent SDK 不会自己起 Claude 进程,它需要本机有一个能调用的 `claude` 命令行。所以第一步先装 CLI:

```bash
# 官方推荐(国内网络若慢可换 taobao 镜像)
npm install -g @anthropic-ai/claude-code

# 验证
claude --version
```

> 如果你已经有 Claude Pro/Team 订阅,直接登录;如果只用 API Key,跳过 `claude login`,SDK 调用时通过 `ANTHROPIC_API_KEY` 环境变量走 API。

---

## 3. 安装 Python SDK

```bash
# 推荐用 venv / uv / poetry 自带环境,避免污染全局
python -m venv .venv
source .venv/bin/activate            # Windows PowerShell:  .venv\Scripts\Activate.ps1

pip install -U "claude-agent-sdk>=0.1.65"
```

> 不要装错包名:`claude-agent-sdk`(Anthropic 官方)≠ `claude-agent-sdk` 之外的同名仿冒包,认准 PyPI 链接: <https://pypi.org/project/claude-agent-sdk/>

验证安装:

```bash
python -c "from claude_agent_sdk import ClaudeSDKClient, ClaudeAgentOptions; print('ok')"
```

应输出 `ok`。

---

## 4. 鉴权(选一种)

### 方案 A:API Key(最稳,推荐)

```bash
# 写入 ~/.zshrc 或 ~/.bashrc,或临时 export
export ANTHROPIC_API_KEY="sk-ant-..."
```

SDK 启动 `claude` 进程时,会自动把这个环境变量透传过去。

### 方案 B:Claude 订阅(Pro/Team/Enterprise)

首次手动走一次登录:

```bash
claude login
```

登录后 SDK 会复用登录态,无需在代码里写 Key。

---

## 5. 最小可跑通示例

### 5.1 一问一答(同步)

新建 `hello_claude_code.py`:

```python
import asyncio
from claude_agent_sdk import ClaudeSDKClient, ClaudeAgentOptions


async def main() -> None:
    options = ClaudeAgentOptions(
        # 限制工具范围,只允许读文件 + 执行 shell,更安全
        allowed_tools=["Read", "Bash"],
        # 系统提示,告诉它要简短回答
        system_prompt="You are a helpful coding assistant. Answer concisely.",
        # 可选:模型名
        model="claude-sonnet-4-5",
        # 可选:限定工作目录
        cwd=".",  # 改成你想要的本地项目路径
    )

    async with ClaudeSDKClient(options=options) as client:
        await client.query("用一句话解释 list 和 tuple 的区别")

        # 拉取整段回复(SDK 内部把 stream 攒成 message)
        async for message in client.receive_response():
            print(f"[{type(message).__name__}] {getattr(message, 'content', message)}")


if __name__ == "__main__":
    asyncio.run(main())
```

跑:

```bash
python hello_claude_code.py
```

**成功标志**:终端打印出 `claude-sonnet-4-5` 风格的一行解释,且**没有 `Exit code 1` / `command not found` 之类的报错**。

### 5.2 流式(token 级别)

如果你要"打字机"效果:

```python
import asyncio
from claude_agent_sdk import ClaudeSDKClient, ClaudeAgentOptions


async def main() -> None:
    options = ClaudeAgentOptions(
        allowed_tools=["Read"],
        system_prompt="你是一个简洁的助手,回答控制在 3 句话以内。",
    )

    async with ClaudeSDKClient(options=options) as client:
        await client.query("用 Python 写一个快速排序")

        async for msg in client.receive_messages():
            # 增量流:逐块拿
            if getattr(msg, "type", "") == "stream_event":
                delta = getattr(msg.event, "delta", None)
                if delta and getattr(delta, "type", "") == "text_delta":
                    print(delta.text, end="", flush=True)
            elif getattr(msg, "type", "") == "assistant":
                # 完整消息
                for block in msg.message.content:
                    if getattr(block, "type", "") == "text":
                        print("\n[final]", block.text)
                break  # 一轮结束


if __name__ == "__main__":
    asyncio.run(main())
```

### 5.3 多轮会话(同一上下文)

```python
import asyncio
from claude_agent_sdk import ClaudeSDKClient, ClaudeAgentOptions


async def main() -> None:
    options = ClaudeAgentOptions(
        allowed_tools=["Read", "Edit", "Bash"],
        system_prompt="你是一个 Python 重构助手。",
    )

    async with ClaudeSDKClient(options=options) as client:
        # 第 1 轮
        await client.query("读当前目录的 pyproject.toml,告诉我用了哪些依赖。")
        async for msg in client.receive_response():
            print("[turn1]", getattr(msg, "content", msg))

        # 第 2 轮:SDK 会在同一个 client 内保持会话上下文
        await client.query("其中哪个是用来发 HTTP 请求的?")
        async for msg in client.receive_response():
            print("[turn2]", getattr(msg, "content", msg))


if __name__ == "__main__":
    asyncio.run(main())
```

**关键点**:`async with ClaudeSDKClient(...) as client:` 块内,`client` 是**有状态**的;每次 `query` + `receive_response` 算一轮,中间共享同一个会话上下文。不要每轮都新建 client,否则上下文会断。

---

## 6. 关键参数速查(`ClaudeAgentOptions`)

| 参数 | 类型 | 说明 |
|---|---|---|
| `allowed_tools` | `list[str]` | 允许的工具白名单,例如 `["Read", "Edit", "Bash", "Grep", "Glob"]` |
| `system_prompt` | `str` | 系统提示词 |
| `model` | `str` | 模型名,如 `claude-sonnet-4-5` / `claude-opus-4-1`;不传走默认 |
| `cwd` | `str` | Claude Code 的工作目录(影响它能读/写哪些文件) |
| `permission_mode` | `str` | `"acceptEdits"` / `"plan"` / `"bypassPermissions"`,控制是否需要人工确认 |
| `max_turns` | `int` | 单次会话最大轮数,防止跑飞 |
| `mcp_servers` | `dict` | 接 MCP server 的配置,详见 §8 |
| `env` | `dict` | 透传给 `claude` 子进程的环境变量 |

更全的字段以官方文档为准:<https://docs.claude.com/en/api/agent-sdk/python>

---

## 7. 常见问题排查

### 7.1 `command not found: claude`

SDK 会去 PATH 找 `claude` 命令。`npm install -g` 之后 Node 全局 bin 目录没在 PATH 里就报这个。修法:

```bash
# macOS (Apple Silicon)
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc
# 或装到系统路径
sudo npm install -g @anthropic-ai/claude-code

# Linux 通常 ~/.npm-global/bin
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

### 7.2 `Exit code 1` + `Not logged in`

- **方案 A(API Key)**:确认 `echo $ANTHROPIC_API_KEY` 有值,且子进程能继承(SDK 透传,所以 Shell 设了就行)。
- **方案 B(订阅)**:再跑一次 `claude login`,然后**退出当前账号、重新登录**,避免 token 过期。

### 7.3 `Tool use not allowed` / 沙箱报错

- 把对应工具加进 `allowed_tools`。
- 如果在 CI / Docker 里跑,容器需要 `claude` CLI 能跑(Node + 必要的 `/bin/sh` + 网络出口)。

### 7.4 Windows 原生跑不起来

- Claude Code CLI 的默认沙箱在 Windows 原生 PowerShell 上工作不稳定,会出现"启动后立即退出"之类的问题。**强烈建议改用 WSL2**:
  ```bash
  wsl --install          # 一次性
  # 在 WSL Ubuntu 里再走 §2 ~ §5
  ```

### 7.5 想看 Claude Code 实际在干什么

让 SDK 把内部 JSONL 调试日志打开:

```python
options = ClaudeAgentOptions(
    debug=True,                 # 启用 stderr 调试输出
    log_file="./claude-debug.jsonl",
    ...
)
```

或在 Shell 里:

```bash
export CLAUDE_CODE_DEBUG=1
```

---

## 8. 进阶:接 MCP server

```python
options = ClaudeAgentOptions(
    allowed_tools=["Read", "Edit", "mcp__my_server__my_tool"],
    mcp_servers={
        "my_server": {
            "type": "stdio",
            "command": "python",
            "args": ["./my_mcp_server.py"],
        }
    },
)
```

之后 Claude Code 就能用 `mcp__my_server__my_tool` 这个工具名调用你注册的 MCP 工具。

---

## 9. 自检清单(发出去前过一遍)

- [ ] `claude --version` 有输出
- [ ] `python -c "from claude_agent_sdk import ClaudeSDKClient"` 不报错
- [ ] `ANTHROPIC_API_KEY` 已设(或 `claude login` 完成)
- [ ] §5.1 的一问一答脚本能跑通,看到 Claude 的回复
- [ ] §5.2 的流式脚本能逐字打印
- [ ] §5.3 的多轮脚本第 2 轮回答依赖第 1 轮的上下文

跑通以上 6 步,本地 Claude Code 就"代码层面"调通了,后面无论是做 CLI 包装、Bot 集成、还是嵌进自己的服务,都是在这个最小骨架上扩。

---

## 参考

- Claude Agent SDK 官方文档:<https://docs.claude.com/en/api/agent-sdk/python>
- Claude Code CLI 仓库:<https://github.com/anthropics/claude-code>
- PyPI 包:<https://pypi.org/project/claude-agent-sdk/>
