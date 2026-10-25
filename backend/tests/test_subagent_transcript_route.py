"""Subagent transcript endpoint — chat-panel task_id (≡ tool_call_id) must not 404.

回归：task_id 形态是 tool_call_id，不在 tasks 表 → require_task_visible 走
owner 链查到空 owner → 非 admin 一律 404，前端子代理面板永远拿不到 transcript
（表现：右侧面板打开但不刷新、看不到历史）。改按父线程鉴权后应 200。
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.gateway.deps.license import require_premium
from app.gateway.routers import tasks as tasks_router


@pytest.fixture()
def client() -> TestClient:
    app = FastAPI()
    app.include_router(tasks_router.router)
    app.dependency_overrides[require_premium] = lambda: None
    return TestClient(app)


def _fake_result() -> SimpleNamespace:
    return SimpleNamespace(
        status=SimpleNamespace(value="running"),
        result="",
        error=None,
        started_at=None,
        completed_at=None,
        stream_messages=[
            {"type": "human", "role": "user", "content": "读取项目概览"},
            {"type": "ai", "role": "assistant", "content": "仓库根目录包含 backend/ 与 evopanel/"},
        ],
        ai_messages=[],
        thread_id="thread-parent-1",
    )


def test_tool_call_id_transcript_not_404(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """内存命中（task_id ≡ tool_call_id）→ 按父线程鉴权 → 200 + messages。"""
    from evoflow.subagents import executor as executor_mod

    monkeypatch.setattr(
        executor_mod,
        "get_background_task_result_or_snapshot",
        lambda task_id: _fake_result() if task_id == "call_test_1" else None,
    )
    resp = client.get("/api/tasks/subagent/call_test_1/transcript")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "running"
    assert len(body["messages"]) == 2
    assert body["messages"][1]["content"].startswith("仓库根目录")
    # thread_id 是父线程——前端面板据此禁用子会话桥接
    assert body["thread_id"] == "thread-parent-1"


def test_unknown_id_empty_transcript(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """内存未命中且不在 tasks 表 → 空转写（本地单用户按管理员放行，不泄内容）。"""
    from evoflow.subagents import executor as executor_mod

    monkeypatch.setattr(executor_mod, "get_background_task_result_or_snapshot", lambda task_id: None)
    resp = client.get("/api/tasks/subagent/call_unknown/transcript")
    assert resp.status_code == 200
    body = resp.json()
    assert body.get("empty") is True
    assert body.get("messages") == []
