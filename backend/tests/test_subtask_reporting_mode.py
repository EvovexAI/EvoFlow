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
