"""Cross-process duty slot claim — two gateways must not double-dispatch a role.

Why this exists
---------------
EvoFlow gateways mount LangGraph in-process but share ``evoflow.db``. Two
gateways therefore run two independent proactive loops over the same roster.
Both saw the same ``next_heartbeat_at`` as due and both dispatched the same
employee in the same cron slot (observed 2026-10-24 19:00: thread ``d81feec2``
on 8013 and ``c64b252f`` on 8012 for the very same employee and slot).

The automation scheduler already solves this with
``evoflow_automation_slot_claims``; the proactive duty loop had no equivalent.
These tests pin the duty-slot behaviour:

* the claim table is created by ``ensure_app_schema``;
* the same slot is claimed by exactly one caller;
* the winner advances ``next_heartbeat_at`` **in the same transaction**, so the
  loser never sees the slot as due again;
* a claim survives a process restart (it lives in SQLite, not process memory);
* a DB failure fails closed (never a double dispatch);
* real OS processes racing for one slot produce exactly one winner.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
_HARNESS_ROOT = _BACKEND_ROOT / "packages" / "harness"


class _DutyClaimTestBase(unittest.TestCase):
    """Per-test isolated ``evoflow.db`` with the full schema."""

    tmp_dir: tempfile.TemporaryDirectory | None = None
    db_path: str | None = None
    _previous_db_env: str | None = None

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp_dir = tempfile.TemporaryDirectory(prefix="evoflow-duty-")
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
        for table in ("evoflow_proactive_duty_claims", "evoflow_proactive_roles"):
            try:
                conn.execute(f"DELETE FROM {table}")
                conn.commit()
            except Exception:
                pass
        conn.execute(
            """
            INSERT INTO evoflow_proactive_roles (
                agent_code, role_name, department, config_json, heartbeat_rrule,
                status, last_heartbeat_at, next_heartbeat_at, created_at, updated_at,
                reports_to, position_code, heartbeat_schedule
            ) VALUES (?, ?, '', '{}', '0 9 * * *', 'active', '', ?, ?, ?, '', '', '')
            """,
            (
                "emp-test",
                "测试岗位",
                "2026-10-25T09:00:00+08:00",
                "2026-10-01T00:00:00Z",
                "2026-10-01T00:00:00Z",
            ),
        )
        conn.commit()


class DutyClaimTableTest(_DutyClaimTestBase):
    """The claim gate is persisted, not process-local."""

    def test_duty_claim_table_created_on_ensure_schema(self) -> None:
        from evoflow.persistence import db as db_mod

        conn = db_mod.get_db(storage_sqlite_path=self.db_path)
        row = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            ("evoflow_proactive_duty_claims",),
        ).fetchone()
        self.assertIsNotNone(row, "evoflow_proactive_duty_claims must be created by ensure_app_schema")

    def test_same_slot_claimed_only_once(self) -> None:
        from evoflow.proactive.repositories import ProactiveRepository

        first = ProactiveRepository.claim_duty_slot(
            "emp-test", slot="2026-10-25T09:00:00+08:00", owner="gw-a"
        )
        second = ProactiveRepository.claim_duty_slot(
            "emp-test", slot="2026-10-25T09:00:00+08:00", owner="gw-b"
        )
        self.assertTrue(first["claimed"], first)
        self.assertFalse(second["claimed"], second)
        self.assertEqual(second["reason"], "duplicate")
        self.assertEqual(second["owner"], "gw-a")

    def test_different_slots_both_claimed(self) -> None:
        from evoflow.proactive.repositories import ProactiveRepository

        a = ProactiveRepository.claim_duty_slot("emp-test", slot="slot-a", owner="gw-a")
        b = ProactiveRepository.claim_duty_slot("emp-test", slot="slot-b", owner="gw-b")
        self.assertTrue(a["claimed"])
        self.assertTrue(b["claimed"])

    def test_winner_advances_next_heartbeat_in_same_transaction(self) -> None:
        """The loser must not see the slot as due again — that is what stops the double dispatch."""
        from evoflow.persistence import db as db_mod
        from evoflow.proactive.repositories import ProactiveRepository

        res = ProactiveRepository.claim_duty_slot(
            "emp-test",
            slot="2026-10-25T09:00:00+08:00",
            owner="gw-a",
            next_heartbeat_at="2026-10-26T09:00:00+08:00",
            last_heartbeat_at="2026-10-25T09:00:00+08:00",
        )
        self.assertTrue(res["claimed"])
        conn = db_mod.get_db(storage_sqlite_path=self.db_path)
        row = conn.execute(
            "SELECT next_heartbeat_at FROM evoflow_proactive_roles WHERE agent_code=?",
            ("emp-test",),
        ).fetchone()
        self.assertEqual(str(row["next_heartbeat_at"]), "2026-10-26T09:00:00+08:00")

    def test_claim_survives_process_restart(self) -> None:
        from evoflow.proactive.repositories import ProactiveRepository

        self.assertTrue(
            ProactiveRepository.claim_duty_slot("emp-test", slot="slot-x", owner="gw-a")["claimed"]
        )
        # Simulate a restart: fresh connection, same DB file.
        from evoflow.persistence import db as db_mod

        db_mod.reset_db_for_tests()
        res = ProactiveRepository.claim_duty_slot("emp-test", slot="slot-x", owner="gw-b")
        self.assertFalse(res["claimed"], "the claim must survive a restart")

    def test_claim_failure_fails_closed(self) -> None:
        from evoflow.persistence import db as db_mod
        from evoflow.proactive.repositories import ProactiveRepository

        original = db_mod.get_db

        def _boom(*_a: object, **_k: object) -> object:
            raise RuntimeError("db down")

        db_mod.get_db = _boom  # type: ignore[assignment]
        try:
            res = ProactiveRepository.claim_duty_slot("emp-test", slot="slot-y", owner="gw-a")
        finally:
            db_mod.get_db = original  # type: ignore[assignment]
        self.assertFalse(res["claimed"], "a dedupe failure must never allow a double dispatch")
        self.assertEqual(res["reason"], "error")

    def test_complete_duty_slot_marks_done(self) -> None:
        from evoflow.proactive.repositories import ProactiveRepository

        ProactiveRepository.claim_duty_slot("emp-test", slot="slot-z", owner="gw-a")
        ProactiveRepository.complete_duty_slot("emp-test", slot="slot-z", status="done")
        rows = ProactiveRepository.list_duty_claims("emp-test")
        self.assertEqual(rows[0]["state"], "done")

    def test_concurrent_processes_only_one_wins(self) -> None:
        """Real OS processes racing for one slot → exactly one winner.

        The children each open their own SQLite connection to the same file, so
        they contend on the write lock; the timeout is generous on purpose (a
        contended ``BEGIN IMMEDIATE`` waits for ``busy_timeout``).
        """
        script = r"""
import json, sys
sys.path.insert(0, %r)
sys.path.insert(0, %r)
from evoflow.proactive.repositories import ProactiveRepository
res = ProactiveRepository.claim_duty_slot("emp-test", slot="race-slot", owner="proc")
print(json.dumps({"claimed": bool(res.get("claimed"))}))
""" % (str(_HARNESS_ROOT), str(_BACKEND_ROOT))

        env = dict(os.environ)
        env["EVOFLOW_DB_PATH"] = str(self.db_path)
        procs = [
            subprocess.Popen(
                [sys.executable, "-c", script],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
                text=True,
            )
            for _ in range(4)
        ]
        winners = 0
        for p in procs:
            out, err = p.communicate(timeout=240)
            self.assertEqual(p.returncode, 0, msg=f"child failed: {err[-800:]}")
            line = out.strip().splitlines()[-1] if out.strip() else "{}"
            try:
                winners += 1 if json.loads(line).get("claimed") else 0
            except json.JSONDecodeError:
                self.fail(f"unexpected child output: {out!r} / {err!r}")
        self.assertEqual(winners, 1, "exactly one process must win the duty slot claim")


if __name__ == "__main__":
    unittest.main()
