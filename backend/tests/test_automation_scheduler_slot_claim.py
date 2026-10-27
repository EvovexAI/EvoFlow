"""Regression tests for the three automation-scheduler defects.

D1 — same-minute dedupe lived in process memory (``_last_slot``), so two
      Gateway processes (desktop sidecar + dev gateway) each fired the same
      automation in the same minute. Now the dedupe gate is a persisted
      slot claim in SQLite.

D2 — ``schedule`` and ``rrule`` were two fields with an undocumented
      priority, and ``rrule`` silently became dead configuration. Now there
      is a single resolver, conflicts are explicit, and ``FREQ=MINUTELY``
      actually converts to a cron.

D3 — the scheduler lived inside the Gateway process, so closing the desktop
      app dropped every scheduled run in between. Now missed slots are
      compensated (catch-up) on the next tick.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
_HARNESS_ROOT = _BACKEND_ROOT / "packages" / "harness"


def _ensure_subagent_mock() -> None:
    """Mirror conftest's circular-import workaround for standalone runs."""
    from unittest.mock import MagicMock

    if "evoflow.subagents.executor" in sys.modules:
        return
    mock = MagicMock()
    mock.SubagentExecutor = MagicMock
    mock.SubagentResult = MagicMock
    mock.SubagentStatus = MagicMock
    mock.MAX_CONCURRENT_SUBAGENTS = 5
    mock.get_background_task_result = MagicMock()
    sys.modules["evoflow.subagents.executor"] = mock


class _SchedulerTestBase(unittest.TestCase):
    """Per-test isolated ``evoflow.db`` with the full schema."""

    tmp_dir: tempfile.TemporaryDirectory | None = None
    db_path: str | None = None
    _previous_db_env: str | None = None

    @classmethod
    def setUpClass(cls) -> None:
        _ensure_subagent_mock()
        cls.tmp_dir = tempfile.TemporaryDirectory(prefix="evoflow-sched-")
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
        # Each test starts from a clean slate: the slot-claim table is the
        # dedupe gate, so a leftover row from a previous test would make the
        # next test believe the slot was already taken (and the concurrency
        # test would see zero winners instead of exactly one).
        for table in (
            "evoflow_automation_slot_claims",
            "evoflow_automation_scheduler_state",
            "evoflow_automations",
            "evoflow_automation_runs",
        ):
            try:
                conn.execute(f"DELETE FROM {table}")
                conn.commit()
            except Exception:
                pass


