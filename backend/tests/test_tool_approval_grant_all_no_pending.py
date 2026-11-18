"""完全访问 / grant_all 下不得再挂 pending、不得再对 UI 暴露待批。"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock

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


class GrantAllNoPendingTest(unittest.TestCase):
    tmp_dir: tempfile.TemporaryDirectory | None = None
    db_path: str | None = None
    _previous_storage_env: str | None = None

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp_dir = tempfile.TemporaryDirectory(prefix="evoflow-grant-all-")
        cls.db_path = str(Path(cls.tmp_dir.name) / "evoflow.db")
        cls._previous_storage_env = os.environ.get("EVOFLOW_DB_PATH")
        os.environ["EVOFLOW_DB_PATH"] = cls.db_path

    @classmethod
    def tearDownClass(cls) -> None:
        try:
            from evoflow.persistence import db as db_mod

            db_mod.reset_db_for_tests()
        except Exception:
            pass
        if cls._previous_storage_env is None:
            os.environ.pop("EVOFLOW_DB_PATH", None)
        else:
            os.environ["EVOFLOW_DB_PATH"] = cls._previous_storage_env
        if cls.tmp_dir is not None:
            cls.tmp_dir.cleanup()
            cls.tmp_dir = None

    def setUp(self) -> None:
        from evoflow.persistence import db as db_mod
        from evoflow.persistence.schema import ensure_app_schema
        from evoflow.persistence.tool_approval_policy import set_global_default_policy

        db_mod.reset_db_for_tests()
        conn = db_mod.get_db(storage_sqlite_path=self.db_path)
        ensure_app_schema(conn)
        set_global_default_policy("session")
        self._sk = f"sk_grant_all_{id(self)}"
        self._tid = f"tid_grant_all_{id(self)}"
        conn.execute(
            """
            INSERT INTO evoflow_chat_sessions (session_key, thread_id, title, created_at, updated_at, is_deleted)
            VALUES (?, ?, '', datetime('now'), datetime('now'), 0)
            """,
            (self._sk, self._tid),
        )
        conn.commit()

    def test_append_pending_skipped_under_grant_all(self) -> None:
        from evoflow.agents.tool_approval_service import append_pending, make_pending_entry
        from evoflow.persistence import tool_approval_repositories as ta_repo
        from evoflow.persistence.tool_approval_policy import set_global_default_policy

        set_global_default_policy("grant_all")
        append_pending(
            self._tid,
            make_pending_entry(
                tool_call_id="tc_bash",
                tool_name="bash",
                args={"command": "ls"},
                summary="ls",
            ),
        )
        self.assertIsNone(ta_repo.get_approval_row(self._sk, "tc_bash"))

    def test_list_pending_clears_ghosts_under_grant_all(self) -> None:
        from evoflow.agents.tool_approval_service import (
            append_pending,
            list_pending_approvals,
            make_pending_entry,
            thread_has_pending_approvals,
        )
        from evoflow.persistence import tool_approval_repositories as ta_repo
        from evoflow.persistence.tool_approval_policy import set_global_default_policy

        # 先在 session 策略下落 pending，再切 grant_all —— 模拟「完全访问后仍残留待批」
        append_pending(
            self._tid,
            make_pending_entry(
                tool_call_id="tc_mcp",
                tool_name="mcp__node_repl__js",
                args={"code": "1"},
                summary="js",
            ),
        )
        self.assertEqual(
            str(ta_repo.get_approval_row(self._sk, "tc_mcp")["status"]),
            ta_repo.STATUS_PENDING,
        )
        set_global_default_policy("grant_all")
        self.assertEqual(list_pending_approvals(self._tid), [])
        self.assertFalse(thread_has_pending_approvals(self._tid))
        self.assertEqual(
            str(ta_repo.get_approval_row(self._sk, "tc_mcp")["status"]),
            ta_repo.STATUS_CANCELLED,
        )


if __name__ == "__main__":
    unittest.main()
