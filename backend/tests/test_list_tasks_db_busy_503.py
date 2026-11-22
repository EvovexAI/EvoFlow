"""list_tasks must return 503 (not 500) on process DB lock timeout."""

from __future__ import annotations

import sqlite3
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from app.gateway.routers import tasks as tasks_mod


@pytest.mark.asyncio
async def test_list_tasks_returns_503_on_db_process_lock(monkeypatch):
    monkeypatch.setattr(tasks_mod, "get_project_storage", lambda: MagicMock())
    monkeypatch.setattr(
        tasks_mod,
        "resolve_authz_from_request",
        lambda _req: {
            "is_admin": True,
            "personal_scope": None,
            "org_scope": None,
            "principal": None,
        },
    )

    def _boom(*_a, **_k):
        raise sqlite3.OperationalError(
            "db_process_lock_timeout: 另一个线程正持有进程内数据库锁"
            "（不是 sqlite 的库文件锁，不要去找别的进程/删 .db-wal）；"
            "等 0.50s 未拿到，直接重试这条操作即可 —— 原错误：database is locked"
            " (asyncio thread waited 0.50s for process lock)"
        )

    monkeypatch.setattr(tasks_mod, "_find_task_row_by_thread", _boom)

    # Call the route function directly: pass concrete Nones so FastAPI Query()
    # default objects don't become truthy session_key / prefer_task_id filters.
    req = MagicMock()
    with pytest.raises(HTTPException) as ei:
        await tasks_mod.list_tasks(
            request=req,
            status=None,
            source=None,
            search=None,
            project_id=None,
            thread_id="8e4715ba-d00f-49ae-a86d-a05b2476b46d",
            session_key=None,
            prefer_task_id=None,
            sort="updated_at",
            order="desc",
            page=1,
            page_size=40,
            limit=None,
            hide_noise=True,
            has_role=False,
        )
    assert ei.value.status_code == 503
    assert ei.value.headers.get("Retry-After") == "1"
    detail = ei.value.detail
    assert isinstance(detail, dict)
    assert detail.get("error_code") == "DATABASE_ERROR"
