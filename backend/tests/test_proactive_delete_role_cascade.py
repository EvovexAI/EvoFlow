"""Regression: deleting an employee with history must not hit FK constraint failed.

Bug (2026-10-27): ``employees.delete(agent_code=promo-composer, delete_agent=true)``
returned ``FOREIGN KEY constraint failed`` and deleted nothing when the role had
leftover initiatives.

Root cause:
  1. ``ProactiveRepository.delete_role`` step 3 ran bare ``db.execute(DELETE ...)``
     statements on the shared connection. That opens an implicit transaction
     which stays open until ``commit()`` — which only happened in step 5.
  2. Step 4 (``delete_sessions_bulk``) ran ``BEGIN IMMEDIATE`` via
     ``run_db_transaction``, saw the "orphaned transaction" and rolled it back,
     resurrecting the child rows deleted in step 3.
  3. Step 5's ``DELETE FROM evoflow_proactive_roles`` then hit the surviving
     ``evoflow_proactive_initiatives.role_agent_code`` FK and raised. The failure
     was indistinguishable from success because step 3 swallowed every exception
     with ``logger.debug``.

Fix: cascade deletes go through ``run_db_transaction`` (atomic, committed), and
failures propagate instead of being swallowed; role/automation save+delete paths
also stopped leaving implicit transactions behind.
"""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parents[1]

_CASCADE_TABLES = (
    ("evoflow_proactive_initiatives", "role_agent_code"),
    ("evoflow_proactive_approvals", "role_agent_code"),
    ("evoflow_proactive_memory", "role_agent_code"),
    ("evoflow_proactive_cost_log", "role_agent_code"),
    ("evoflow_duty_runs", "agent_code"),
    ("evoflow_proactive_roles", "agent_code"),
)


