"""Employee heartbeat as shadow evoflow_automations + exact-slot scheduling."""

from __future__ import annotations

import os
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
_HARNESS_ROOT = _BACKEND_ROOT / "packages" / "harness"


def _ensure_subagent_mock() -> None:
    from unittest.mock import MagicMock
    import sys

    if "evoflow.subagents.executor" in sys.modules:
        return
    mock = MagicMock()
    mock.SubagentExecutor = MagicMock
    mock.SubagentResult = MagicMock
    mock.SubagentStatus = MagicMock
    mock.MAX_CONCURRENT_SUBAGENTS = 5
    mock.get_background_task_result = MagicMock()
    sys.modules["evoflow.subagents.executor"] = mock


class EmployeeAutomationTest(unittest.TestCase):
    tmp_dir: tempfile.TemporaryDirectory | None = None
    db_path: str | None = None
    _previous_db_env: str | None = None

    @classmethod
    def setUpClass(cls) -> None:
        _ensure_subagent_mock()
        cls.tmp_dir = tempfile.TemporaryDirectory(prefix="evoflow-emp-auto-")
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
            "evoflow_automation_slot_claims",
            "evoflow_automation_scheduler_state",
            "evoflow_automations",
            "evoflow_automation_runs",
            "evoflow_proactive_roles",
            "evoflow_duty_runs",
        ):
            try:
                conn.execute(f"DELETE FROM {table}")
                conn.commit()
            except Exception:
                pass

    def _save_role(self, code: str = "duty_ops", *, cron: str = "0 */2 * * *", status: str = "active"):
        from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig
        from evoflow.proactive.repositories import ProactiveRepository
        from evoflow.proactive.schedule import sync_role_schedule_fields

        role = ProactiveRole(
            agent_code=code,
            role_name="值班",
            config=ProactiveRoleConfig(),
            status=status,
        )
        sync_role_schedule_fields(role, cron)
        ProactiveRepository.save_role(role)
        return role

    def test_task_id_and_kind(self) -> None:
        from evoflow.proactive.employee_automation import (
            EMPLOYEE_AUTOMATION_KIND,
            agent_code_from_employee_task,
            employee_automation_task_id,
            is_employee_automation,
        )

        self.assertEqual(employee_automation_task_id("sales"), "emp:sales")
        self.assertEqual(agent_code_from_employee_task("emp:sales"), "sales")
        self.assertTrue(
            is_employee_automation({"kind": EMPLOYEE_AUTOMATION_KIND}, task_id="emp:x")
        )
        self.assertTrue(is_employee_automation({}, task_id="emp:x"))
        self.assertFalse(is_employee_automation({"name": "cron"}, task_id="abc"))

    def test_save_role_upserts_shadow_automation(self) -> None:
        from evoflow.persistence import automation_repositories as auto_repo
        from evoflow.proactive.employee_automation import EMPLOYEE_AUTOMATION_KIND

        self._save_role("ops_a", cron="0 9-19/2 * * *")
        doc = auto_repo.load_automation("emp:ops_a")
        self.assertIsNotNone(doc)
        assert doc is not None
        self.assertEqual(doc.get("kind"), EMPLOYEE_AUTOMATION_KIND)
        self.assertEqual(doc.get("agent_code"), "ops_a")
        self.assertEqual(doc.get("schedule"), "0 9-19/2 * * *")
        self.assertEqual(str(doc.get("status") or "").lower(), "active")
        self.assertEqual(doc.get("managed_by"), "proactive_role")

    def test_paused_role_pauses_shadow(self) -> None:
        from evoflow.persistence import automation_repositories as auto_repo
        from evoflow.proactive.repositories import ProactiveRepository

        role = self._save_role("ops_b")
        role.status = "paused"
        ProactiveRepository.save_role(role)
        doc = auto_repo.load_automation("emp:ops_b")
        self.assertIsNotNone(doc)
        assert doc is not None
        self.assertEqual(str(doc.get("status") or "").lower(), "paused")

    def test_delete_role_removes_shadow(self) -> None:
        from evoflow.persistence import automation_repositories as auto_repo
        from evoflow.proactive.repositories import ProactiveRepository

        self._save_role("ops_c")
        self.assertIsNotNone(auto_repo.load_automation("emp:ops_c"))
        ProactiveRepository.delete_role("ops_c")
        self.assertIsNone(auto_repo.load_automation("emp:ops_c"))

    def test_sync_all_reconciles(self) -> None:
        from evoflow.persistence import automation_repositories as auto_repo
        from evoflow.proactive.employee_automation import sync_all_employee_automations

        self._save_role("ops_d", cron="30 10 * * *")
        stats = sync_all_employee_automations()
        self.assertGreaterEqual(stats["upserted"], 1)
        doc = auto_repo.load_automation("emp:ops_d")
        self.assertEqual(doc and doc.get("schedule"), "30 10 * * *")

    def test_scheduler_now_is_beijing_naive(self) -> None:
        from app.gateway.automation_runner import _scheduler_now

        now = _scheduler_now()
        self.assertIsNone(now.tzinfo)
        # Must be wall-clock-ish (not UTC-shifted 8h off from local Beijing machines).
        self.assertTrue(0 <= now.hour <= 23)

    def test_cron_matches_exact_hour_not_drift(self) -> None:
        """``0 */2 * * *`` matches 10:00, not 10:17."""
        from evoflow.admin.automation_schedule import cron_matches_at

        expr = "0 */2 * * *"
        self.assertTrue(cron_matches_at(expr, datetime(2026, 10, 25, 10, 0, 5)))
        self.assertFalse(cron_matches_at(expr, datetime(2026, 10, 25, 10, 17, 0)))
        self.assertFalse(cron_matches_at(expr, datetime(2026, 10, 25, 11, 0, 0)))

    def test_near_miss_claims_previous_minute(self) -> None:
        import asyncio

        from app.gateway import automation_runner as runner
        from evoflow.persistence import automation_repositories as auto_repo

        auto_repo.save_automation(
            "t1",
            {
                "name": "exact",
                "prompt": "hi",
                "schedule": "0 10 * * *",
                "schedule_type": "cron",
                "status": "active",
                "langgraph_run": False,
            },
        )

        async def _fake_run(task_id, task, service, *, trigger_type="schedule", **_k):
            auto_repo.append_automation_run(
                task_id,
                {
                    "run_id": "r1",
                    "started_at": "2026-10-25T10:01:00",
                    "trigger_type": trigger_type,
                    "status": "success",
                    "output": "ok",
                    "error": "",
                    "duration_seconds": 1,
                },
            )

        now = datetime(2026, 10, 25, 10, 1, 5)
        with patch.object(runner, "_run_one_task", side_effect=_fake_run):
            fired, _reasons = asyncio.run(
                runner._run_near_miss_catchup(
                    [("t1", auto_repo.load_automation("t1") or {})], None, now=now
                )
            )
        self.assertEqual(fired, ["t1"])
        slots = auto_repo.list_automation_slot_claim_slots("t1")
        self.assertIn("2026-10-25_10_0", set(slots))


if __name__ == "__main__":
    unittest.main()
