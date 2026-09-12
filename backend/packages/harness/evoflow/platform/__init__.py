"""Platform-specific runtime hooks (Windows asyncio / httpx)."""

from evoflow.platform.asyncio_windows import (
    apply_windows_langgraph_runtime_fixes,
    claude_session_subprocess_supported,
    install_asyncio_benign_disconnect_handler,
    is_benign_client_disconnect_error,
    is_event_loop_closed_runtime_error,
    is_subprocess_spawn_runtime_error,
)

__all__ = [
    "apply_windows_langgraph_runtime_fixes",
    "claude_session_subprocess_supported",
    "install_asyncio_benign_disconnect_handler",
    "is_benign_client_disconnect_error",
    "is_event_loop_closed_runtime_error",
    "is_subprocess_spawn_runtime_error",
]
