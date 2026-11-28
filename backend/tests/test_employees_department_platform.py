"""Platform department CRUD: create → members → head → rename → delete."""

from __future__ import annotations

import json
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

_TS = "2026-11-27T00:00:00Z"


class EmployeesDepartmentPlatformTest(unittest.TestCase):
    tmp_dir: tempfile.TemporaryDirectory | None = None
    db_path: str | None = None
    _previous_db_path: str | None = None
    _previous_storage_env: str | None = None

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp_dir = tempfile.TemporaryDirectory(prefix="evoflow-dept-platform-")
        cls.db_path = str(Path(cls.tmp_dir.name) / "evoflow.db")
        cls._previous_db_path = os.environ.get("EVOFLOW_DB_PATH")
        cls._previous_storage_env = os.environ.get("EVOFLOW_STORAGE_SQLITE_PATH")
        os.environ["EVOFLOW_DB_PATH"] = cls.db_path
        os.environ["EVOFLOW_STORAGE_SQLITE_PATH"] = cls.db_path

    @classmethod
    def tearDownClass(cls) -> None:
        from evoflow.persistence import db as db_mod

        db_mod.reset_db_for_tests()
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

        db_mod.reset_db_for_tests()
        try:
            Path(self.db_path or "").unlink(missing_ok=True)
        except OSError:
            pass
        self.db = db_mod.get_db(storage_sqlite_path=self.db_path)

    def _make_role(self, code: str, *, dept: str = "", reports_to: str = "") -> None:
        self.db.execute(
            "INSERT OR REPLACE INTO evoflow_proactive_roles "
            "(agent_code, role_name, department, reports_to, config_json, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?)",
            (
                code,
                code,
                dept,
                reports_to,
                json.dumps({"reports_to": reports_to}),
                _TS,
                _TS,
            ),
        )
        self.db.commit()

    def test_create_members_head_rename_delete(self) -> None:
        from evoflow.admin.platform_handlers import (
            employees_create_department,
            employees_delete_department,
            employees_departments,
            employees_rename_department,
            employees_set_department_head,
            employees_set_department_members,
        )

        created = employees_create_department({"name": "平台测试部"})
        self.assertTrue(created.get("ok"))
        dept_id = str(created.get("dept_id") or "")
        self.assertTrue(dept_id)

        self._make_role("alice-bot")
        self._make_role("bob-bot")

        members = employees_set_department_members(
            {"dept_id": dept_id, "members": "alice-bot,bob-bot"}
        )
        self.assertEqual(sorted(members["department"]["members"]), ["alice-bot", "bob-bot"])

        head = employees_set_department_head(
            {"name": "平台测试部", "head_agent_code": "alice-bot"}
        )
        self.assertEqual(head.get("head_agent_code"), "alice-bot")

        renamed = employees_rename_department({"dept_id": dept_id, "new_name": "平台工程部"})
        self.assertEqual(renamed["department"]["name"], "平台工程部")

        listed = employees_departments({})
        names = [d["name"] for d in listed["departments"]]
        self.assertIn("平台工程部", names)
        self.assertNotIn("平台测试部", names)

        deleted = employees_delete_department({"name": "平台工程部"})
        self.assertTrue(deleted.get("ok"))
        listed2 = employees_departments({})
        self.assertNotIn("平台工程部", [d["name"] for d in listed2["departments"]])

    def test_registry_includes_department_writes(self) -> None:
        from evoflow.admin.platform_actions import get_registry

        reg = get_registry()
        for name in (
            "employees.create_department",
            "employees.rename_department",
            "employees.delete_department",
            "employees.set_department_members",
            "employees.set_department_head",
        ):
            self.assertIn(name, reg)


if __name__ == "__main__":
    unittest.main()
