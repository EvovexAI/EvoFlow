"""Host-side checks for agent runtimes (Claude Code SDK, ACP command, etc.).

Used by the Gateway (``/api/agents``) so the panel can dim or warn when a role cannot run.
**Important:** the probe runs in the **Gateway process's** Python and PATH. Claude Code **chat**
runs inside the **LangGraph** process (``uv run langgraph dev`` from ``backend/``). If those
use different interpreters or venvs, ``external_cli_available`` can be true while chat still
fails with ``No module named 'claude_agent_sdk'`` — install the SDK into the LangGraph venv too
(``uv sync --extra claude-code`` in ``backend/``).

Results are cached briefly to avoid import / PATH spam on every list request.
"""

from __future__ import annotations

import logging
import shutil
import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from evoflow.config.agents_config import AgentConfig

logger = logging.getLogger(__name__)

_CACHE_TTL_SEC = 45.0
_claude_mon: float | None = None
_claude_ok: bool | None = None


def _import_claude_agent_sdk() -> bool:
    try:
        import claude_agent_sdk  # noqa: F401

        return True
    except ImportError:
        return False


def is_claude_code_worker_runtime_available() -> bool:
    """True if **this process** can start the Claude Code worker (SDK import + subprocess spawn).

    Not a guarantee for other processes (e.g. LangGraph) — see module docstring.
  On Windows with EvoFlow's Selector event-loop policy, ``import claude_agent_sdk`` may succeed
    (bundled CLI) while ``asyncio`` subprocess spawn still fails.
    """
    global _claude_mon, _claude_ok
    now = time.monotonic()
    if _claude_mon is not None and _claude_ok is not None and (now - _claude_mon) < _CACHE_TTL_SEC:
        return _claude_ok

    ok = _import_claude_agent_sdk() or bool(shutil.which("claude"))
    if ok:
        try:
            from evoflow.platform.asyncio_windows import claude_session_subprocess_supported

            ok = claude_session_subprocess_supported()
        except Exception:
            logger.debug("claude subprocess capability probe failed", exc_info=True)
    _claude_mon = now
    _claude_ok = ok
    if not ok:
        logger.debug(
            "Claude Code worker runtime not operational "
            "(missing SDK/CLI or subprocess unsupported on this event loop)"
        )
    return ok


def _acp_command_available(agent_cfg: AgentConfig) -> bool:
    raw = (agent_cfg.command or "").strip()
    if not raw:
        return False
    first = raw.split()[0]
    if not first:
        return False
    if shutil.which(first):
        return True
    # Windows: user may set command to `npx.cmd` or full path
    for ext in (".cmd", ".exe", ".bat"):
        if shutil.which(first + ext):
            return True
    return False


def external_runtime_available_for_agent(
    agent_cfg: AgentConfig | None,
    *,
    agent_code: str,
    requires_external_cli: bool,
) -> bool:
    """Whether this host appears to satisfy external dependencies for the agent."""
    if not requires_external_cli:
        return True

    code = (agent_code or "").lower()
    if code == "claude-code":
        return is_claude_code_worker_runtime_available()

    if agent_cfg is not None:
        if agent_cfg.agent_type == "subagent" and agent_cfg.tools and "claude-code" in agent_cfg.tools:
            return is_claude_code_worker_runtime_available()
        if agent_cfg.agent_type == "acp":
            return _acp_command_available(agent_cfg)

    logger.debug(
        "requires_external_cli but no runtime probe matched (code=%r, has_cfg=%s)",
        agent_code,
        agent_cfg is not None,
    )
    return True
