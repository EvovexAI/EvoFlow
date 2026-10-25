"""agui_mirror task_* → kind:"subagent" 行：ZCode subagent 镜像事件契约对齐。

task_id ≡ tool_call_id（task_tool execute_async），subagentRow.parentToolCallId
据此与宿主 Agent 工具卡配对；终态帧不带 subagent_type/description，而 v4 upsert
是整行替换——必须靠 task_started 记账回填，不能清成 general/空摘要。
"""

from __future__ import annotations

from typing import Any

import pytest

from app.gateway.v4.agui_mirror import V4Mirror
from app.gateway.v4.conversation import HUB


def _rows(session_id: str) -> list[dict[str, Any]]:
    sess = HUB.get_session(session_id)
    assert sess is not None
    return sorted(sess.rows.values(), key=lambda r: int(r["rowId"]))


def _subagent_rows(session_id: str) -> list[dict[str, Any]]:
    return [r for r in _rows(session_id) if r.get("kind") == "subagent"]


def _drop(session_id: str) -> None:
    if session_id in getattr(HUB, "_sessions", {}):
        del HUB._sessions[session_id]  # noqa: SLF001


@pytest.fixture()
def mirror_session(monkeypatch: pytest.MonkeyPatch) -> str:
    monkeypatch.setattr("app.gateway.v4.agui_mirror._MIRROR_DISABLED", False)
    return "mirror-subagent-rows-test"


def _feed_run_open(mirror: V4Mirror, tid: str, run_id: str) -> None:
    mirror.note_user_input(tid, "跑个子代理")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": run_id},
            {"type": "TOOL_CALL_START", "toolCallId": "tc-sub", "toolCallName": "subagent"},
            {"type": "TOOL_CALL_END", "toolCallId": "tc-sub"},
        ],
    )


def _custom(chunk: dict[str, Any]) -> dict[str, Any]:
    """AG-UI wire 形态：EVF custom 载荷升成 CUSTOM(name="custom")，chunk 在 value 里。"""
    return {"type": "CUSTOM", "name": "custom", "value": {"type": "custom", "chunk": chunk}}


def test_task_events_project_subagent_row(mirror_session: str) -> None:
    tid = mirror_session + "-basic"
    _drop(tid)
    mirror = V4Mirror(HUB)
    _feed_run_open(mirror, tid, "run-s1")
    mirror.feed_events(
        tid,
        [
            _custom(
                {
                    "type": "task_started",
                    "task_id": "tc-sub",
                    "description": "读取项目概览",
                    "subagent_type": "code-agent",
                }
            ),
        ],
    )
    rows = _subagent_rows(tid)
    assert len(rows) == 1
    row = rows[0]
    assert row["parentToolCallId"] == "tc-sub"
    assert row["subagentType"] == "code-agent"
    assert row["status"] == "running"
    assert row["summaryText"] == "读取项目概览"
    assert row["turnId"] == "run-s1", "subagent 行必须与宿主 toolCall 行同轮（配对键之一）"

    mirror.feed_events(
        tid,
        [
            _custom({"type": "task_completed", "task_id": "tc-sub", "result": "仓库形态：前后端分离。"}),
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-s1"},
        ],
    )
    rows = _subagent_rows(tid)
    assert len(rows) == 1, "终态必须 upsert 同一行，不能 append 重复行"
    assert rows[0]["status"] == "success"
    assert rows[0]["summaryText"] == "仓库形态：前后端分离。"
    assert rows[0]["subagentType"] == "code-agent", "终态帧无 subagent_type，必须回填记账值"
    assert "endedAt" in rows[0]


def test_task_failed_keeps_type_and_error_summary(mirror_session: str) -> None:
    tid = mirror_session + "-failed"
    _drop(tid)
    mirror = V4Mirror(HUB)
    _feed_run_open(mirror, tid, "run-s2")
    mirror.feed_events(
        tid,
        [
            _custom(
                {
                    "type": "task_started",
                    "task_id": "tc-sub",
                    "description": "探查依赖",
                    "subagent_type": "explore-agent",
                }
            ),
            _custom({"type": "task_failed", "task_id": "tc-sub", "error": "model unavailable"}),
        ],
    )
    rows = _subagent_rows(tid)
    assert len(rows) == 1
    assert rows[0]["status"] == "failed"
    assert rows[0]["summaryText"] == "model unavailable"
    assert rows[0]["subagentType"] == "explore-agent"


def test_terminal_after_run_finished_keeps_original_turn(mirror_session: str) -> None:
    """task 终态晚于 RUN_FINISHED（取消/超时清理）也必须落回原轮，配对不断。"""
    tid = mirror_session + "-late"
    _drop(tid)
    mirror = V4Mirror(HUB)
    _feed_run_open(mirror, tid, "run-s3")
    mirror.feed_events(
        tid,
        [
            _custom(
                {
                    "type": "task_started",
                    "task_id": "tc-sub",
                    "description": "长任务",
                    "subagent_type": "code-agent",
                }
            ),
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-s3"},
            _custom({"type": "task_cancelled", "task_id": "tc-sub"}),
        ],
    )
    rows = _subagent_rows(tid)
    assert len(rows) == 1
    assert rows[0]["status"] == "cancelled"
    assert rows[0]["turnId"] == "run-s3", "迟到终态不得挂到空/新 turnId"
    assert rows[0]["summaryText"] == "长任务", "终态无 error/result 时保留原摘要"
    assert rows[0]["subagentType"] == "code-agent"


def test_terminal_without_start_creates_row(mirror_session: str) -> None:
    """task_started 漏收（丢帧/重启）时终态直接落行，Agent 卡不能永远停在 running。"""
    tid = mirror_session + "-orphan-terminal"
    _drop(tid)
    mirror = V4Mirror(HUB)
    _feed_run_open(mirror, tid, "run-s4")
    mirror.feed_events(
        tid,
        [_custom({"type": "task_completed", "task_id": "tc-sub", "result": "done"})],
    )
    rows = _subagent_rows(tid)
    assert len(rows) == 1
    assert rows[0]["status"] == "success"
    assert rows[0]["parentToolCallId"] == "tc-sub"


def test_non_custom_customer_events_ignored(mirror_session: str) -> None:
    """usage / kb_citations 等其它具名 CUSTOM 不得产出 subagent 行。"""
    tid = mirror_session + "-ignore"
    _drop(tid)
    mirror = V4Mirror(HUB)
    _feed_run_open(mirror, tid, "run-s5")
    mirror.feed_events(
        tid,
        [
            {"type": "CUSTOM", "name": "usage", "value": {"type": "usage", "usage": {"x": 1}}},
            {"type": "CUSTOM", "name": "kb_citations", "value": {"type": "kb_citations"}},
        ],
    )
    assert _subagent_rows(tid) == []
