"""Regression: deleting an employee must also remove its IM-channel sessions.

Bug (2026-11-01): after ``employees.delete`` the deleted employee's Feishu
conversations kept showing up in the sidebar.

Root causes fixed here:
  1. ``ProactiveRepository.delete_role`` only swept ``proactive:{code}*`` keys.
     Chats arriving through a shared/primary bot are stored as
     ``agent:{code}:{channel}:{chat}`` and were never touched.
  2. The session wipe was fire-and-forget (``asyncio.ensure_future``), so an
     in-flight duty round could recreate ``proactive:{code}:duty:...`` *after*
     the wipe — the session came back ~35 min later in production.
  3. The sidebar list (``list_sessions_for_ui`` / ``search_sessions_for_ui``)
     never checked whether the owning employee still exists, so any historic
     leftover (or a resurrected row) stayed visible forever.

These tests assert all three layers: cleanup completeness, no resurrection, and
list-level filtering.
"""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parents[1]


class EmployeeSessionCleanupTest(unittest.TestCase):
    tmp_dir: tempfile.TemporaryDirectory | None = None
    db_path: str | None = None
    _previous_db_env: str | None = None

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp_dir = tempfile.TemporaryDirectory(prefix="evoflow-del-sessions-")
        cls.db_path = str(Path(cls.tmp_dir.name) / "evoflow.db")
        cls._previous_db_env = os.environ.get("EVOFLOW_DB_PATH")
        os.environ["EVOFLOW_DB_PATH"] = cls.db_path

    @classmethod
    def tearDownClass(cls) -> None:
        try:
            from evoflow.persistence import db as db_mod

            db_mod.reset_db_for_tests()
        except Exception:
            pass
        if cls._previous_db_env is None:
            os.environ.pop("EVOFLOW_DB_PATH", None)
        else:
            os.environ["EVOFLOW_DB_PATH"] = cls._previous_db_env
        if cls.tmp_dir is not None:
            cls.tmp_dir.cleanup()
            cls.tmp_dir = None

    def setUp(self) -> None:
        from evoflow.persistence import db as db_mod
        from evoflow.persistence.schema import ensure_app_schema

        db_mod.reset_db_for_tests()
        conn = db_mod.get_db(storage_sqlite_path=self.db_path)
        ensure_app_schema(conn)
        for table in (
            "evoflow_chat_sessions",
            "evoflow_chat_messages",
            "evoflow_proactive_roles",
        ):
            try:
                conn.execute(f"DELETE FROM {table}")
            except Exception:
                pass
        conn.commit()

    # ── helpers ───────────────────────────────────────────────────────────

    def _seed_role(self, code: str, role_name: str = "测试员工") -> None:
        from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig
        from evoflow.proactive.repositories import ProactiveRepository

        ProactiveRepository.save_role(
            ProactiveRole(
                agent_code=code,
                role_name=role_name,
                config=ProactiveRoleConfig(),
                status="paused",
            )
        )

    def _seed_session(self, session_key: str, *, title: str = "") -> None:
        from evoflow.persistence.db import get_db

        db = get_db()
        db.execute(
            """
            INSERT INTO evoflow_chat_sessions
                (session_key, thread_id, title, created_at, updated_at,
                 message_count, context_json, is_deleted, hidden_from_list)
            VALUES (?, '', ?, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', 1, '{}', 0, 0)
            """,
            (session_key, title),
        )
        db.commit()

    def _session_exists(self, session_key: str) -> bool:
        from evoflow.persistence.db import get_db

        row = (
            get_db()
            .execute(
                "SELECT is_deleted FROM evoflow_chat_sessions WHERE session_key = ?",
                (session_key,),
            )
            .fetchone()
        )
        if row is None:
            return False
        return int(row[0] or 0) == 0

    # ── layer 1: cleanup completeness ─────────────────────────────────────

    def test_delete_role_wipes_both_proactive_and_channel_sessions(self) -> None:
        """`proactive:` panel runs AND `agent:` IM chats must both be removed."""
        from evoflow.proactive.repositories import ProactiveRepository

        code = "emp-sweep-me"
        self._seed_role(code)
        keys = [
            f"proactive:{code}",
            f"proactive:{code}:duty:round-2026-11-01T17-00-01",
            f"proactive:{code}:task:2610311631_0f7c",
            f"proactive:{code}:chat:feishu:oc_abc123",
            f"agent:{code}:feishu:oc_abc123",
            f"agent:{code}:wecom:chat-9",
        ]
        for k in keys:
            self._seed_session(k)

        # A different employee's session must survive.
        other = f"proactive:{code}-other:duty:round-x"
        self._seed_session(other)
        self._seed_role(f"{code}-other")

        self.assertTrue(ProactiveRepository.delete_role(code))

        for k in keys:
            self.assertFalse(self._session_exists(k), f"session survived delete: {k}")
        self.assertTrue(self._session_exists(other), "unrelated employee session was wiped")

    def test_channel_session_patterns_cover_both_families(self) -> None:
        from evoflow.proactive.chat_session import employee_session_key_like_patterns

        patterns = employee_session_key_like_patterns("emp-1")
        self.assertIn("proactive:emp-1", patterns)
        self.assertIn("proactive:emp-1:%", patterns)
        self.assertIn("agent:emp-1:%", patterns)

    def test_owner_code_parsing(self) -> None:
        from evoflow.proactive.chat_session import employee_code_from_session_key

        self.assertEqual(employee_code_from_session_key("proactive:emp-1:duty:r1"), "emp-1")
        self.assertEqual(employee_code_from_session_key("proactive:emp-1"), "emp-1")
        self.assertEqual(employee_code_from_session_key("agent:emp-1:feishu:oc_1"), "emp-1")
        self.assertEqual(employee_code_from_session_key("agent:main:new-abc"), "main")
        self.assertEqual(employee_code_from_session_key("agent:executor:SubThread_1"), "executor")
        self.assertEqual(employee_code_from_session_key(""), "")

    # ── layer 2: no resurrection ──────────────────────────────────────────

    def test_prepare_session_refuses_deleted_employee(self) -> None:
        """A duty round finishing after deletion must not recreate its session."""
        from evoflow.proactive.chat_session import prepare_proactive_chat_session
        from evoflow.proactive.repositories import ProactiveRepository

        code = "emp-ghost"
        self._seed_role(code)
        self.assertTrue(ProactiveRepository.delete_role(code))

        sk = prepare_proactive_chat_session(
            agent_code=code,
            role_name="幽灵员工",
            thread_id="thread-ghost-1",
            prompt="本轮值班开始",
            round_id="round:2026-11-01T18:00:00",
            kind="think",
        )
        self.assertIsNone(sk, "prepare must refuse sessions for a deleted employee")
        self.assertFalse(
            self._session_exists(f"proactive:{code}:duty:round-2026-11-01T18-00-00"),
            "deleted employee session was resurrected",
        )

    def test_prepare_session_allows_live_employee(self) -> None:
        from evoflow.proactive.chat_session import prepare_proactive_chat_session

        code = "emp-alive"
        self._seed_role(code)

        sk = prepare_proactive_chat_session(
            agent_code=code,
            role_name="在职员工",
            thread_id="thread-alive-1",
            prompt="本轮值班开始",
            round_id="round:2026-11-01T18:00:00",
            kind="think",
        )
        self.assertTrue(sk, "live employee must still get a session")
        self.assertTrue(self._session_exists(sk))

    # ── layer 3: sidebar filtering ────────────────────────────────────────

    def test_list_hides_sessions_of_deleted_employees(self) -> None:
        from evoflow.persistence import session_repositories as sess_repo
        from evoflow.proactive.repositories import ProactiveRepository

        live = "emp-live-1"
        dead = "emp-dead-1"
        self._seed_role(live, "在职员工")
        self._seed_role(dead, "将被删除")

        self._seed_session(f"proactive:{live}:duty:round-1", title="在职值班")
        self._seed_session(f"agent:{dead}:feishu:oc_1", title="已删员工飞书")
        self._seed_session(f"proactive:{dead}:duty:round-1", title="已删员工值班")
        self._seed_session("agent:main:new-1", title="主对话")

        self.assertTrue(ProactiveRepository.delete_role(dead))

        # Simulate a historic leftover that the delete cascade missed entirely.
        self._seed_session(f"proactive:{dead}:duty:round-leftover", title="历史遗留")

        rows = sess_repo.list_sessions_for_ui(limit=50)
        keys = {str(r.get("sessionKey") or r.get("session_key") or "") for r in rows}

        self.assertIn(f"proactive:{live}:duty:round-1", keys, "live employee session hidden")
        self.assertIn("agent:main:new-1", keys, "main chat must never be filtered")
        self.assertNotIn(f"agent:{dead}:feishu:oc_1", keys, "deleted employee IM chat still listed")
        self.assertNotIn(
            f"proactive:{dead}:duty:round-leftover", keys, "deleted employee leftover still listed"
        )

    def test_search_hides_sessions_of_deleted_employees(self) -> None:
        from evoflow.persistence import session_repositories as sess_repo

        dead = "emp-dead-2"
        self._seed_session(f"agent:{dead}:feishu:oc_2", title="幽灵飞书会话")

        rows = sess_repo.search_sessions_for_ui("幽灵", limit=20)
        keys = {str(r.get("sessionKey") or r.get("session_key") or "") for r in rows}
        self.assertNotIn(f"agent:{dead}:feishu:oc_2", keys, "search leaked a deleted employee session")


if __name__ == "__main__":
    unittest.main()
