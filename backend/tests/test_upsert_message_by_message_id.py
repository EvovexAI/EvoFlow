"""Upsert chat transcript rows by message_id (dept group streaming finalize)."""
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


class UpsertMessageByMessageIdTest(unittest.TestCase):
    tmp_dir: tempfile.TemporaryDirectory | None = None
    db_path: str | None = None
    _previous_db_path: str | None = None
    _previous_storage_env: str | None = None

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp_dir = tempfile.TemporaryDirectory(prefix="evoflow-upsert-msg-")
        cls.db_path = str(Path(cls.tmp_dir.name) / "evoflow.db")
        # resolve_evolflow_db_path 优先读 EVOFLOW_DB_PATH（STORAGE_SQLITE_PATH  alone 无效）
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
        from evoflow.persistence.session_repositories import invalidate_session_select_cache

        db_mod.reset_db_for_tests()
        # 每个用例清文件，避免同 class 共用临时库残留行
        try:
            Path(self.db_path or "").unlink(missing_ok=True)
        except OSError:
            pass
        conn = db_mod.get_db(storage_sqlite_path=self.db_path)
        ensure_app_schema(conn)
        invalidate_session_select_cache()

    def tearDown(self) -> None:
        from evoflow.persistence import db as db_mod
        from evoflow.persistence.session_repositories import invalidate_session_select_cache

        invalidate_session_select_cache()
        db_mod.reset_db_for_tests()

    def test_insert_then_overwrite_same_message_id(self) -> None:
        from evoflow.persistence import chat_message_repositories as msg_repo
        from evoflow.persistence.db import get_db
        from evoflow.persistence.session_repositories import upsert_session_row

        sk = "dept:rd:chat"
        mid = "agent-dev-a-1"
        upsert_session_row(sk, title="研发群", context={"dept_group_id": "rd"})

        first = msg_repo.upsert_message_by_message_id(
            sk,
            role="assistant",
            message_id=mid,
            content="",
            content_json={
                "content": "",
                "dept_group": {
                    "msg_kind": "agent",
                    "speaker_code": "dev-a",
                    "stream_state": "streaming",
                    "work_session_key": "proactive:dev-a:chat:dept-rd",
                    "wake_job_id": "job-1",
                },
            },
            turn_state="streaming",
        )
        self.assertIsNotNone(first)
        self.assertFalse(first.get("updated"))
        seq = first["seq"]

        second = msg_repo.upsert_message_by_message_id(
            sk,
            role="assistant",
            message_id=mid,
            content="已完成方案",
            content_json={
                "content": "已完成方案",
                "dept_group": {
                    "msg_kind": "agent",
                    "speaker_code": "dev-a",
                    "stream_state": "final",
                    "work_session_key": "proactive:dev-a:chat:dept-rd",
                    "wake_job_id": "job-1",
                },
            },
            turn_state="final",
        )
        self.assertIsNotNone(second)
        self.assertTrue(second.get("updated"))
        self.assertEqual(second["seq"], seq)

        conn = get_db()
        rows = conn.execute(
            "SELECT message_id, turn_state, content_json FROM evoflow_chat_messages WHERE session_key = ?",
            (sk,),
        ).fetchall()
        self.assertEqual(len(rows), 1)
        self.assertEqual(str(rows[0][0]), mid)
        self.assertEqual(str(rows[0][1]), "final")
        blob = str(rows[0][2] or "")
        self.assertIn("已完成方案", blob)
        self.assertIn("work_session_key", blob)

    def test_distinct_message_ids_keep_separate_rows(self) -> None:
        from evoflow.persistence import chat_message_repositories as msg_repo
        from evoflow.persistence.session_repositories import upsert_session_row

        sk = "dept:rd:chat"
        upsert_session_row(sk, title="研发群", context={})
        msg_repo.upsert_message_by_message_id(
            sk,
            role="user",
            message_id="user-1",
            content="hi",
            content_json={"content": "hi", "dept_group": {"msg_kind": "user"}},
            turn_state="final",
        )
        msg_repo.upsert_message_by_message_id(
            sk,
            role="assistant",
            message_id="agent-1",
            content="yo",
            content_json={"content": "yo", "dept_group": {"msg_kind": "agent"}},
            turn_state="final",
        )
        self.assertEqual(msg_repo.count_messages(sk), 2)

    def test_http_flat_kwargs_message_id_stripped_before_service(self) -> None:
        """Mirrors chat_sessions.append: _flat_append_kwargs includes message_id."""
        from evoflow.persistence import chat_message_repositories as msg_repo
        from evoflow.persistence import chat_session_service as chat_svc
        from evoflow.persistence.session_repositories import upsert_session_row

        sk = "dept:rd:chat"
        mid = "bubble-http-1"
        upsert_session_row(sk, title="研发群", context={"dept_group_id": "rd"})
        flat = {
            "message_id": mid,
            "content_json": {
                "content": "from panel",
                "dept_group": {"msg_kind": "user", "dept_id": "rd", "stream_state": "final"},
            },
            "tool_call_id": None,
            "tool_name": None,
            "model_name": None,
            "input_tokens": None,
            "output_tokens": None,
            "total_tokens": None,
        }
        flat.pop("message_id", None)
        flat.pop("messageId", None)
        result = chat_svc.upsert_message_and_touch_session(
            sk,
            role="user",
            message_id=mid,
            content="from panel",
            turn_state="final",
            **flat,
        )
        self.assertIsNotNone(result)
        self.assertEqual(int(result.get("messageCount") or 0), 1)
        self.assertEqual(msg_repo.count_messages(sk), 1)

    def test_late_streaming_write_cannot_downgrade_final(self) -> None:
        """乱序到达的流式 upsert 不得把已 final 的气泡拖回 partial（2026-11 单调性守卫）。"""
        from evoflow.persistence import chat_message_repositories as msg_repo
        from evoflow.persistence.db import get_db
        from evoflow.persistence.session_repositories import upsert_session_row

        sk = "dept:rd:chat"
        mid = "agent-dev-a-1"
        upsert_session_row(sk, title="研发群", context={})
        msg_repo.upsert_message_by_message_id(
            sk,
            role="assistant",
            message_id=mid,
            content="",
            content_json={"content": "完整正文", "dept_group": {"msg_kind": "agent", "stream_state": "final"}},
            turn_state="final",
        )
        stale = msg_repo.upsert_message_by_message_id(
            sk,
            role="assistant",
            message_id=mid,
            content="",
            content_json={"content": "半截正文", "dept_group": {"msg_kind": "agent", "stream_state": "streaming"}},
            turn_state="streaming",
        )
        self.assertIsNotNone(stale)
        self.assertFalse(stale.get("updated"))
        self.assertTrue(stale.get("staleSkipped"))
        row = get_db().execute(
            "SELECT turn_state, content_json FROM evoflow_chat_messages WHERE session_key = ? AND message_id = ?",
            (sk, mid),
        ).fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(str(row[0]), "final")
        self.assertIn("完整正文", str(row[1] or ""))
        self.assertNotIn("半截正文", str(row[1] or ""))


if __name__ == "__main__":
    unittest.main()
