"""Standalone subagent runner - called via subprocess for clean context."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

# Add harness and backend to path at module load time
# This file is at: backend/packages/harness/evoflow/core/scheduler/subagent_runner.py
_current_file = Path(__file__).resolve()
# Go up: scheduler -> core -> evoflow -> harness
_harness_path = _current_file.parents[3]
# Go up more: harness -> packages -> backend
_backend_path = _harness_path.parents[1]

# Always add these paths to ensure imports work
if str(_harness_path) not in sys.path:
    sys.path.insert(0, str(_harness_path))
if str(_backend_path) not in sys.path:
    sys.path.insert(0, str(_backend_path))

# Also ensure they're in PYTHONPATH for child imports
os.environ["PYTHONPATH"] = str(_backend_path) + os.pathsep + str(_harness_path) + os.pathsep + os.environ.get("PYTHONPATH", "")


def run_subagent(prompt: str, task_id: str, trace_id: str) -> dict:
    """Run subagent and return result as dict."""
    # Import order is critical to avoid circular imports:
    # 1. First import tools (no dependency on subagents)
    # 2. Then import registry (may depend on tools)
    # 3. Finally import executor (depends on both)
    # Import executor classes directly from module to avoid __init__.py circular imports
    import evoflow.subagents.executor as _executor_module
    from evoflow.subagents.registry import get_subagent_config
    from evoflow.tools.tools import get_available_tools

    SubagentExecutor = _executor_module.SubagentExecutor
    SubagentStatus = _executor_module.SubagentStatus

    # Load config and tools
    config = get_subagent_config("general-purpose")
    tools = get_available_tools(model_name=None, subagent_enabled=False)

    # Use task_id as thread_id to ensure ThreadDataMiddleware can get it from context
    # without needing to call get_config() (which requires LangGraph runnable context)
    thread_id = f"auto_{task_id}"

    # Create executor
    executor = SubagentExecutor(
        config=config,
        tools=tools,
        parent_model=None,
        thread_id=thread_id,
    )
    executor.trace_id = trace_id

    # Execute
    try:
        result = executor.execute(prompt)
        return {
            "task_id": result.task_id,
            "trace_id": result.trace_id,
            "status": result.status.value if hasattr(result.status, "value") else str(result.status),
            "result": result.result,
            "error": result.error,
            "started_at": result.started_at.isoformat() if result.started_at else None,
            "completed_at": result.completed_at.isoformat() if result.completed_at else None,
            "ai_messages": result.ai_messages,
            "stream_messages": result.stream_messages,
        }
    except Exception as e:
        import traceback

        return {
            "task_id": task_id,
            "trace_id": trace_id,
            "status": SubagentStatus.FAILED.value,
            "result": None,
            "error": f"{type(e).__name__}: {e}\n{traceback.format_exc()}",
            "started_at": None,
            "completed_at": None,
            "ai_messages": [],
            "stream_messages": [],
        }


if __name__ == "__main__":
    # Called via subprocess with JSON args via stdin
    prompt = sys.argv[1] if len(sys.argv) > 1 else ""
    task_id = sys.argv[2] if len(sys.argv) > 2 else ""
    trace_id = sys.argv[3] if len(sys.argv) > 3 else ""

    result = run_subagent(prompt, task_id, trace_id)
    print(json.dumps(result))
