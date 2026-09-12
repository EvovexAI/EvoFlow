"""Worker tool allowlist resolution for task_tool / collab subtasks."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from evoflow.collab.worker_tool_allowlist import (
    resolve_worker_tool_allowlist,
    session_tool_context_from_runtime,
)
from evoflow.tools.builtins.task_tool import (
    _COLLAB_SUBTASK_MANDATORY_TOOLS,
    _merge_collab_subtask_tool_allowlist,
)


def test_merge_collab_tools_none_inherits_subagent_catalog() -> None:
    allowed = {"read_file", "write_file", "terminal", *_COLLAB_SUBTASK_MANDATORY_TOOLS}
    assert (
        _merge_collab_subtask_tool_allowlist(
            overrides_tools=None,
            final_tools=None,
            allowed_tool_names=allowed,
        )
        is None
    )


def test_merge_collab_tools_appends_mandatory_to_explicit_allowlist() -> None:
    allowed = {"read_file", "write_file", "terminal", *_COLLAB_SUBTASK_MANDATORY_TOOLS}
    merged = _merge_collab_subtask_tool_allowlist(
        overrides_tools=["read_file", "write_file", "terminal"],
        final_tools=None,
        allowed_tool_names=allowed,
    )
    assert merged is not None
    assert merged[:3] == ["read_file", "write_file", "terminal"]
    for name in _COLLAB_SUBTASK_MANDATORY_TOOLS:
        assert name in merged


def test_resolve_worker_tools_prefers_profile_tools() -> None:
    catalog = {"read", "write", "replace", "delete", "terminal", "browser", "web_search"}
    out = resolve_worker_tool_allowlist(
        profile_tools=["read", "write"],
        assignee_agent_code="general-purpose",
        base_subagent="general-purpose",
        subagent_config_tools=None,
        catalog_names=catalog,
        session_key=None,
        session_mode="agent",
    )
    assert set(out) >= {"read", "write", "replace", "delete"}  # file-io augment
    assert "browser" not in out
    assert "web_search" not in out


def test_resolve_worker_tools_uses_assignee_agent_config() -> None:
    catalog = {"read", "write", "terminal", "browser", "web_search", "rg"}

    class _Cfg:
        tools = ["read", "terminal"]

    with patch(
        "evoflow.collab.worker_tool_allowlist._load_agent_tools_whitelist",
        side_effect=lambda code: ["read", "terminal"] if code == "project-implementer" else None,
    ):
        out = resolve_worker_tool_allowlist(
            profile_tools=None,
            assignee_agent_code="project-implementer",
            base_subagent="general-purpose",
            subagent_config_tools=None,
            catalog_names=catalog,
            session_key="agent:main:thread-1",
            session_mode="plan",
        )
    assert "read" in out
    assert "terminal" in out
    assert "browser" not in out


def test_resolve_worker_tools_uses_subagent_config_allowlist() -> None:
    catalog = {"bash", "read", "write", "replace", "terminal", "browser"}
    out = resolve_worker_tool_allowlist(
        profile_tools=None,
        assignee_agent_code=None,
        base_subagent="bash",
        subagent_config_tools=["bash", "ls", "read_file", "write_file", "str_replace"],
        catalog_names=catalog,
        session_key=None,
        session_mode="agent",
    )
    assert "bash" in out or "terminal" in out
    assert "read" in out
    assert "write" in out
    assert "replace" in out
    assert "browser" not in out


def test_resolve_worker_tools_inherits_session_agent_not_global_dump() -> None:
    catalog = {
        "tool_search",
        "read",
        "rg",
        "replace",
        "write",
        "delete",
        "mind_map",
        "terminal",
        "browser",
        "web_search",
        "process",
        "invoke_acp_agent",
        "pattern_fix",
        "send_message",
    }
    with (
        patch(
            "evoflow.collab.worker_tool_allowlist._load_agent_tools_whitelist",
            return_value=None,
        ),
        patch(
            "evoflow.collab.worker_tool_allowlist._session_agent_mode_catalog",
            return_value=["tool_search", "read", "rg", "replace", "write", "delete", "terminal"],
        ) as mock_session,
    ):
        out = resolve_worker_tool_allowlist(
            profile_tools=None,
            assignee_agent_code="general-purpose",
            base_subagent="general-purpose",
            subagent_config_tools=None,
            catalog_names=catalog,
            session_key="agent:main:thread-1",
            session_mode="agent",
        )
    mock_session.assert_called_once()
    assert "invoke_acp_agent" not in out
    assert "pattern_fix" not in out
    assert "send_message" not in out
    assert "read" in out
    assert "terminal" in out
    assert len(out) < len(catalog)


def test_session_tool_context_from_runtime() -> None:
    runtime = MagicMock()
    with patch(
        "evoflow.agents.lead_agent.runtime_context.runtime_context_mapping",
        return_value={"session_key": "agent:main:t1", "session_mode": "plan"},
    ):
        sk, mode = session_tool_context_from_runtime(runtime)
    assert sk == "agent:main:t1"
    assert mode == "plan"
    assert session_tool_context_from_runtime(None) == (None, None)