class DeleteRoleCascadeTest(unittest.TestCase):
    tmp_dir: tempfile.TemporaryDirectory | None = None
    db_path: str | None = None
    _previous_db_env: str | None = None

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp_dir = tempfile.TemporaryDirectory(prefix="evoflow-del-role-")
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
        for table, _col in _CASCADE_TABLES:
            try:
                conn.execute(f"DELETE FROM {table}")
            except Exception:
                pass
        conn.commit()

    # ── helpers ───────────────────────────────────────────────────────────

    def _make_role_with_history(self, code: str = "promo-composer") -> None:
        """Seed one role plus one row in each cascaded child table."""
        from evoflow.persistence.db import get_db
        from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig
        from evoflow.proactive.repositories import ProactiveRepository

        role = ProactiveRole(
            agent_code=code,
            role_name="推广文案",
            config=ProactiveRoleConfig(),
            status="paused",
        )
        ProactiveRepository.save_role(role)

        db = get_db()
        db.execute(
            """
            INSERT INTO evoflow_proactive_initiatives
                (id, role_agent_code, title, description, created_at, updated_at)
            VALUES (?,?,?,?,?,?)
            """,
            (f"init-{code}", code, "周报", "产出周报", "2026-10-27T02:00:00Z", "2026-10-27T02:00:00Z"),
        )
        db.execute(
            """
            INSERT INTO evoflow_proactive_approvals
                (id, initiative_id, role_agent_code, channel, created_at, updated_at)
            VALUES (?,?,?,?,?,?)
            """,
            (f"ap-{code}", f"init-{code}", code, "feishu", "2026-10-27T02:00:00Z", "2026-10-27T02:00:00Z"),
        )
        db.execute(
            """
            INSERT INTO evoflow_proactive_memory (role_agent_code, memory_json, updated_at)
            VALUES (?,?,?)
            """,
            (code, "{}", "2026-10-27T02:00:00Z"),
        )
        db.execute(
            """
            INSERT INTO evoflow_proactive_cost_log
                (role_agent_code, round_id, created_at)
            VALUES (?,?,?)
            """,
            (code, f"round-{code}", "2026-10-27T02:00:00Z"),
        )
        db.execute(
            """
            INSERT INTO evoflow_duty_runs
                (run_id, agent_code, round_id, started_at, created_at, updated_at)
            VALUES (?,?,?,?,?,?)
            """,
            (
                f"run-{code}",
                code,
                f"round-{code}",
                "2026-10-27T02:00:00Z",
                "2026-10-27T02:00:00Z",
                "2026-10-27T02:00:00Z",
            ),
        )
        db.commit()

    def _count(self, table: str, col: str, code: str) -> int:
        from evoflow.persistence.db import get_db

        row = get_db().execute(f"SELECT COUNT(*) FROM {table} WHERE {col} = ?", (code,)).fetchone()
        return int(row[0])

    def _assert_no_residue(self, code: str) -> None:
        for table, col in _CASCADE_TABLES:
            self.assertEqual(self._count(table, col, code), 0, f"{table} still has rows for {code}")

    # ── tests ─────────────────────────────────────────────────────────────

    def test_delete_role_with_initiative_leaves_no_residue(self) -> None:
        """The exact reported failure: role + initiatives + approvals must go."""
        from evoflow.proactive.repositories import ProactiveRepository

        code = "promo-composer"
        self._make_role_with_history(code)
        self.assertEqual(self._count("evoflow_proactive_initiatives", "role_agent_code", code), 1)

        deleted = ProactiveRepository.delete_role(code)

        self.assertTrue(deleted, "delete_role should report the role row was removed")
        self._assert_no_residue(code)

    def test_delete_role_inside_running_event_loop(self) -> None:
        """Async call sites (API router) must behave the same as sync ones."""
        import asyncio

        from evoflow.proactive.repositories import ProactiveRepository

        code = "loop-employee"
        self._make_role_with_history(code)

        async def _run() -> bool:
            return ProactiveRepository.delete_role(code)

        self.assertTrue(asyncio.run(_run()))
        self._assert_no_residue(code)

    def test_cascade_failure_is_not_silently_swallowed(self) -> None:
        """A failing cascade must raise (with context), never look like success."""
        from unittest.mock import patch

        from evoflow.persistence import db as db_mod
        from evoflow.proactive.repositories import ProactiveRepository

        code = "doomed-employee"
        self._make_role_with_history(code)

        real_execute = db_mod._LockedConnection.execute

        def _boom(self, sql, parameters=(), /):  # noqa: ANN001
            if "DELETE FROM evoflow_proactive_initiatives" in " ".join(sql.split()):
                raise RuntimeError("simulated cascade failure")
            return real_execute(self, sql, parameters)

        with patch.object(db_mod._LockedConnection, "execute", _boom):
            with self.assertRaises(RuntimeError):
                ProactiveRepository.delete_role(code)

        # Failure is atomic: nothing half-deleted, role still present for a retry.
        self.assertEqual(self._count("evoflow_proactive_roles", "agent_code", code), 1)
        self.assertEqual(self._count("evoflow_proactive_initiatives", "role_agent_code", code), 1)

    def test_delete_role_mid_async_context_started_elsewhere(self) -> None:
        """Explicit BEGIN IMMEDIATE (as run_db_transaction does) after cleanup works."""
        from evoflow.persistence.db import get_db, run_db_transaction
        from evoflow.proactive.repositories import ProactiveRepository

        code = "txn-employee"
        self._make_role_with_history(code)
        self.assertTrue(ProactiveRepository.delete_role(code))

        # The shared connection must be left without an open transaction.
        db = get_db()
        self.assertFalse(bool(db.in_transaction), "delete_role leaked an open transaction")

        def _touch(tx_db) -> None:  # noqa: ANN001
            tx_db.execute(
                "INSERT INTO evoflow_proactive_memory (role_agent_code, memory_json, updated_at) VALUES (?,?,?)",
                ("after", "{}", "2026-10-27T03:00:00Z"),
            )

        run_db_transaction(_touch)
        self.assertEqual(self._count("evoflow_proactive_memory", "role_agent_code", "after"), 1)


if __name__ == "__main__":
    unittest.main()
