"""Model hydration must prune verbose ``monitor_execution_step`` supervisor tool rows.

`supervisor(action="monitor_execution_step")` is called in a loop and each row is
multi-KB JSON; the on-disk transcript keeps them all, but we should only feed the
latest snapshot per task back to the model so context stays compact.
"""

from __future__ import annotations

import json

import pytest

from evoflow.persistence.chat_message_repositories import (
    _prune_monitor_execution_step_rows,
    _supervisor_action_and_task_id,
    append_message,
    list_lead_chat_rows_for_model_hydration,
)
from evoflow.persistence.db import reset_db_for_tests


@pytest.fixture
def chat_db(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(tmp_path / "hydrate_monitor_prune.db"))
    reset_db_for_tests()
    return tmp_path


def _supervisor_row(*, action, task_id, mid="", extra=None):
    """Fake supervisor tool row mirroring on-disk ``content_json`` wrapper schema."""
    body = {"action": action, "taskId": task_id}
    if extra:
        body.update(extra)
    row = {
        "role": "tool",
        "tool_name": "supervisor",
        "content_json": json.dumps({"content": json.dumps(body)}),
    }
    if mid:
        row["message_id"] = mid
    return row


def _append_monitor_row(session_key, *, task_id, mid, seq_marker):
    body = {
        "action": "monitor_execution_step",
        "taskId": task_id,
        "ok": True,
        "snapshot": {"step": seq_marker, "subtasks": [{"id": "s1", "status": "running"}] * 12},
    }
    append_message(
        session_key,
        role="tool",
        content=json.dumps(body),
        message_id=mid,
        tool_call_id="tc-" + mid,
        tool_name="supervisor",
    )


def _append_other_supervisor_row(session_key, *, action, task_id, mid):
    body = {"action": action, "taskId": task_id, "ok": True}
    append_message(
        session_key,
        role="tool",
        content=json.dumps(body),
        message_id=mid,
        tool_call_id="tc-" + mid,
        tool_name="supervisor",
    )


# Parser unit tests --------------------------------------------------------


def test_parses_monitor_row():
    row = _supervisor_row(action="monitor_execution_step", task_id="T-7")
    assert _supervisor_action_and_task_id(row) == ("monitor_execution_step", "T-7")


def test_skips_non_supervisor_rows():
    row = _supervisor_row(action="monitor_execution_step", task_id="T-7")
    row["tool_name"] = "read_file"
    assert _supervisor_action_and_task_id(row) == (None, None)


def test_handles_invalid_json():
    row = {"role": "tool", "tool_name": "supervisor", "content_json": "not json"}
    assert _supervisor_action_and_task_id(row) == (None, None)


def test_accepts_task_id_alias():
    row = {
        "role": "tool",
        "tool_name": "supervisor",
        "content_json": json.dumps(
            {"content": json.dumps({"action": "monitor_execution_step", "task_id": "T-8"})}
        ),
    }
    assert _supervisor_action_and_task_id(row) == ("monitor_execution_step", "T-8")


# Pure-prune helper tests (no DB) ------------------------------------------


def test_keeps_last_monitor_per_task():
    rows = [
        {"role": "user", "content_json": "{}"},
        _supervisor_row(action="monitor_execution_step", task_id="T-1", mid="m1", extra={"step": 1}),
        _supervisor_row(action="monitor_execution_step", task_id="T-1", mid="m2", extra={"step": 2}),
        _supervisor_row(action="monitor_execution_step", task_id="T-1", mid="m3", extra={"step": 3}),
        {"role": "assistant", "content_json": "{}"},
    ]
    pruned = _prune_monitor_execution_step_rows(rows, keep_last_per_task=1)
    monitor_mids = [r.get("message_id") for r in pruned if r.get("tool_name") == "supervisor"]
    assert monitor_mids == ["m3"]
    roles = [r.get("role") for r in pruned]
    assert roles == ["user", "tool", "assistant"]


def test_keeps_separate_tasks_independently():
    rows = [
        _supervisor_row(action="monitor_execution_step", task_id="T-A", mid="a1", extra={"step": 1}),
        _supervisor_row(action="monitor_execution_step", task_id="T-B", mid="b1", extra={"step": 1}),
        _supervisor_row(action="monitor_execution_step", task_id="T-A", mid="a2", extra={"step": 2}),
    ]
    pruned = _prune_monitor_execution_step_rows(rows, keep_last_per_task=1)
    mids = [r["message_id"] for r in pruned]
    assert mids == ["b1", "a2"]


