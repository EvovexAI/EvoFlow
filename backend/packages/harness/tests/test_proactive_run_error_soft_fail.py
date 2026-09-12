"""Regression: employee LangGraph hard-fail soft-returns error codes (no hang)."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from evoflow.proactive.engine import ProactiveEngine
from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig


@pytest.mark.asyncio
async def test_run_langgraph_agent_returns_graph_build_error_on_422() -> None:
    engine = ProactiveEngine.__new__(ProactiveEngine)

    class FakeHTTPError(Exception):
        def __init__(self) -> None:
            super().__init__("Client error '422 Unprocessable Entity'")
            self.response = SimpleNamespace(status_code=422)

    client = MagicMock()
    client.runs = MagicMock()
    client.runs.wait = AsyncMock(side_effect=FakeHTTPError())
    engine._get_client = MagicMock(return_value=client)

    role = ProactiveRole(
        agent_code="emp1",
        role_name="测试员工",
        config=ProactiveRoleConfig(max_turns=10, timeout_seconds=30),
    )

    with (
        patch("evoflow.proactive.chat_session.prepare_proactive_chat_session"),
        patch("evoflow.proactive.chat_session.finalize_proactive_chat_session"),
        patch("evoflow.proactive.limits.resolve_proactive_recursion_limit", return_value=50),
        patch(
            "evoflow.langgraph_connectivity.create_langgraph_thread",
            new=AsyncMock(return_value={"thread_id": "t1"}),
        ),
        patch(
            "evoflow.langgraph_run_config.merge_configurable_into_context",
            side_effect=lambda c, x: (c, x),
        ),
    ):
        err, cost = await engine._run_langgraph_agent(
            role=role,
            system_prompt="sys",
            user_prompt="user",
            session_key="sk",
            round_id="round:1",
            task_id="task-1",
        )

    assert err == "graph_build_error"
    assert cost is None
