"""CollabPhaseMiddleware: avoid stacking duplicate phase hints on every user turn."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from langchain_core.messages import HumanMessage, SystemMessage

pytest.importorskip("tomllib", reason="evoflow.agents import chain requires Python 3.11+")

from evoflow.agents.middlewares.collab_phase_middleware import CollabPhaseMiddleware
from evoflow.collab.models import CollabPhase


def test_planning_like_skips_inject_main_prompt_has_phase_guard() -> None:
    """planning/plan_ready/awaiting_exec：主提示含 ``phase_execution_guard``，不再叠 ``collab_phase_context``。"""
    mw = CollabPhaseMiddleware()
    rt = MagicMock()
    rt.context = {"collab_phase": CollabPhase.PLANNING.value, "subagent_enabled": True}
    assert mw._inject({"messages": [HumanMessage("hello")]}, rt) is None


def test_inject_skips_when_same_hint_already_in_history() -> None:
    mw = CollabPhaseMiddleware()
    rt = MagicMock()
    rt.context = {
        "collab_phase": CollabPhase.REQ_CONFIRM.value,
        "subagent_enabled": True,
    }

    first = mw._inject({"messages": [HumanMessage("hello")]}, rt)
    assert first is not None
    hint = first["messages"][0]
    assert isinstance(hint, SystemMessage)
    assert getattr(hint, "name", None) == "collab_phase_hint"

    again = mw._inject(
        {
            "messages": [
                hint,
                HumanMessage("second user"),
            ],
        },
        rt,
    )
    assert again is None
