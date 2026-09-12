"""Work around langgraph_api ``map_cmd`` setting ``goto=None`` on resume-only commands.

``langgraph_api.command.map_cmd`` builds ``Command(goto=None)`` when the HTTP body
only has ``{"resume": ...}``. LangGraph's ``_control_branch`` then crashes with
``TypeError: 'NoneType' object is not iterable`` during tool-approval resume.
"""

from __future__ import annotations

import logging
from typing import Any, cast

logger = logging.getLogger(__name__)

_PATCHED = False


def apply_langgraph_command_patch() -> None:
    """Patch ``langgraph_api.command.map_cmd`` once per process."""
    global _PATCHED
    if _PATCHED:
        return
    try:
        import langgraph_api.command as lg_cmd
        from langgraph.types import Command, Send
        from langgraph_api.schema import RunCommand
    except ImportError:
        logger.debug("langgraph_api.command unavailable; skip map_cmd patch")
        return

    def _patched_map_cmd(cmd: RunCommand) -> Command:
        goto = cmd.get("goto")
        if goto is not None and not isinstance(goto, list):
            goto = [cmd.get("goto")]

        update = cmd.get("update")
        if isinstance(update, tuple | list) and all(
            isinstance(t, tuple | list) and len(t) == 2 and isinstance(t[0], str)
            for t in cast("list", update)
        ):
            update = [tuple(t) for t in cast("list", update)]

        if goto:
            resolved_goto: Any = [
                it if isinstance(it, str) else Send(it["node"], it["input"])  # type: ignore[index]
                for it in goto
            ]
        else:
            resolved_goto = ()

        return Command(
            update=update,
            goto=resolved_goto,
            resume=cmd.get("resume"),
        )

    lg_cmd.map_cmd = _patched_map_cmd
    _PATCHED = True
    logger.info("Applied langgraph_api map_cmd patch (resume-only commands use goto=())")


__all__ = ["apply_langgraph_command_patch"]
