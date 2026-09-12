"""LiveActivityToolMiddleware must not emit thinking after approval interrupt."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from evoflow.agents.middlewares.run_latency_timing_middleware import LiveActivityToolMiddleware


class GraphInterrupt(Exception):
    pass


def test_wrap_tool_call_skips_thinking_on_graph_interrupt() -> None:
    mw = LiveActivityToolMiddleware()
    request = MagicMock()
    request.tool_call = {"name": "delete", "id": "call_x", "args": {}}

    def handler(_req):
        raise GraphInterrupt("paused")

    with patch.object(mw, "_emit_tool_activity", return_value="tid-1"):
        with patch.object(mw, "_emit_tool_finished") as finish:
            with pytest.raises(GraphInterrupt):
                mw.wrap_tool_call(request, handler)
            finish.assert_not_called()


def test_emit_tool_finished_uses_thinking_after_normal_tool() -> None:
    with patch(
        "evoflow.agents.middlewares.run_latency_timing_middleware.emit_agent_activity"
    ) as emit:
        LiveActivityToolMiddleware._emit_tool_finished("tid-1")
        emit.assert_called_once()
        assert emit.call_args.kwargs.get("kind") == "thinking"
