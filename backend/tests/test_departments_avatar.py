"""部门头像：迁移 / 预设列表 / 随机分配 / 手动更换。

锁五件事：
1. 老库没有 ``avatar`` 列时 ``ensure_departments_table`` 能幂等 ALTER 并回填；
2. 预设图片接口返回 9 张内置图，未知 id → 404；
3. 新建部门不带头像 → 自动分到一张预设；
4. 改头像后再读仍在；非法 id → 400；
5. 头像为空的老部门读取不炸（兜底交给前端）。
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

_LEGACY_DEPT_DDL = """
CREATE TABLE evoflow_departments (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    head_agent_code TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
"""


class DeptAvatarTest(unittest.TestCase):
    tmp_dir: tempfile.TemporaryDirectory | None = None
    db_path: str | None = None
    _previous_db_path: str | None = None
    _previous_storage_env: str | None = None

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp_dir = tempfile.TemporaryDirectory(prefix="evoflow-dept-avatar-")
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

    # ── repository / migration ───────────────────────────────

    def test_legacy_db_gets_avatar_column_and_backfill(self) -> None:
        from evoflow.proactive.departments import (
            DepartmentRepository,
            ensure_departments_table,
        )

        self.db.execute("DROP TABLE IF EXISTS evoflow_departments")
        self.db.execute(_LEGACY_DEPT_DDL)
        self.db.execute(
            "INSERT INTO evoflow_departments "
            "(id, name, sort_order, head_agent_code, created_at, updated_at) "
            "VALUES ('old1', '老部门', 10, '', '2024-01-01', '2024-01-01')"
        )
        self.db.commit()

        ensure_departments_table()
        # idempotent: second call must not raise
        ensure_departments_table()

        cols = {str(r[1]) for r in self.db.execute("PRAGMA table_info(evoflow_departments)").fetchall()}
        self.assertIn("avatar", cols)

        row = DepartmentRepository.get("old1")
        self.assertIsNotNone(row)
        assert row is not None
        # 老库平滑升级：迁移时补上一张预设，而不是留空
        self.assertTrue(str(row["avatar"] or "").strip())
        self.assertIn(row["avatar"], {p["id"] for p in _presets()})

    def test_create_without_avatar_picks_a_preset(self) -> None:
        from evoflow.proactive.departments import DepartmentRepository

        row = DepartmentRepository.create(name="随机头像部")
        self.assertTrue(str(row.get("avatar") or "").strip())
        self.assertIn(row["avatar"], {p["id"] for p in _presets()})

    def test_create_with_explicit_avatar(self) -> None:
        from evoflow.proactive.departments import DepartmentRepository

        row = DepartmentRepository.create(name="指定头像部", avatar="engineering")
        self.assertEqual(row["avatar"], "engineering")

    def test_create_with_unknown_avatar_rejected(self) -> None:
        from evoflow.proactive.departments import DepartmentRepository

        with self.assertRaises(ValueError):
            DepartmentRepository.create(name="非法头像部", avatar="no-such-preset")

    def test_set_avatar_persists_and_rejects_unknown(self) -> None:
        from evoflow.proactive.departments import DepartmentRepository

        row = DepartmentRepository.create(name="换头像部")
        did = str(row["id"])
        DepartmentRepository.set_avatar(did, avatar="aigc")
        self.assertEqual(DepartmentRepository.get(did)["avatar"], "aigc")
        # a fresh read (new connection state) still holds the value
        listed = {d["id"]: d for d in DepartmentRepository.list_departments(with_members=False)}
        self.assertEqual(listed[did]["avatar"], "aigc")

        with self.assertRaises(ValueError):
            DepartmentRepository.set_avatar(did, avatar="bad id!")

    def test_empty_avatar_reads_as_empty_string(self) -> None:
        from evoflow.proactive.departments import DepartmentRepository

        row = DepartmentRepository.create(name="清空头像部")
        did = str(row["id"])
        DepartmentRepository.set_avatar(did, avatar="")
        got = DepartmentRepository.get(did)
        assert got is not None
        self.assertEqual(got["avatar"], "")

    # ── presets module / HTTP ───────────────────────────────

    def test_preset_module_lists_nine_cutouts(self) -> None:
        from evoflow.config import dept_avatar_presets as presets

        presets.clear_preset_cache()
        rows = presets.list_presets()
        self.assertEqual(len(rows), 9)
        ids = {r["id"] for r in rows}
        self.assertEqual(
            ids,
            {
                "studio",
                "engineering",
                "commerce",
                "aigc",
                "office",
                "classroom",
                "design",
                "finance",
                "support",
            },
        )
        for r in rows:
            self.assertTrue(presets.preset_path(r["id"]))
        self.assertIsNone(presets.preset_path("nope"))
        self.assertIsNone(presets.normalize_preset_id("Bad/Id"))
        self.assertTrue(presets.pick_random_preset_id() in ids)

    def test_http_endpoints_and_put_avatar(self) -> None:
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        from evoflow.proactive.router import router as proactive_router

        app = FastAPI()
        app.include_router(proactive_router)
        client = TestClient(app)

        listed = client.get("/api/proactive/departments/avatar-presets")
        self.assertEqual(listed.status_code, 200)
        payload = listed.json()
        self.assertEqual(payload["count"], 9)
        first = payload["presets"][0]
        self.assertEqual(set(first), {"id", "label", "url"})

        img = client.get(f"/api/proactive/departments/avatar-presets/{first['id']}")
        self.assertEqual(img.status_code, 200)
        self.assertEqual(img.headers.get("content-type"), "image/png")
        self.assertGreater(len(img.content), 1000)
        self.assertEqual(
            client.get("/api/proactive/departments/avatar-presets/nope").status_code, 404
        )

        created = client.post("/api/proactive/departments", json={"name": "接口头像部"})
        self.assertEqual(created.status_code, 200)
        dept = created.json()["department"]
        self.assertTrue(str(dept.get("avatar") or "").strip())

        updated = client.put(
            f"/api/proactive/departments/{dept['id']}", json={"avatar": "support"}
        )
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(updated.json()["department"]["avatar"], "support")

        bad = client.put(f"/api/proactive/departments/{dept['id']}", json={"avatar": "bad id!"})
        self.assertEqual(bad.status_code, 400)

        rows = client.get("/api/proactive/departments").json()["departments"]
        self.assertEqual({d["id"]: d["avatar"] for d in rows}[dept["id"]], "support")


def _presets() -> list[dict]:
    from evoflow.config import dept_avatar_presets as presets

    return presets.list_presets()


if __name__ == "__main__":
    unittest.main()
