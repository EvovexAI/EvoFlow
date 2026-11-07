"""Per-tool timeout configuration used by tool-approval execution.

The former ``ToolTimeoutMiddleware`` (never mounted) was retired on 2026-11-07;
``tool_approval_executor`` still resolves per-tool timeouts from this module.
"""

import logging

logger = logging.getLogger(__name__)

# Default timeout per tool (seconds). Tools not listed use DEFAULT_TIMEOUT.
_TOOL_TIMEOUTS: dict[str, int] = {
    "terminal": 600,  # replaces execute_command (superset)
    "bash": 600,
    "Bash": 600,
    "web_fetch": 60,
    "web_extract": 60,
    "web_search": 30,
    # "read_lints": 90,  # retired — 诊断走 Bash（pyright/ruff）
    "glob": 30,
    "grep": 60,
    "view_image": 120,
}

_DEFAULT_TIMEOUT = 300


def _timeout_for_tool(tool_name: str) -> int:
    """Get timeout for a tool, with env var override support."""
    env_key = f"EVOFLOW_TIMEOUT_{tool_name.upper()}"
    env_val = __import__("os").environ.get(env_key, "").strip()
    if env_val:
        try:
            return int(env_val)
        except ValueError:
            pass
    return _TOOL_TIMEOUTS.get(tool_name, _DEFAULT_TIMEOUT)
