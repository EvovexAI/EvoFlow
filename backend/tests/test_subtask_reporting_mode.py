"""Light vs full subtask reporting ceremony (workflow slim-down)."""

from __future__ import annotations

from evoflow.collab.subtask_reporting import (
    format_subtask_outcome_mandate_block,
    format_subtask_progress_mandate_block,
    resolve_subtask_reporting_mode,
)
from evoflow.tools.builtins.task_tool import (
    _COLLAB_SUBTASK_MANDATORY_TOOLS_FULL,
    _COLLAB_SUBTASK_MANDATORY_TOOLS_LIGHT,
    _collab_mandatory_tools_for_mode,
    _merge_collab_subtask_tool_allowlist,
    _subtask_has_peer_siblings,
)


def test_resolve_light_for_app_sourced_main():
    assert (
        resolve_subtask_reporting_mode(
            subtask_row={"id": "s1", "status": "pending"},
            main_task={"id": "m1", "source_app_id": "App_x"},
        )
        == "light"
    )


def test_resolve_light_for_rollup_step():
    assert (
        resolve_subtask_reporting_mode(
            subtask_row={"id": "s1", "is_rollup_step": True},
            main_task={"id": "m1"},
        )
        == "light"
    )
    assert (
        resolve_subtask_reporting_mode(
            subtask_row={"id": "s1", "ref": "__rollup__"},
            main_task=None,
        )
        == "light"
    )


def test_resolve_full_for_lead_collab():
    assert (
        resolve_subtask_reporting_mode(
            subtask_row={"id": "s1"},
            main_task={"id": "m1", "thread_id": "th1"},
        )
        == "full"
    )


def test_explicit_worker_profile_override():
    assert (
        resolve_subtask_reporting_mode(
            subtask_row={"worker_profile": {"reporting_mode": "full"}, "is_rollup_step": True},
            main_task={"source_app_id": "App_x"},
        )
        == "full"
    )
    assert (
        resolve_subtask_reporting_mode(
            subtask_row={"worker_profile": {"ceremony": "light"}},
            main_task={"id": "m1"},
        )
        == "light"
    )


def test_light_prompts_drop_forced_mid_progress():
    progress = format_subtask_progress_mandate_block(mode="light")
    outcome = format_subtask_outcome_mandate_block(mode="light")
    assert "可选" in progress or "轻量" in progress
    assert "checklist" in progress.lower() or "checklist" in outcome.lower() or "不必" in progress
    assert "`done`" in outcome or "done" in outcome
    assert "必须" in outcome
    # Full mode still forces start progress
    full_p = format_subtask_progress_mandate_block(mode="full")
    assert "5~15" in full_p or "5～15" in full_p or "强制" in full_p


def test_light_mandatory_tools_are_outcome_only():
    assert _collab_mandatory_tools_for_mode("light") == _COLLAB_SUBTASK_MANDATORY_TOOLS_LIGHT
    assert "done" in _COLLAB_SUBTASK_MANDATORY_TOOLS_LIGHT
    assert "checklist" not in _COLLAB_SUBTASK_MANDATORY_TOOLS_LIGHT
    assert "peer_send" not in _COLLAB_SUBTASK_MANDATORY_TOOLS_LIGHT
    assert "peer_send" in _COLLAB_SUBTASK_MANDATORY_TOOLS_FULL


def test_merge_allowlist_light_does_not_force_peer_or_checklist():
    allowed = {
        "bash",
        "read_file",
        "done",
        "progress",
        "checklist",
        "peer_send",
        "peer_read",
        "peer_reply",
    }
    merged = _merge_collab_subtask_tool_allowlist(
        overrides_tools=["bash", "read_file"],
        final_tools=None,
        allowed_tool_names=allowed,
        reporting_mode="light",
    )
    assert merged is not None
    assert "done" in merged
    assert "peer_send" not in merged
    assert "checklist" not in merged

    full = _merge_collab_subtask_tool_allowlist(
        overrides_tools=["bash"],
        final_tools=None,
        allowed_tool_names=allowed,
        reporting_mode="full",
    )
    assert full is not None
    assert "peer_send" in full
    assert "checklist" in full


def test_task_tool_injects_mode_aware_mandate_blocks():
    """Regression: task_tool must forward the resolved reporting_mode into the
    mandate blocks. A bare no-arg call silently falls back to full ceremony even
    when the worker was resolved as light (tool allowlist trimmed but prompt
    still demands checklist/progress)."""
    import importlib
    import inspect

    task_tool_mod = importlib.import_module("evoflow.tools.builtins.task_tool")

    src = inspect.getsource(task_tool_mod)
    assert "format_subtask_progress_mandate_block()" not in src
    assert "format_subtask_outcome_mandate_block()" not in src
    assert "format_subtask_progress_mandate_block(mode=reporting_mode)" in src
    assert "format_subtask_outcome_mandate_block(mode=reporting_mode)" in src


def test_full_mode_without_peers_drops_peer_tools():
    with_peers = _collab_mandatory_tools_for_mode("full", include_peer=True)
    without_peers = _collab_mandatory_tools_for_mode("full", include_peer=False)
    assert "peer_send" in with_peers
    assert "peer_send" not in without_peers
    assert "peer_read" not in without_peers
    assert "peer_reply" not in without_peers
    # Lifecycle reporting still mandatory without peers
    assert {"done", "progress", "checklist"} <= set(without_peers)


def test_merge_allowlist_without_peers_skips_peer_tools():
    allowed = {
        "bash",
        "read_file",
        "done",
        "progress",
        "checklist",
        "peer_send",
        "peer_read",
        "peer_reply",
    }
    merged = _merge_collab_subtask_tool_allowlist(
        overrides_tools=["bash", "read_file"],
        final_tools=None,
        allowed_tool_names=allowed,
        reporting_mode="full",
        include_peer=False,
    )
    assert merged is not None
    assert "done" in merged
    assert "peer_send" not in merged


def test_subtask_has_peer_siblings():
    # Two subtasks under one main task → peers exist
    assert _subtask_has_peer_siblings(
        {"subtasks": [{"id": "s1"}, {"id": "s2"}]},
        "s1",
    )
    # Single subtask that is the worker itself → no peers
    assert not _subtask_has_peer_siblings({"subtasks": [{"id": "s1"}]}, "s1")
    # Single row that is not the worker (weird) → keep peer tools (conservative)
    assert _subtask_has_peer_siblings({"subtasks": [{"id": "sX"}]}, "s1")
    # Unknown main task row → keep today's behaviour
    assert _subtask_has_peer_siblings(None, "s1")
    assert _subtask_has_peer_siblings({}, "s1")
