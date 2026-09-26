"""Host-side checks for agent runtimes (ACP command, etc.).

Used by the Gateway (``/api/agents``) so the panel can warn when a role cannot run.
Results are cached briefly to avoid PATH spam on every list request.
"""

from __future__ import annotations

import logging
import shutil
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from evoflow.config.agents_config import AgentConfig

logger = logging.getLogger(__name__)


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

    if agent_cfg is not None and agent_cfg.agent_type == "acp":
        return _acp_command_available(agent_cfg)

    logger.debug(
        "requires_external_cli but no runtime probe matched (code=%r, has_cfg=%s)",
        agent_code,
        agent_cfg is not None,
    )
    return True
