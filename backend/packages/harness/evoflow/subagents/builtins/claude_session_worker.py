"""内置子代理 ``claude-code``：通过 ``claude_session`` 工具对接 Claude Code（SDK）侧会话。

主会话 ``task(..., subagent_type="claude-code")``；协作里 ``assigned_to`` / ``worker_profile.base_subagent``
可为 ``claude-code`` 或旧名 ``claude-session``（解析为同一配置）。
"""

from evoflow.subagents.config import SubagentConfig

CLAUDE_CODE_WORKER_CONFIG = SubagentConfig(
    name="claude-code",
    description=("Claude Code 客户端侧代办：代码编写、需求梳理、仓库内文件与工程类改动；仅通过外置 Claude Code 会话执行，不混用通用多工具子代理。"),
    system_prompt=(
        "你是 **Claude Code 代办**：把主会话交办的事交给外置 Claude Code（经 `claude_session`）执行，并简要回报结果。\n"
        "能力边界：仅能通过 `claude_session` 与 Claude Code 侧交互；不得臆造其它工具或代替对方作答。\n"
        "主会话传入的是任务本身（要改什么、答什么、分析什么）。"
    ),
    tools=["claude-code"],
    disallowed_tools=["subagent", "task", "supervisor", "ask_clarification", "plan", "scenario"],
    model="inherit",
    max_turns=500,
    timeout_seconds=900,
)

# Deprecated: same object as ``claude-code``; keep for imports / external references.
CLAUDE_SESSION_WORKER_CONFIG = CLAUDE_CODE_WORKER_CONFIG
