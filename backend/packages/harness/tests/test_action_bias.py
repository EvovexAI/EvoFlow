"""Tests for task-type action bias hints."""

from __future__ import annotations

from evoflow.exploration.action_bias import (
    format_action_hint,
    format_implement_action_hint,
    is_ready_to_act,
    looks_like_edit_task,
    read_threshold_for_task,
    should_suppress_exploration_gaps,
)
from evoflow.exploration.task_router import TASK_IMPLEMENT, classify_task_type_heuristic


def test_classify_ui_layout_as_implement():
    assert classify_task_type_heuristic("把 Requests 筛选栏合并成一行") == TASK_IMPLEMENT
    assert classify_task_type_heuristic("改一下页面布局") == TASK_IMPLEMENT
    assert looks_like_edit_task("调整 global.css 的 filter-row")


def test_classify_data_bug_without_ui_edit_stays_data_bug():
    assert classify_task_type_heuristic("agent-trace 表格显示数据有问题") == "data_bug"


def test_implement_action_hint():
    hint = format_action_hint("t-x", task_type="implement", read_count=2)
    assert hint
    assert "action_bias" in hint
    assert "worker" in hint
    assert format_action_hint("t-x", task_type="implement", read_count=1) == ""


def test_data_bug_hint_prefers_verify_not_blind_edit():
    hint = format_action_hint("t-x", task_type="data_bug", read_count=2)
    assert hint
    assert "curl" in hint.lower() or "API" in hint
    assert "verify" in hint.lower() or "对比" in hint


def test_understand_code_hint_no_worker_edit():
    hint = format_action_hint("t-x", task_type="understand_code", read_count=2)
    assert hint
    assert "prose" in hint.lower() or "explain" in hint.lower()
    assert "worker(" not in hint


def test_runtime_hint():
    hint = format_action_hint("t-x", task_type="runtime", read_count=1)
    assert hint
    assert "log" in hint.lower() or "health" in hint.lower() or "process" in hint.lower()


def test_implement_alias():
    assert format_implement_action_hint("t-x", task_type="implement", read_count=2) == format_action_hint(
        "t-x", task_type="implement", read_count=2
    )


def test_read_thresholds():
    assert read_threshold_for_task("implement") == 2
    assert read_threshold_for_task("runtime") == 1
    assert is_ready_to_act("t", task_type="runtime", read_count=1)
    assert not is_ready_to_act("t", task_type="implement", read_count=1)


def test_suppress_gaps_implement_not_data_bug():
    assert should_suppress_exploration_gaps("t", task_type="implement", read_count=2)
    assert not should_suppress_exploration_gaps("t", task_type="data_bug", read_count=2)
