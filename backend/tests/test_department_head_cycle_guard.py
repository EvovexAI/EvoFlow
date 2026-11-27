"""部门负责人对齐：`align_unmanaged` 不得造出上下级环。

背景（【self-evolution-bot · 2026-11-27 · 第135轮 · 模型:deepseek-v4-1-flash-261017】）：
`DepartmentRepository.set_head(align_unmanaged=True)` 会把 ``reports_to`` 为空的成员
指向新负责人，但原先没有 ``would_create_cycle`` 那套校验。真实场景：把部门内的下属设为
负责人时，原负责人（``reports_to`` 为空）会被指回该下属，而下属本就汇报给原负责人 →
两节点环，组织树遍历会打转。前端「同时调整成员汇报关系」勾选框默认选中，一次点击即可触发。

锁三件事：
1. 会成环的那条对齐被跳过，返回 ``align_skipped`` 点名是谁；
2. 不该成环的空 ``reports_to`` 成员照常对齐到新负责人；
3. 负责人字段本身照常写入（跳过对齐不等于不改负责人）。
"""
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

_TS = "2026-11-27T00:00:00Z"


class DeptHeadCycleGuardTest(unittest.TestCase):
    tmp_dir: tempfile.TemporaryDirectory | None = None
    db_path: str | None = None
    _previous_db_path: str | None = None
    _previous_storage_env: str | None = None

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp_dir = tempfile.TemporaryDirectory(prefix="evoflow-dept-head-cycle-")
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

    # ── helpers ─────────────────────────────────────────────

    def _make_role(self, code: str, *, dept: str, reports_to: str = "", name: str = "") -> None:
        import json

        self.db.execute(
            "INSERT OR REPLACE INTO evoflow_proactive_roles "
            "(agent_code, role_name, department, reports_to, config_json, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?)",
            (
                code,
                name or code,
                dept,
                reports_to,
                json.dumps({"reports_to": reports_to}),
                _TS,
                _TS,
            ),
        )
        self.db.commit()

    def _reports_to(self, code: str) -> str:
        row = self.db.execute(
            "SELECT reports_to FROM evoflow_proactive_roles WHERE agent_code = ?", (code,)
        ).fetchone()
        return str(row["reports_to"] or "") if row else ""

    # ── tests ───────────────────────────────────────────────

    def test_align_skips_would_be_cycle(self) -> None:
        """老板(reports_to='') + 我(reports_to=老板)；把我设为负责人 → 老板不得被指回我。"""
        from evoflow.proactive.departments import DepartmentRepository

        dept = DepartmentRepository.create(name="成环部")
        did = str(dept["id"])
        self._make_role("boss-x", dept="成环部", reports_to="", name="老板")
        self._make_role("me-x", dept="成环部", reports_to="boss-x", name="我")
        self._make_role("peer-x", dept="成环部", reports_to="", name="同事")

        out = DepartmentRepository.set_head(did, head_agent_code="me-x", align_unmanaged=True)

        # ① 会成环的那条被跳过，并点名
        self.assertEqual(out.get("head_agent_code"), "me-x")
        self.assertEqual(self._reports_to("boss-x"), "", "老板被指回下属 → 两节点环")
        self.assertIn("boss-x", out.get("align_skipped") or [])
        # ② 无环的同事照常对齐
        self.assertEqual(self._reports_to("peer-x"), "me-x")
        # ③ 负责人字段本身写入
        self.assertEqual(DepartmentRepository.get(did)["head_agent_code"], "me-x")

    def test_align_without_cycle_points_members_at_head(self) -> None:
        """没有环风险时行为不变：空 reports_to 成员照常对齐到新负责人。"""
        from evoflow.proactive.departments import DepartmentRepository

        dept = DepartmentRepository.create(name="无环部")
        did = str(dept["id"])
        self._make_role("new-head-x", dept="无环部", reports_to="")
        self._make_role("member-x", dept="无环部", reports_to="")
        self._make_role("member-y", dept="无环部", reports_to="new-head-x")

        out = DepartmentRepository.set_head(did, head_agent_code="new-head-x", align_unmanaged=True)

        self.assertEqual(self._reports_to("member-x"), "new-head-x")
        self.assertEqual(self._reports_to("member-y"), "new-head-x")
        self.assertEqual(out.get("align_skipped") or [], [])

    def test_align_off_leaves_reporting_untouched(self) -> None:
        """align_unmanaged=False（现网改为负责人时用的就是这条）不动任何汇报链。"""
        from evoflow.proactive.departments import DepartmentRepository

        dept = DepartmentRepository.create(name="不动链部")
        did = str(dept["id"])
        self._make_role("h2-x", dept="不动链部", reports_to="")
        self._make_role("m2-x", dept="不动链部", reports_to="")

        DepartmentRepository.set_head(did, head_agent_code="h2-x", align_unmanaged=False)

        self.assertEqual(self._reports_to("m2-x"), "")
        self.assertEqual(DepartmentRepository.get(did)["head_agent_code"], "h2-x")


if __name__ == "__main__":
    unittest.main()
