"""部门群叫醒队列 HTTP 路由测试。

【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】

验的是路由层**接线**，不是仓储层（那层由 test_dept_group_wake_repositories 覆盖）：
- enqueue 幂等（前端重试不产生第二行）
- status 能落终态 / 能退队重试
- **pending 读路径会顺手回收心跳超时的 running** —— 这条最容易被写成
  「只是读一下」，从而让崩溃后的死任务永远解开不了。
"""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path


class DeptGroupWakeRouterTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        cls._db = str(Path(cls._tmp.name) / "wake_router.db")
        cls._prev = os.environ.get("EVOFLOW_DB_PATH")
        os.environ["EVOFLOW_DB_PATH"] = cls._db

    @classmethod
    def tearDownClass(cls) -> None:
        try:
            from evoflow.persistence.db import reset_db_for_tests

            reset_db_for_tests()
        except Exception:
            pass
        if cls._prev is None:
            os.environ.pop("EVOFLOW_DB_PATH", None)
        else:
            os.environ["EVOFLOW_DB_PATH"] = cls._prev
        cls._tmp.cleanup()

    def setUp(self) -> None:
        from fastapi.testclient import TestClient

        from evoflow.persistence.db import get_db, reset_db_for_tests

        reset_db_for_tests()
        get_db().execute("DELETE FROM evoflow_dept_group_wake_jobs")
        get_db().commit()

        from fastapi import FastAPI

        from app.gateway.routers.dept_groups import router

        app = FastAPI()
        app.include_router(router)
        self.client = TestClient(app)

    def _enqueue(self, **kw):
        body = {
            "job_id": "wake-a-1-1000",
            "dept_id": "d1",
            "agent_code": "a",
            "role_name": "甲",
            "goal": "看下报表",
            **kw,
        }
        return self.client.post("/api/dept-groups/wake-jobs/enqueue", json=body)

    # ── 1. 路由存在且幂等 ─────────────────────────────────────────────
    def test_enqueue_route_is_idempotent(self) -> None:
        for _ in range(3):
            r = self._enqueue()
            self.assertEqual(r.status_code, 200, r.text)
            self.assertTrue(r.json()["ok"])
        jobs = self.client.get(
            "/api/dept-groups/wake-jobs/pending", params={"dept_id": "d1"}
        ).json()["jobs"]
        self.assertEqual(len(jobs), 1, "同一 job_id 重复 enqueue 必须只有一行")

    # ── 2. 落终态 ────────────────────────────────────────────────────
    def test_status_route_finishes_job(self) -> None:
        self._enqueue()
        r = self.client.post(
            "/api/dept-groups/wake-jobs/status",
            json={"job_id": "wake-a-1-1000", "status": "done"},
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["updated"])
        self.assertEqual(r.json()["job"]["status"], "done")
        # 终态后不再出现在 pending
        jobs = self.client.get(
            "/api/dept-groups/wake-jobs/pending", params={"dept_id": "d1"}
        ).json()["jobs"]
        self.assertEqual(len(jobs), 0)

    # ── 3. 退队重试 ──────────────────────────────────────────────────
    def test_status_route_requeues(self) -> None:
        from evoflow.persistence.dept_group_wake_repositories import claim_next

        self._enqueue()
        claim_next(dept_id="d1", agent_code="a", owner="p")
        r = self.client.post(
            "/api/dept-groups/wake-jobs/status",
            json={"job_id": "wake-a-1-1000", "status": "running", "requeue": True, "error": "正忙"},
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["job"]["status"], "queued")

    # ── 4. §核心接线：pending 读路径必须回收死任务 ────────────────────
    def test_pending_reclaims_stale_running(self) -> None:
        from evoflow.persistence.db import get_db
        from evoflow.persistence.dept_group_wake_repositories import claim_next

        self._enqueue()
        claim_next(dept_id="d1", agent_code="a", owner="pod-dead")
        # 模拟进程崩溃：心跳停在很久以前
        get_db().execute(
            "UPDATE evoflow_dept_group_wake_jobs SET heartbeat_at = ?, started_at = ?",
            ("2020-01-01T00:00:00+08:00", "2020-01-01T00:00:00+08:00"),
        )
        get_db().commit()

        r = self.client.get("/api/dept-groups/wake-jobs/pending", params={"dept_id": "d1"})
        self.assertEqual(r.status_code, 200, r.text)
        data = r.json()
        self.assertEqual(
            data["reclaimed"], 1, "读路径必须回收心跳超时的 running，否则刷新后队头仍堵死"
        )
        self.assertEqual(len(data["jobs"]), 1)
        self.assertEqual(data["jobs"][0]["status"], "queued")

    # ── 5. 心跳续期 ──────────────────────────────────────────────────
    def test_heartbeat_route(self) -> None:
        from evoflow.persistence.dept_group_wake_repositories import claim_next

        self._enqueue()
        claim_next(dept_id="d1", agent_code="a", owner="p")
        r = self.client.post(
            "/api/dept-groups/wake-jobs/heartbeat",
            json={"job_id": "wake-a-1-1000"},
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["updated"])

    # ── 6. 必填校验 ─────────────────────────────────────────────────
    def test_enqueue_requires_job_id_and_agent_code(self) -> None:
        r = self.client.post(
            "/api/dept-groups/wake-jobs/enqueue",
            json={"dept_id": "d1", "agent_code": "a"},
        )
        self.assertEqual(r.status_code, 422, "缺 job_id 必须被拒，不能静默生成")

    # ── 7. §claim：恢复必须认领，不能直接重排 ─────────────────────────
    def test_claim_returns_job_once_then_blocks_same_agent(self) -> None:
        self._enqueue()
        r1 = self.client.post(
            "/api/dept-groups/wake-jobs/claim",
            json={"dept_id": "d1", "agent_code": "a", "owner": "tab-1"},
        )
        self.assertEqual(r1.status_code, 200, r1.text)
        self.assertIsNotNone(r1.json()["job"], "首次认领必须拿到任务")
        self.assertEqual(r1.json()["job"]["status"], "running")

        # 第二个标签页再认领：同一 agent 已被存活 running 占住 → 必须拿不到
        r2 = self.client.post(
            "/api/dept-groups/wake-jobs/claim",
            json={"dept_id": "d1", "agent_code": "a", "owner": "tab-2"},
        )
        self.assertEqual(r2.status_code, 200, r2.text)
        self.assertIsNone(
            r2.json()["job"],
            "同一任务不能被两个标签页各跑一遍（会重复回复+重复计费）",
        )

    def test_claim_recovers_after_crash(self) -> None:
        from evoflow.persistence.db import get_db

        self._enqueue()
        self.client.post(
            "/api/dept-groups/wake-jobs/claim",
            json={"dept_id": "d1", "agent_code": "a", "owner": "dead-tab"},
        )
        # 标签页崩溃：心跳停住
        get_db().execute(
            "UPDATE evoflow_dept_group_wake_jobs SET heartbeat_at = ?, started_at = ?",
            ("2020-01-01T00:00:00+08:00", "2020-01-01T00:00:00+08:00"),
        )
        get_db().commit()

        r = self.client.post(
            "/api/dept-groups/wake-jobs/claim",
            json={"dept_id": "d1", "agent_code": "a", "owner": "new-tab"},
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIsNotNone(
            r.json()["job"], "崩溃后重开页面必须能把任务捡回来，否则用户永远等不到回复"
        )

    def test_claim_nothing_when_empty(self) -> None:
        r = self.client.post(
            "/api/dept-groups/wake-jobs/claim",
            json={"dept_id": "d1", "agent_code": "nobody"},
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIsNone(r.json()["job"])

    # ── 8. §现网真缺陷：前端发 status='running' 曾被判 HTTP 500 ─────────
    def test_status_running_does_not_500(self) -> None:
        """守卫回归：`running` 是「开始跑」，不是终态。

        旧实现把非 requeue 一律交给 finish_wake_job（只收终态）→ ValueError → 500。
        前端每轮都会发 running，所以这是每条叫醒都会撞到的路径，不是边角。
        """
        self._enqueue()
        r = self.client.post(
            "/api/dept-groups/wake-jobs/status",
            json={"job_id": "wake-a-1-1000", "status": "running", "error": ""},
        )
        self.assertEqual(r.status_code, 200, f"running 不该 500，实际 {r.status_code}")
        self.assertEqual(r.json()["job"]["status"], "running")

    def test_status_running_refreshes_heartbeat(self) -> None:
        """「开始跑」必须落库并带上心跳，否则崩溃后分不清没跑/跑到一半死了。"""
        from evoflow.persistence.db import get_db

        self._enqueue()
        self.client.post(
            "/api/dept-groups/wake-jobs/status",
            json={"job_id": "wake-a-1-1000", "status": "running"},
        )
        row = get_db().execute(
            "SELECT status, heartbeat_at, started_at FROM evoflow_dept_group_wake_jobs "
            "WHERE job_id = ?",
            ("wake-a-1-1000",),
        ).fetchone()
        self.assertEqual(row[0], "running")
        self.assertTrue(str(row[1] or "").strip(), "心跳必须有值，否则立刻被当死进程")
        self.assertTrue(str(row[2] or "").strip(), "started_at 必须有值")

    def test_status_running_does_not_resurrect_terminal(self) -> None:
        """终态不可逆：done 之后再发 running 不能把它拖回 running。"""
        self._enqueue()
        self.client.post(
            "/api/dept-groups/wake-jobs/status",
            json={"job_id": "wake-a-1-1000", "status": "done"},
        )
        self.client.post(
            "/api/dept-groups/wake-jobs/status",
            json={"job_id": "wake-a-1-1000", "status": "running"},
        )
        from evoflow.persistence.dept_group_wake_repositories import get_wake_job

        self.assertEqual(get_wake_job("wake-a-1-1000")["status"], "done")

    def test_status_unknown_is_400_not_silent(self) -> None:
        """未知状态必须明确 400，不能装作成功。"""
        self._enqueue()
        r = self.client.post(
            "/api/dept-groups/wake-jobs/status",
            json={"job_id": "wake-a-1-1000", "status": "bogus"},
        )
        self.assertEqual(r.status_code, 400)


if __name__ == "__main__":
    unittest.main()