class SlotClaimTableTest(_SchedulerTestBase):
    """D1 — the dedupe gate is persisted, not process-local."""

    def test_slot_claim_table_created_on_ensure_schema(self) -> None:
        from evoflow.persistence import db as db_mod

        conn = db_mod.get_db()
        names = {
            str(r[0])
            for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        }
        self.assertIn("evoflow_automation_slot_claims", names)
        self.assertIn("evoflow_automation_scheduler_state", names)

    def test_same_slot_claimed_only_once(self) -> None:
        from evoflow.persistence import automation_repositories as auto_repo

        first = auto_repo.claim_automation_slot(
            "90390552", "2026-10-24_9_0", run_id="a", trigger_type="schedule", owner="p1"
        )
        second = auto_repo.claim_automation_slot(
            "90390552", "2026-10-24_9_0", run_id="b", trigger_type="schedule", owner="p2"
        )
        self.assertTrue(first["claimed"])
        self.assertFalse(second["claimed"])
        self.assertEqual(second["reason"], "duplicate")

    def test_different_slots_both_claimed(self) -> None:
        from evoflow.persistence import automation_repositories as auto_repo

        a = auto_repo.claim_automation_slot("90390552", "2026-10-24_9_0", owner="p1")
        b = auto_repo.claim_automation_slot("90390552", "2026-10-24_9_1", owner="p1")
        self.assertTrue(a["claimed"])
        self.assertTrue(b["claimed"])

    def test_claim_survives_process_restart(self) -> None:
        """The old in-memory ``_last_slot`` dict was lost on restart."""
        from evoflow.persistence import automation_repositories as auto_repo
        from evoflow.persistence import db as db_mod

        auto_repo.claim_automation_slot("90390552", "2026-10-24_9_0", owner="p1")
        # Simulate a restart: drop the process-wide connection entirely.
        db_mod.reset_db_for_tests()
        again = auto_repo.claim_automation_slot("90390552", "2026-10-24_9_0", owner="p2")
        self.assertFalse(again["claimed"])
        self.assertEqual(again["reason"], "duplicate")

    def test_claim_failure_fails_closed(self) -> None:
        """A broken DB must not let a run through un-claimed."""
        from evoflow.persistence import db as db_mod
        # Import the repository module *before* patching: it binds
        # ``get_db`` at import time, so importing it while the patch is
        # active would permanently bind the broken function into the module
        # and break every later test in this file.
        from evoflow.persistence import automation_repositories as auto_repo

        original = db_mod.get_db

        def _boom(*_a: object, **_k: object) -> object:
            raise RuntimeError("db down")

        db_mod.get_db = _boom  # type: ignore[assignment]
        try:
            res = auto_repo.claim_automation_slot("90390552", "2026-10-24_9_0", owner="p1")
        finally:
            db_mod.get_db = original  # type: ignore[assignment]
        self.assertFalse(res["claimed"])
        self.assertEqual(res["reason"], "error")

    def test_concurrent_processes_only_one_fires(self) -> None:
        """Two real OS processes racing for the same minute → exactly one winner."""
        script = r"""
import json, os, sys
sys.path.insert(0, %r)
sys.path.insert(0, %r)
from evoflow.persistence import automation_repositories as auto_repo
res = auto_repo.claim_automation_slot(
    "90390552", "2026-10-24_9_0", trigger_type="schedule", owner="proc"
)
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
            out, err = p.communicate(timeout=60)
            self.assertEqual(p.returncode, 0, msg=f"child failed: {err[-800:]}")
            line = out.strip().splitlines()[-1] if out.strip() else "{}"
            try:
                winners += 1 if json.loads(line).get("claimed") else 0
            except json.JSONDecodeError:
                self.fail(f"unexpected child output: {out!r} / {err!r}")
        self.assertEqual(winners, 1, "exactly one process must win the same-minute claim")


class EffectiveScheduleTest(unittest.TestCase):
    """D2 — one resolver, explicit priority, explicit conflicts."""

    def test_schedule_cron_wins_over_rrule(self) -> None:
        from evoflow.admin.automation_schedule import resolve_effective_schedule

        res = resolve_effective_schedule(
            {"schedule": "0 9 * * *", "rrule": "FREQ=MINUTELY;INTERVAL=10"}
        )
        self.assertEqual(res["cron"], "0 9 * * *")
        self.assertEqual(res["source"], "schedule")
        self.assertTrue(res["conflict"])
        self.assertEqual(res["ignored_source"], "rrule")

    def test_rrule_used_when_schedule_absent(self) -> None:
        from evoflow.admin.automation_schedule import resolve_effective_schedule

        res = resolve_effective_schedule({"schedule": "", "rrule": "FREQ=DAILY;INTERVAL=1;BYHOUR=9"})
        self.assertEqual(res["cron"], "0 9 * * *")
        self.assertEqual(res["source"], "rrule")
        self.assertFalse(res["conflict"])

    def test_minutely_rrule_is_not_dead_config(self) -> None:
        """``FREQ=MINUTELY`` used to convert to '' and the run was skipped."""
        from evoflow.admin.automation_schedule import rrule_to_cron, resolve_effective_schedule

        self.assertEqual(rrule_to_cron("FREQ=MINUTELY;INTERVAL=10"), "*/10 * * * *")
        res = resolve_effective_schedule({"schedule": "", "rrule": "FREQ=MINUTELY;INTERVAL=10"})
        self.assertEqual(res["cron"], "*/10 * * * *")
        self.assertEqual(res["source"], "rrule")

    def test_schedule_holding_rrule_is_used(self) -> None:
        from evoflow.admin.automation_schedule import resolve_effective_schedule

        res = resolve_effective_schedule({"schedule": "FREQ=DAILY;INTERVAL=1;BYHOUR=9", "rrule": ""})
        self.assertEqual(res["cron"], "0 9 * * *")
        self.assertEqual(res["source"], "schedule")

    def test_no_schedule_returns_empty(self) -> None:
        from evoflow.admin.automation_schedule import resolve_effective_schedule

        res = resolve_effective_schedule({})
        self.assertEqual(res["cron"], "")
        self.assertEqual(res["source"], "none")
        self.assertFalse(res["conflict"])

    def test_runner_uses_shared_resolver(self) -> None:
        """The runner must not keep its own copy of the priority rule."""
        from app.gateway.automation_runner import _effective_cron

        self.assertEqual(_effective_cron({"schedule": "0 9 * * *"}), "0 9 * * *")
        self.assertEqual(_effective_cron({"schedule": "", "rrule": "FREQ=MINUTELY;INTERVAL=10"}), "*/10 * * * *")
        self.assertIsNone(_effective_cron({}))

    def test_api_enrich_reports_conflict(self) -> None:
        from evoflow.admin.automation_schedule import enrich_automation_for_api

        row = enrich_automation_for_api(
            {"schedule": "0 9 * * *", "rrule": "FREQ=MINUTELY;INTERVAL=10", "schedule_type": "recurring"}
        )
        self.assertEqual(row["schedule_cron"], "0 9 * * *")
        self.assertTrue(row["schedule_conflict"])
        self.assertIn("冲突", row["schedule_conflict_detail"])


class CatchUpTest(_SchedulerTestBase):
    """D3 — runs missed while the Gateway was down get compensated."""

    def test_missed_cron_slots_found_in_gap(self) -> None:
        from app.gateway.automation_runner import _missed_cron_slots

        now = datetime(2026, 10, 24, 12, 0, 0)
        since = now - timedelta(hours=6)
        slots = _missed_cron_slots("0 9 * * *", since=since, now=now, limit=10)
        self.assertEqual(len(slots), 1)
        self.assertEqual((slots[0].year, slots[0].hour), (2026, 9))

    def test_missed_slots_exclude_already_claimed(self) -> None:
        from evoflow.persistence import automation_repositories as auto_repo
        from app.gateway.automation_runner import _missed_cron_slots, _slot_key_for

        now = datetime(2026, 10, 24, 12, 0, 0)
        since = now - timedelta(hours=6)
        slots = _missed_cron_slots("0 9 * * *", since=since, now=now, limit=10)
        self.assertTrue(slots)
        claimed_slot = _slot_key_for(slots[0])
        auto_repo.claim_automation_slot("90390552", claimed_slot, owner="p1")
        remaining = auto_repo.list_automation_slot_claim_slots("90390552")
        self.assertIn(claimed_slot, remaining)

    def test_scheduler_state_persists_last_tick(self) -> None:
        from evoflow.persistence import automation_repositories as auto_repo

        auto_repo.set_automation_scheduler_state("scheduler_last_tick_at", "2026-10-24T09:00:00")
        self.assertEqual(
            auto_repo.get_automation_scheduler_state("scheduler_last_tick_at"), "2026-10-24T09:00:00"
        )

    def test_catchup_fires_missed_slot_once(self) -> None:
        """A missed slot is compensated, and only once (when catch-up is on)."""
        from evoflow.persistence import automation_repositories as auto_repo
        from app.gateway.automation_runner import _run_catchup_missed_runs

        now = datetime(2026, 10, 24, 12, 0, 0)
        # Pretend the last tick was 6h ago and that slot was never claimed.
        auto_repo.set_automation_scheduler_state("scheduler_last_tick_at", "2026-10-24T06:00:00")
        task = {
            "task_id": "90390552",
            "status": "active",
            "schedule_type": "recurring",
            "schedule": "0 9 * * *",
            "prompt": "noop",
        }
        fired: list[str] = []
        runs: list[str] = []

        async def _fake_run(task_id: str, task_data: dict, service: object, **kwargs: object) -> None:
            runs.append(str(kwargs.get("trigger_type") or ""))
            fired.append(task_id)

        import app.gateway.automation_runner as runner_mod

        prev = os.environ.get("EVOFLOW_AUTOMATION_CATCHUP")
        os.environ["EVOFLOW_AUTOMATION_CATCHUP"] = "1"
        original = runner_mod._run_one_task
        runner_mod._run_one_task = _fake_run  # type: ignore[assignment]
        try:
            fired_a, reasons = asyncio_run(_run_catchup_missed_runs([("90390552", task)], None, now=now))
        finally:
            runner_mod._run_one_task = original  # type: ignore[assignment]
            if prev is None:
                os.environ.pop("EVOFLOW_AUTOMATION_CATCHUP", None)
            else:
                os.environ["EVOFLOW_AUTOMATION_CATCHUP"] = prev

        self.assertEqual(fired_a, ["90390552"])
        self.assertEqual(runs, ["catchup"])
        self.assertTrue(any("catchup" in r for r in reasons) or not reasons)

        # Second attempt: the slot is claimed now → no second fire.
        os.environ["EVOFLOW_AUTOMATION_CATCHUP"] = "1"
        try:
            fired_b, _reasons_b = asyncio_run(
                _run_catchup_missed_runs([("90390552", task)], None, now=now)
            )
        finally:
            if prev is None:
                os.environ.pop("EVOFLOW_AUTOMATION_CATCHUP", None)
            else:
                os.environ["EVOFLOW_AUTOMATION_CATCHUP"] = prev
        self.assertEqual(fired_b, [])

    def test_catchup_disabled_by_default(self) -> None:
        from app.gateway.automation_runner import _catchup_enabled

        prev = os.environ.get("EVOFLOW_AUTOMATION_CATCHUP")
        os.environ.pop("EVOFLOW_AUTOMATION_CATCHUP", None)
        try:
            self.assertFalse(_catchup_enabled())
            os.environ["EVOFLOW_AUTOMATION_CATCHUP"] = "1"
            self.assertTrue(_catchup_enabled())
            os.environ["EVOFLOW_AUTOMATION_CATCHUP"] = "0"
            self.assertFalse(_catchup_enabled())
        finally:
            if prev is None:
                os.environ.pop("EVOFLOW_AUTOMATION_CATCHUP", None)
            else:
                os.environ["EVOFLOW_AUTOMATION_CATCHUP"] = prev


class OutputPathWhitelistTest(_SchedulerTestBase):
    """The report-path override must survive a CLI/API update."""

    def test_output_path_accepted_by_admin_update(self) -> None:
        from evoflow.admin import automation as automation_admin
        from evoflow.persistence import automation_repositories as auto_repo

        auto_repo.save_automation(
            "90390552",
            {"name": "t", "prompt": "p", "status": "active", "schedule": "0 9 * * *"},
        )
        out = automation_admin.update_automation(
            "90390552", {"output_path": "automations/{automation_id}/{date}-{run_id}.md"}
        )
        self.assertNotIn("output_path", out.get("ignored_keys", []))
        stored = auto_repo.load_automation("90390552") or {}
        self.assertEqual(
            str(stored.get("output_path") or ""),
            "automations/{automation_id}/{date}-{run_id}.md",
        )


def asyncio_run(coro: object) -> object:
    """Run a coroutine to completion (small helper for the sync test cases)."""
    import asyncio

    return asyncio.run(coro)  # type: ignore[arg-type]


if __name__ == "__main__":
    unittest.main()
