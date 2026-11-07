"""POST /api/chat/sessions 必须禁止非 owner 接管已存在的 session_key。

部门群聊 key（``dept:{id}:chat``）完全可枚举，且前端每次打开部门群都会调
create；无防护时第二个成员会 force-restamp 所有权并读走第一个成员的
全部历史（越权读 + 原 owner 404）。本测试锁住 2026-11 的接管防护：
- 已存在 key：非 owner 且非管理员 → 409，所有权不变
- 已存在 key：owner 重创 / 管理员重创 → 放行
- 不存在的 key：正常创建并归属调用者
"""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

_BACKEND_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND_ROOT))
sys.path.insert(0, str(_BACKEND_ROOT / "packages" / "harness"))


def _ensure_subagent_mock() -> None:
    if "evoflow.subagents.executor" not in sys.modules:
        executor_mock = MagicMock()
        executor_mock.SubagentExecutor = MagicMock
        executor_mock.SubagentResult = MagicMock
        executor_mock.SubagentStatus = MagicMock
        executor_mock.MAX_CONCURRENT_SUBAGENTS = 5
        executor_mock.get_background_task_result = MagicMock()
        sys.modules["evoflow.subagents.executor"] = executor_mock


_ensure_subagent_mock()


def _jwt_request(principal_hint: str):
    from starlette.requests import Request

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/api/chat/sessions",
        "headers": [],
        "query_string": b"",
        "state": {"webui_user": {"sub": principal_hint}},
    }
    return Request(scope)


class ChatSessionCreateTakeoverGuardTest(unittest.TestCase):
    tmp_dir: tempfile.TemporaryDirectory | None = None
    db_path: str | None = None
    _previous_db_path: str | None = None
    _previous_storage_env: str | None = None

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp_dir = tempfile.TemporaryDirectory(prefix="evoflow-takeover-guard-")
        cls.db_path = str(Path(cls.tmp_dir.name) / "evoflow.db")
        cls._previous_db_path = os.environ.get("EVOFLOW_DB_PATH")
        cls._previous_storage_env = os.environ.get("EVOFLOW_STORAGE_SQLITE_PATH")
        os.environ["EVOFLOW_DB_PATH"] = cls.db_path
        os.environ["EVOFLOW_STORAGE_SQLITE_PATH"] = cls.db_path

    @classmethod
    def tearDownClass(cls) -> None:
        if cls._previous_db_path is None:
            os.environ.pop("EVOFLOW_DB_PATH", None)
        else:
            os.environ["EVOFLOW_DB_PATH"] = cls._previous_db_path
        if cls._previous_storage_env is None:
            os.environ.pop("EVOFLOW_STORAGE_SQLITE_PATH", None)
        else:
            os.environ["EVOFLOW_STORAGE_SQLITE_PATH"] = cls._previous_storage_env
        if cls.tmp_dir is not None:
            cls.tmp_dir.cleanup()
            cls.tmp_dir = None

    def setUp(self) -> None:
        from evoflow.persistence import db as db_mod
        from evoflow.persistence.schema import ensure_app_schema
        from evoflow.persistence.session_repositories import (
            invalidate_session_select_cache,
            upsert_session_row,
        )

        db_mod.reset_db_for_tests()
        try:
            Path(self.db_path or "").unlink(missing_ok=True)
        except OSError:
            pass
        conn = db_mod.get_db(storage_sqlite_path=self.db_path)
        ensure_app_schema(conn)
        invalidate_session_select_cache()
        # 部门群会话：user-a 创建并持有
        upsert_session_row("dept:rd:chat", title="研发群", context={"dept_group_id": "rd"})
        from evoflow.authz.session_ownership import stamp_session_ownership

        stamp_session_ownership(
            "dept:rd:chat",
            {"principal_id": "user-a", "org_id": "org-1"},
            force=True,
        )

    def tearDown(self) -> None:
        from evoflow.persistence import db as db_mod
        from evoflow.persistence.session_repositories import invalidate_session_select_cache

        invalidate_session_select_cache()
        db_mod.reset_db_for_tests()

    def _principal(self, pid: str):
        return {
            "principal_id": pid,
            "org_id": "org-1",
            "display_name": pid,
            "attrs": {"username": pid},
        }

    def _created_by(self, sk: str) -> str:
        from evoflow.persistence.session_repositories import get_session_row_for_ui

        return str((get_session_row_for_ui(sk) or {}).get("createdBy") or "")

    def test_non_owner_cannot_takeover_existing_key(self) -> None:
        from fastapi import HTTPException

        from app.gateway.routers import chat_sessions as router
        from evoflow.authz import admin_grants as admin_mod
        from evoflow.authz import context as authz_ctx

        with (
            patch.object(authz_ctx, "resolve_request_principal", return_value=self._principal("user-b")),
            patch.object(admin_mod, "is_org_admin", return_value=False),
        ):
            with self.assertRaises(HTTPException) as cm:
                asyncio.run(
                    router.create_chat_session(
                        _jwt_request("user-b"),
                        router.CreateSessionBody(sessionKey="dept:rd:chat", title="抢过来的"),
                    )
                )
        self.assertEqual(cm.exception.status_code, 409)
        self.assertEqual(self._created_by("dept:rd:chat"), "user-a")

    def test_owner_recreate_is_allowed(self) -> None:
        from app.gateway.routers import chat_sessions as router
        from evoflow.authz import admin_grants as admin_mod
        from evoflow.authz import context as authz_ctx

        with (
            patch.object(authz_ctx, "resolve_request_principal", return_value=self._principal("user-a")),
            patch.object(admin_mod, "is_org_admin", return_value=False),
        ):
            resp = asyncio.run(
                router.create_chat_session(
                    _jwt_request("user-a"),
                    router.CreateSessionBody(sessionKey="dept:rd:chat", title="研发群", ensureThread=False),
                )
            )
        self.assertEqual(resp.createdBy, "user-a")

    def test_admin_recreate_is_allowed(self) -> None:
        from app.gateway.routers import chat_sessions as router
        from evoflow.authz import admin_grants as admin_mod
        from evoflow.authz import context as authz_ctx

        with (
            patch.object(authz_ctx, "resolve_request_principal", return_value=self._principal("admin-b")),
            patch.object(admin_mod, "is_org_admin", return_value=True),
        ):
            resp = asyncio.run(
                router.create_chat_session(
                    _jwt_request("admin-b"),
                    router.CreateSessionBody(sessionKey="dept:rd:chat", ensureThread=False),
                )
            )
        self.assertEqual(resp.createdBy, "admin-b")

    def test_new_key_still_creates_with_caller_ownership(self) -> None:
        from app.gateway.routers import chat_sessions as router
        from evoflow.authz import admin_grants as admin_mod
        from evoflow.authz import context as authz_ctx

        with (
            patch.object(authz_ctx, "resolve_request_principal", return_value=self._principal("user-b")),
            patch.object(admin_mod, "is_org_admin", return_value=False),
        ):
            resp = asyncio.run(
                router.create_chat_session(
                    _jwt_request("user-b"),
                    router.CreateSessionBody(sessionKey="dept:new:chat", ensureThread=False),
                )
            )
        self.assertEqual(resp.createdBy, "user-b")
        self.assertEqual(self._created_by("dept:new:chat"), "user-b")


if __name__ == "__main__":
    unittest.main()
