"""Workflow executor session attribution（工作流与会话解耦）.

2026-10-25 用户报告：从聊天触发的工作流，其 worker 消息/用量全部记在聊天会话名下——
但聊天只是运行入口，工作流应独立。根因：``ensure_executor_transcript_session``
的「有 lead 就复用 lead 侧栏会话」策略对 workflow 来源任务不适用（无头派发本来
就正确拿到 ``agent:executor:{tid}``，唯独聊天触发被短路进聊天会话）。
修复：task_tool 委派时对 workflow 任务 ``force_dedicated=True`` 绑定独立会话，
并携带 workflow 标识（app_id/run_id/main_task_id）供日志与用量归属。
"""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

from evoflow.persistence.chat_session_service import (
    ensure_executor_transcript_session,
)

TID = "262b8320-4e58-4d14-a900-edc0e76e18b3__sub__Subtask_20261025151854_760088"
LEAD = "262b8320-4e58-4d14-a900-edc0e76e18b3"
CHAT_SK = "agent:main:new-91fb2169"


def _repo(lead_session: str | None = CHAT_SK):
    upserts: list[dict[str, Any]] = []

    def find(thread_id: str) -> str | None:
        return None  # executor thread has no direct binding yet

    def find_lead(thread_id: str) -> str | None:
        return lead_session if thread_id == LEAD else None

    def upsert(sk: str, **kw: Any) -> None:
        upserts.append({"session_key": sk, **kw})

    return find, find_lead, upsert, upserts


def test_default_policy_reuses_lead_session_for_lead_collab():
    find, find_lead, upsert, upserts = _repo()
    with (
        patch("evoflow.persistence.chat_session_service.sess_repo") as repo,
    ):
        repo.find_session_key_by_thread_id.side_effect = lambda tid: find_lead(tid) if tid == LEAD else find(tid)
        repo.SESSION_STATUS_ACTIVE = "active"
        repo.upsert_session_row.side_effect = upsert
        repo.invalidate_session_key_cache = lambda *_a, **_k: None
        sk = ensure_executor_transcript_session(TID, lead_thread_id=LEAD, collab_task_id="t1")
    assert sk == CHAT_SK  # lead collab 行为保持不变
    assert not upserts


def test_force_dedicated_never_reuses_chat_session():
    _, find_lead, upsert, upserts = _repo()
    with (
        patch("evoflow.persistence.chat_session_service.sess_repo") as repo,
    ):
        repo.find_session_key_by_thread_id.side_effect = lambda tid: find_lead(tid) if tid == LEAD else None
        repo.SESSION_STATUS_ACTIVE = "active"
        repo.upsert_session_row.side_effect = upsert
        repo.invalidate_session_key_cache = lambda *_a, **_k: None
        sk = ensure_executor_transcript_session(
            TID,
            lead_thread_id=LEAD,
            collab_task_id="t1",
            force_dedicated=True,
            workflow={
                "main_task_id": "t1",
                "app_id": "App_x",
                "run_id": "Run_y",
                "app_name": "四节点并行测试流",
            },
        )
    assert sk == f"agent:executor:{TID}"
    assert sk != CHAT_SK
    assert len(upserts) == 1
    row = upserts[0]
    assert row["thread_id"] == TID
    ctx = row["context"]
    assert ctx["workflow_run"] is True
    assert ctx["app_id"] == "App_x" and ctx["run_id"] == "Run_y" and ctx["main_task_id"] == "t1"
    assert "四节点" in row["title"]


def test_existing_direct_binding_wins():
    with (
        patch("evoflow.persistence.chat_session_service.sess_repo") as repo,
    ):
        repo.find_session_key_by_thread_id.side_effect = lambda tid: f"agent:executor:{tid}" if tid == TID else None
        repo.invalidate_session_key_cache = lambda *_a, **_k: None
        sk = ensure_executor_transcript_session(TID, lead_thread_id=LEAD, force_dedicated=True)
        sk2 = ensure_executor_transcript_session(TID, lead_thread_id=LEAD)  # 幂等
    assert sk == sk2 == f"agent:executor:{TID}"