def test_leaves_non_monitor_supervisor_actions_alone():
    rows = [
        _supervisor_row(action="create_subtasks", task_id="T-1", mid="c1"),
        _supervisor_row(action="monitor_execution_step", task_id="T-1", mid="m1", extra={"step": 1}),
        _supervisor_row(action="monitor_execution_step", task_id="T-1", mid="m2", extra={"step": 2}),
    ]
    pruned = _prune_monitor_execution_step_rows(rows, keep_last_per_task=1)
    mids = [r["message_id"] for r in pruned]
    assert mids == ["c1", "m2"]


def test_keep_last_per_task_zero_is_disabled():
    rows = [
        _supervisor_row(action="monitor_execution_step", task_id="T-1", mid="m1"),
        _supervisor_row(action="monitor_execution_step", task_id="T-1", mid="m2"),
    ]
    pruned = _prune_monitor_execution_step_rows(rows, keep_last_per_task=0)
    assert pruned is rows


def test_under_keep_limit_is_noop():
    rows = [_supervisor_row(action="monitor_execution_step", task_id="T-1", mid="m1")]
    pruned = _prune_monitor_execution_step_rows(rows, keep_last_per_task=1)
    assert pruned is rows


# DB-end-to-end tests -----------------------------------------------------


def test_hydration_prunes_by_default(chat_db):
    sk = "agent:test:hydrate-monitor-default"
    append_message(sk, role="user", content="kick off task", message_id="u1")
    for i in range(5):
        _append_monitor_row(sk, task_id="T-1", mid="mon-" + str(i), seq_marker=i)

    rows = list_lead_chat_rows_for_model_hydration(sk, limit=40)
    monitor_rows = [
        r for r in rows
        if str(r.get("tool_name") or "") == "supervisor"
        and _supervisor_action_and_task_id(r) == ("monitor_execution_step", "T-1")
    ]
    assert len(monitor_rows) == 1
    assert monitor_rows[0]["message_id"] == "mon-4"


def test_hydration_keep_last_can_be_overridden(chat_db):
    sk = "agent:test:hydrate-monitor-keep2"
    append_message(sk, role="user", content="kick off task", message_id="u1")
    for i in range(4):
        _append_monitor_row(sk, task_id="T-1", mid="mon-" + str(i), seq_marker=i)

    rows = list_lead_chat_rows_for_model_hydration(sk, limit=40, keep_last_monitor_per_task=2)
    monitor_rows = [
        r for r in rows
        if str(r.get("tool_name") or "") == "supervisor"
        and _supervisor_action_and_task_id(r) == ("monitor_execution_step", "T-1")
    ]
    assert [r["message_id"] for r in monitor_rows] == ["mon-2", "mon-3"]


def test_hydration_disable_prune_preserves_all(chat_db):
    sk = "agent:test:hydrate-monitor-disabled"
    append_message(sk, role="user", content="kick off task", message_id="u1")
    for i in range(3):
        _append_monitor_row(sk, task_id="T-1", mid="mon-" + str(i), seq_marker=i)

    rows = list_lead_chat_rows_for_model_hydration(sk, limit=40, keep_last_monitor_per_task=0)
    monitor_rows = [r for r in rows if str(r.get("tool_name") or "") == "supervisor"]
    assert len(monitor_rows) == 3


def test_hydration_handles_mixed_tasks_in_one_session(chat_db):
    sk = "agent:test:hydrate-monitor-multi"
    append_message(sk, role="user", content="kick off", message_id="u1")
    _append_monitor_row(sk, task_id="T-A", mid="mon-a1", seq_marker=1)
    _append_monitor_row(sk, task_id="T-A", mid="mon-a2", seq_marker=2)
    _append_other_supervisor_row(sk, action="create_subtasks", task_id="T-B", mid="cs-1")
    _append_monitor_row(sk, task_id="T-B", mid="mon-b1", seq_marker=1)
    _append_monitor_row(sk, task_id="T-B", mid="mon-b2", seq_marker=2)
    _append_monitor_row(sk, task_id="T-A", mid="mon-a3", seq_marker=3)

    rows = list_lead_chat_rows_for_model_hydration(sk, limit=40)
    monitor_mids = sorted(
        r["message_id"]
        for r in rows
        if str(r.get("tool_name") or "") == "supervisor"
        and _supervisor_action_and_task_id(r)[0] == "monitor_execution_step"
    )
    assert monitor_mids == ["mon-a3", "mon-b2"]
    other_supervisor = [
        r["message_id"]
        for r in rows
        if str(r.get("tool_name") or "") == "supervisor"
        and _supervisor_action_and_task_id(r)[0] == "create_subtasks"
    ]
    assert other_supervisor == ["cs-1"]
