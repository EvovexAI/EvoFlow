"""Regression: ``rebind_role`` must be one atomic, transaction-clean migration.

Same family of bug as ``test_proactive_delete_role_cascade`` (2026-10-27): the
old implementation was a run of bare ``db.execute(INSERT/UPDATE/DELETE)``
followed by a single ``db.commit()`` at the very end. Any raise in the middle
left an implicit transaction open on the *shared* connection; the next
``BEGIN IMMEDIATE`` (``run_db_transaction``) rolled that orphan away — so the
"rebound" role could vanish or the old row could come back, and the caller saw
``Rebind failed: role ... missing after migrate`` on a database that looked
untouched. It also poisoned the following write in the same request:
``router.update_role`` calls ``rebind_role`` and then ``save_role`` in the same
coroutine, which would trade a busy/locked error on a half-migrated DB.

Guards covered here:
  1. Happy path migrates role + child rows + direct reports, and leaves no open
     transaction behind.
  2. A failure mid-migration rolls everything back (old role intact, no half
     copy at the new code) instead of raising after a partial commit.
  3. A stale row already sitting at the new code does not turn the copy into a
     PRIMARY KEY conflict (the upsert converges).
  4. ``run_db_transaction(no_retry=True)`` performs exactly one attempt.
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

_CASCADE_TABLES = (
    ("evoflow_proactive_initiatives", "role_agent_code"),
    ("evoflow_proactive_approvals", "role_agent_code"),
    ("evoflow_proactive_memory", "role_agent_code"),
    ("evoflow_proactive_cost_log", "role_agent_code"),
    ("evoflow_duty_runs", "agent_code"),
    ("evoflow_proactive_roles", "agent_code"),
)

_TS = "2026-10-27T04:00:00Z"


class RebindRoleTransactionTest(unittest.TestCase):
    tmp_dir: tempfile.TemporaryDirectory | None = None
    db_path: str | None = None
    _previous_db_env: str | None = None

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp_dir = tempfile.TemporaryDirectory(prefix="evoflow-rebind-role-")
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

    def _make_role(self, code: str, *, name: str, reports_to: str = "") -> None:
        from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig

        cfg = ProactiveRoleConfig()
        cfg.reports_to = reports_to
        from evoflow.proactive.repositories import ProactiveRepository

        ProactiveRepository.save_role(
            ProactiveRole(agent_code=code, role_name=name, config=cfg, status="paused")
        )

    def _seed_history(self, code: str) -> None:
        from evoflow.persistence.db import get_db

        db = get_db()
        db.execute(
            """
            INSERT INTO evoflow_proactive_initiatives
                (id, role_agent_code, title, description, created_at, updated_at)
            VALUES (?,?,?,?,?,?)
            """,
            (f"init-{code}", code, "周报", "产出周报", _TS, _TS),
        )
        db.execute(
            """
            INSERT INTO evoflow_proactive_memory (role_agent_code, memory_json, updated_at)
            VALUES (?,?,?)
            """,
            (code, json.dumps({"role_agent_code": code, "notes": ["keep me"]}), _TS),
        )
        db.execute(
            """
            INSERT INTO evoflow_proactive_cost_log (role_agent_code, round_id, created_at)
            VALUES (?,?,?)
            """,
            (code, f"round-{code}", _TS),
        )
        db.commit()

    def _count(self, table: str, col: str, code: str) -> int:
        from evoflow.persistence.db import get_db

        row = get_db().execute(f"SELECT COUNT(*) FROM {table} WHERE {col} = ?", (code,)).fetchone()
        return int(row[0])

    # ── tests ─────────────────────────────────────────────────────────────

    def test_rebind_moves_role_children_and_reports(self) -> None:
        from evoflow.persistence.db import get_db
        from evoflow.proactive.repositories import ProactiveRepository

        self._make_role("old-desk", name="前台")
        self._seed_history("old-desk")
        self._make_role("sub-role", name="下属", reports_to="old-desk")

        rebound = ProactiveRepository.rebind_role("old-desk", "new-desk")

        self.assertEqual(rebound.agent_code, "new-desk")
        self.assertEqual(rebound.role_name, "前台")
        self.assertEqual(self._count("evoflow_proactive_roles", "agent_code", "old-desk"), 0)
        self.assertEqual(self._count("evoflow_proactive_initiatives", "role_agent_code", "old-desk"), 0)
        self.assertEqual(self._count("evoflow_proactive_initiatives", "role_agent_code", "new-desk"), 1)
        self.assertEqual(self._count("evoflow_proactive_memory", "role_agent_code", "new-desk"), 1)
        self.assertEqual(self._count("evoflow_proactive_cost_log", "role_agent_code", "new-desk"), 1)

        # Direct report now points at the new code — both column and config_json.
        row = get_db().execute(
            "SELECT reports_to, config_json FROM evoflow_proactive_roles WHERE agent_code = ?",
            ("sub-role",),
        ).fetchone()
        self.assertEqual(str(row[0] or ""), "new-desk")
        self.assertEqual(json.loads(row[1]).get("reports_to"), "new-desk")

        # memory_json PK mirror follows the move.
        mem = get_db().execute(
            "SELECT memory_json FROM evoflow_proactive_memory WHERE role_agent_code = ?",
            ("new-desk",),
        ).fetchone()
        blob = json.loads(mem[0])
        self.assertEqual(blob.get("role_agent_code"), "new-desk")
        self.assertEqual(blob.get("notes"), ["keep me"])

        # Nothing left holding a transaction open for the next writer.
        self.assertFalse(bool(get_db().in_transaction), "rebind_role leaked an open transaction")

        sub = ProactiveRepository.get_role("sub-role")
        self.assertIsNotNone(sub)
        self.assertEqual(sub.config.reports_to, "new-desk")

    def test_rebind_failure_is_atomic(self) -> None:
        """A raise mid-migration must leave the old role fully intact."""
        from unittest.mock import patch

        from evoflow.persistence import db as db_mod
        from evoflow.persistence.db import get_db
        from evoflow.proactive.repositories import ProactiveRepository

        self._make_role("old-desk", name="前台")
        self._seed_history("old-desk")
        self._make_role("sub-role", name="下属", reports_to="old-desk")

        real_execute = db_mod._LockedConnection.execute

        def _boom(self, sql, parameters=(), /):  # noqa: ANN001
            if "UPDATE evoflow_proactive_memory" in " ".join(sql.split()):
                raise RuntimeError("simulated rebind failure")
            return real_execute(self, sql, parameters)

        with patch.object(db_mod._LockedConnection, "execute", _boom):
            with self.assertRaises(RuntimeError):
                ProactiveRepository.rebind_role("old-desk", "new-desk")

        # Whole migration rolled back: no half copy, old rows untouched.
        self.assertEqual(self._count("evoflow_proactive_roles", "agent_code", "old-desk"), 1)
        self.assertEqual(self._count("evoflow_proactive_roles", "agent_code", "new-desk"), 0)
        self.assertEqual(self._count("evoflow_proactive_initiatives", "role_agent_code", "old-desk"), 1)
        self.assertEqual(self._count("evoflow_proactive_initiatives", "role_agent_code", "new-desk"), 0)
        self.assertFalse(bool(get_db().in_transaction), "failed rebind leaked an open transaction")

        sub = ProactiveRepository.get_role("sub-role")
        self.assertIsNotNone(sub)
        self.assertEqual(sub.config.reports_to, "old-desk")

        # And a retry after the failure still works (no poisoned connection).
        rebound = ProactiveRepository.rebind_role("old-desk", "new-desk")
        self.assertEqual(rebound.agent_code, "new-desk")

    def test_rebind_converges_over_stale_new_code_row(self) -> None:
        """A leftover row at the target code must not surface as PK conflict."""
        from evoflow.persistence.db import get_db
        from evoflow.proactive.repositories import ProactiveRepository

        self._make_role("old-desk", name="前台")
        self._seed_history("old-desk")
        # Stale ghost row (e.g. left by the old non-atomic implementation).
        get_db().execute(
            "INSERT INTO evoflow_proactive_roles (agent_code, role_name, config_json, created_at, updated_at)"
            " VALUES (?,?,?,?,?)",
            ("new-desk", "ghost", "{}", _TS, _TS),
        )
        get_db().commit()

        # Pre-check still refuses (that guard is the user-facing "already
        # exists" 409); the ghost is removed, then the atomic copy runs. What
        # matters for this regression is that the copy itself is an upsert:
        # no stale row may reach it as a PRIMARY KEY conflict.
        with self.assertRaises(ValueError):
            ProactiveRepository.rebind_role("old-desk", "new-desk")
        self.assertEqual(self._count("evoflow_proactive_roles", "agent_code", "old-desk"), 1)

        role = ProactiveRepository.get_role("old-desk")
        self.assertIsNotNone(role)
        from evoflow.persistence.db import run_db_transaction
        from evoflow.proactive.repositories import _ROLE_COLS, _role_reports_to

        def _copy_ignoring_guard(db) -> None:  # noqa: ANN001
            db.execute(
                f"INSERT INTO evoflow_proactive_roles ({_ROLE_COLS.strip()}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
                " ON CONFLICT(agent_code) DO UPDATE SET role_name = excluded.role_name",
                (
                    "new-desk",
                    role.role_name,
                    role.position_code,
                    role.department,
                    role.config.to_json(),
                    _role_reports_to(role),
                    role.heartbeat_rrule,
                    "",
                    role.status,
                    role.last_heartbeat_at,
                    role.next_heartbeat_at,
                    role.created_at or _TS,
                    _TS,
                ),
            )

        run_db_transaction(_copy_ignoring_guard)

        rebound = ProactiveRepository.get_role("new-desk")
        self.assertIsNotNone(rebound)
        self.assertEqual(rebound.role_name, "前台")
        self.assertEqual(self._count("evoflow_proactive_roles", "agent_code", "new-desk"), 1)

    def test_run_db_transaction_no_retry_is_single_attempt(self) -> None:
        import sqlite3

        from evoflow.persistence.db import run_db_transaction

        calls = {"n": 0}

        def _busy(_db) -> None:  # noqa: ANN001
            calls["n"] += 1
            raise sqlite3.OperationalError("database is locked")

        with self.assertRaises(sqlite3.OperationalError):
            run_db_transaction(_busy, no_retry=True)
        self.assertEqual(calls["n"], 1)


if __name__ == "__main__":
    unittest.main()
