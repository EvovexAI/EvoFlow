"""Tests for session_workspace tool."""

from __future__ import annotations

import json
from pathlib import Path

from langchain.tools import ToolRuntime

from evoflow.tools.builtins.session_workspace_tool import session_workspace_tool


def _runtime(*, workspace: str, thread_id: str = "t-ws") -> ToolRuntime:
    class _Ctx:
        def get(self, key: str, default: object = None) -> object:
            return default

    return ToolRuntime(
        state={},
        context=_Ctx(),
        config={
            "configurable": {
                "local_workspace_root": workspace,
                "thread_id": thread_id,
            }
        },
        stream_writer=lambda _event: None,
        tool_call_id="test-ws",
        store=None,
    )


def test_session_workspace_query(tmp_path: Path) -> None:
    raw = session_workspace_tool.invoke(
        {"action": "query", "runtime": _runtime(workspace=str(tmp_path))},
    )
    data = json.loads(raw)
    assert data["ok"] is True
    assert data["action"] == "query"
    assert data["thread_id"] == "t-ws"
    assert data["local_workspace_root"] == str(tmp_path)


def test_session_workspace_create(tmp_path: Path) -> None:
    target = tmp_path / "nested" / "dir"
    raw = session_workspace_tool.invoke(
        {
            "action": "create",
            "path": str(target),
            "runtime": _runtime(workspace=str(tmp_path)),
        },
    )
    data = json.loads(raw)
    assert data["ok"] is True
    assert target.is_dir()


def test_session_workspace_create_requires_path(tmp_path: Path) -> None:
    raw = session_workspace_tool.invoke(
        {"action": "create", "runtime": _runtime(workspace=str(tmp_path))},
    )
    data = json.loads(raw)
    assert data["ok"] is False
    assert "path is required" in data["error"]
