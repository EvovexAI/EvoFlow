---
name: coding-agent
description: "通过后台进程将编码任务委托给本机已安装的外部编码 Agent CLI（如 Claude Code、OpenCode、Pi）。用于构建功能、审查 PR、大型重构或需要探索式迭代的编码。简单一行修复请直接编辑；读代码请用 read 工具。需要支持 pty:true 的 bash 工具。"
metadata:
  {
    "evoflow": { "emoji": "🧩", "requires": { "anyBins": ["claude", "opencode", "pi"] } },
  }
---

# Coding Agent (bash-first)

Use **bash** (with optional background mode) to run an external coding-agent CLI already installed on the host.

## PTY Mode Required

Interactive coding CLIs need a pseudo-terminal. Always pass `pty:true`:

```bash
# ✅ with PTY
bash pty:true command:"claude 'Your prompt'"

# ❌ without PTY — output/agent may break
bash command:"claude 'Your prompt'"
```

Pick whichever binary is available on PATH (`claude`, `opencode`, `pi`, …). Prefer the project's documented default when one exists.

### Bash Tool Parameters

| Parameter    | Type    | Description                                                                 |
| ------------ | ------- | --------------------------------------------------------------------------- |
| `command`    | string  | The shell command to run                                                    |
| `pty`        | boolean | **Required for coding agents** — allocates a PTY for interactive CLIs       |
| `workdir`    | string  | Working directory (agent sees only this folder's context)                   |
| `background` | boolean | Run in background; returns sessionId for monitoring                         |
| `timeout`    | number  | Timeout in seconds                                                          |
| `elevated`   | boolean | Run on host instead of sandbox (if allowed)                                 |

## Patterns

**One-shot in a scratch repo**

```bash
SCRATCH=$(mktemp -d) && cd $SCRATCH && git init
bash pty:true workdir:$SCRATCH command:"claude 'Implement …'"
```

**Background long job**

```bash
bash pty:true workdir:~/project background:true command:"claude 'Refactor the auth module'"
```

**PR review checkout**

```bash
bash pty:true workdir:/tmp/pr-review command:"claude 'Review the diff against main'"
```

Keep prompts scoped; do not start agents in shared chat-only workspaces that must stay untouched.
