"""thread_id → session_key 读侧兜底的接线测试。

【self-evolution-bot · 2026-11-27 · 第138轮 · 模型:deepseek-v4-1-flash-261017】
正例：拿 UUID 形态 thread_id 进来 → 必须解析成 session_key 并读到行；
反证：解析不到 → 仍抛 "session not found"（不许悄悄返回空结构）。
"""
from __future__ import annotations

import pytest

from evoflow.session_execution import queries as q


def _row(session_key: str) -> dict:
    return {
        "session_key": session_key,
        "thread_id": "tid-" + session_key,
        "run_status": "done",
        "current_run_id": None,
        "current_turn_started_at": None,
        "current_turn_ended_at": None,
        "updated_at": "2026-11-27T00:00:00",
        "is_deleted": 0,
    }


def test_thread_id_resolves_to_session_key(monkeypatch):
    tid = "c3505a1f-5f86-4e5a-9851-e7edc1cb7aba"
    sk = "proactive:live-notes-keeper:chat"

    # 直接用 thread_id 查不到行（现网真实现象）
    monkeypatch.setattr(q, "_read_chat_session_run_row", lambda k: None if k == tid else _row(sk))
    monkeypatch.setattr(q.sess_repo, "is_session_deleted", lambda k: False)
    monkeypatch.setattr(
        "evoflow.persistence.session_repositories.find_session_key_by_thread_id",
        lambda t: sk if t == tid else None,
    )
    out = q._load_execution_state_db(tid)
    assert out["key"] == sk, "必须把 thread_id 解析成 session_key"
    assert out["db_row"]["session_key"] == sk


def test_unresolvable_id_still_raises(monkeypatch):
    """反证：解析不出来的 id 仍要抛错，不能返回半成品。"""
    monkeypatch.setattr(q, "_read_chat_session_run_row", lambda k: None)
    monkeypatch.setattr(q.sess_repo, "is_session_deleted", lambda k: False)
    monkeypatch.setattr(
        "evoflow.persistence.session_repositories.find_session_key_by_thread_id",
        lambda t: None,
    )
    with pytest.raises(ValueError, match="session not found"):
        q._load_execution_state_db("4bd04c9d-c33d-4539-8ee0-c6900ecb0cb8")
