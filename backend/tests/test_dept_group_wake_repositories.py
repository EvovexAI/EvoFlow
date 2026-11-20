"""部门群聊叫醒队列落库（evoflow_dept_group_wake_jobs）测试。

【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】

重点验的是**判据**，不是「函数能跑通」：
- `running` 不等于「还活着」——必须靠心跳超时才回收（否则崩溃后队头永堵）；
- 同一 agent 必须串行（否则同一个人在群里并行说两遍）；
- 合并口径必须与前端 `normalizeWakeGoal` 逐字一致（两端算出不同结论就打架）。
"""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path


class DeptGroupWakeRepoTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        cls._db = str(Path(cls._tmp.name) / "wake.db")
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
        from evoflow.persistence.db import get_db, reset_db_for_tests

        reset_db_for_tests()
        get_db().execute("DELETE FROM evoflow_dept_group_wake_jobs")
        get_db().commit()

    # ── 1. 入队幂等 ────────────────────────────────────────────────────
    def test_enqueue_is_idempotent_by_job_id(self) -> None:
        from evoflow.persistence.dept_group_wake_repositories import (
            enqueue_wake_job,
            list_wake_jobs,
        )

        for _ in range(3):
            enqueue_wake_job(
                job_id="wake-a-1-1000",
                dept_id="d1",
                agent_code="a",
                role_name="甲",
                goal="看下报表",
            )
        jobs = list_wake_jobs(dept_id="d1", agent_code="a")
        self.assertEqual(len(jobs), 1, "同一 job_id 重复入队必须只有一行")

    # ── 2. 目标合并口径与前端逐字一致 ──────────────────────────────────
    def test_normalize_goal_matches_frontend(self) -> None:
        from evoflow.persistence.dept_group_wake_repositories import normalize_goal

        # 前端：replace(/\s+/g,' ').trim().toLowerCase().slice(0,160)
        self.assertEqual(normalize_goal("  看下   报表  "), "看下 报表")
        self.assertEqual(normalize_goal("ABC  Def"), "abc def")
        self.assertEqual(normalize_goal(""), "")
        self.assertEqual(len(normalize_goal("字" * 500)), 160)

    # ── 3. 同 agent 串行：running 存活时不再发第二条 ────────────────────
    def test_same_agent_serial(self) -> None:
        from evoflow.persistence.dept_group_wake_repositories import (
            claim_next,
            enqueue_wake_job,
        )

        enqueue_wake_job(job_id="j1", dept_id="d1", agent_code="a", goal="一")
        enqueue_wake_job(job_id="j2", dept_id="d1", agent_code="a", goal="二")

        first = claim_next(dept_id="d1", agent_code="a", owner="pod-1")
        self.assertIsNotNone(first)
        self.assertEqual(first["job_id"], "j1", "先入队的先跑")

        # 第一条还在跑（心跳新鲜）→ 第二条不能发
        second = claim_next(dept_id="d1", agent_code="a", owner="pod-1")
        self.assertIsNone(second, "同 agent 必须串行，不能并行两轮")

    # ── 4. §核心判据：running 但心跳超时 = 死进程，必须能被回收 ──────────
    def test_stale_running_is_reclaimed_not_treated_as_alive(self) -> None:
        from evoflow.persistence.db import get_db
        from evoflow.persistence.dept_group_wake_repositories import (
            claim_next,
            enqueue_wake_job,
            is_alive,
        )

        enqueue_wake_job(job_id="j1", dept_id="d1", agent_code="a", goal="一")
        enqueue_wake_job(job_id="j2", dept_id="d1", agent_code="a", goal="二")
        claimed = claim_next(dept_id="d1", agent_code="a", owner="pod-dead")
        self.assertEqual(claimed["job_id"], "j1")

        # 模拟进程崩溃：心跳停在很久以前
        get_db().execute(
            "UPDATE evoflow_dept_group_wake_jobs SET heartbeat_at = ?, started_at = ? "
            "WHERE job_id = ?",
            ("2020-01-01T00:00:00+08:00", "2020-01-01T00:00:00+08:00", "j1"),
        )
        get_db().commit()

        job = {"status": "running", "heartbeat_at": "2020-01-01T00:00:00+08:00"}
        self.assertFalse(
            is_alive(job), "只看 status=running 就当活着会让队头永久堵死，必须看心跳"
        )

        from evoflow.persistence.dept_group_wake_repositories import reclaim_stale_running

        n = reclaim_stale_running()
        self.assertEqual(n, 1, "心跳超时的 running 必须被退回 queued")

        # 回收后能继续领到下一条（j1 已退回队列且更老，所以先领 j1）
        nxt = claim_next(dept_id="d1", agent_code="a", owner="pod-2")
        self.assertIsNotNone(nxt, "回收后队头必须解开")

    # ── 5. 心跳续期能阻止回收 ──────────────────────────────────────────
    def test_heartbeat_keeps_job_alive(self) -> None:
        from evoflow.persistence.dept_group_wake_repositories import (
            claim_next,
            enqueue_wake_job,
            heartbeat,
            is_alive,
        )

        enqueue_wake_job(job_id="j1", dept_id="d1", agent_code="a", goal="一")
        claimed = claim_next(dept_id="d1", agent_code="a", owner="pod-1")
        self.assertTrue(heartbeat(claimed["job_id"]))
        from evoflow.persistence.db import get_db

        row = get_db().execute(
            "SELECT status, heartbeat_at FROM evoflow_dept_group_wake_jobs WHERE job_id='j1'"
        ).fetchone()
        self.assertTrue(is_alive({"status": row[0], "heartbeat_at": row[1]}))

    # ── 6. 终态不可再被 claim ─────────────────────────────────────────
    def test_finished_job_not_claimable(self) -> None:
        from evoflow.persistence.dept_group_wake_repositories import (
            STATUS_DONE,
            claim_next,
            enqueue_wake_job,
            finish_wake_job,
        )

        enqueue_wake_job(job_id="j1", dept_id="d1", agent_code="a", goal="一")
        claim_next(dept_id="d1", agent_code="a", owner="p")
        self.assertTrue(finish_wake_job("j1", status=STATUS_DONE))
        self.assertIsNone(claim_next(dept_id="d1", agent_code="a", owner="p"))

    def test_finish_rejects_non_terminal_status(self) -> None:
        from evoflow.persistence.dept_group_wake_repositories import (
            enqueue_wake_job,
            finish_wake_job,
        )

        enqueue_wake_job(job_id="j1", dept_id="d1", agent_code="a", goal="一")
        with self.assertRaises(ValueError):
            finish_wake_job("j1", status="running")

    # ── 7. 不同 agent 互不阻塞（并行是允许的）──────────────────────────
    def test_different_agents_run_in_parallel(self) -> None:
        from evoflow.persistence.dept_group_wake_repositories import (
            claim_next,
            enqueue_wake_job,
        )

        enqueue_wake_job(job_id="ja", dept_id="d1", agent_code="a", goal="一")
        enqueue_wake_job(job_id="jb", dept_id="d1", agent_code="b", goal="二")
        self.assertIsNotNone(claim_next(dept_id="d1", agent_code="a", owner="p"))
        self.assertIsNotNone(
            claim_next(dept_id="d1", agent_code="b", owner="p"),
            "不同 agent 之间必须能并行，否则一个慢回合会挡住整群人",
        )

    # ── 8. 跨部门隔离 ────────────────────────────────────────────────
    def test_dept_isolation(self) -> None:
        from evoflow.persistence.dept_group_wake_repositories import (
            claim_next,
            enqueue_wake_job,
        )

        enqueue_wake_job(job_id="j1", dept_id="d1", agent_code="a", goal="一")
        self.assertIsNone(
            claim_next(dept_id="d2", agent_code="a", owner="p"),
            "别的部门的队列不能被领走",
        )

    # ── 9. 合并找得到近期同目标任务 ───────────────────────────────────
    def test_find_mergeable_same_goal(self) -> None:
        from evoflow.persistence.dept_group_wake_repositories import (
            claim_next,
            enqueue_wake_job,
            find_mergeable,
        )

        enqueue_wake_job(job_id="j1", dept_id="d1", agent_code="a", goal="看下  报表")
        hit = find_mergeable(dept_id="d1", agent_code="a", goal="看下 报表")
        self.assertIsNotNone(hit, "同目标（空白折叠后相同）必须能合并")
        self.assertIsNone(
            find_mergeable(dept_id="d1", agent_code="a", goal="完全不同的活儿")
        )
        # 执行中的任务不设窗口，永远可合并（一轮 LLM 常态远超 8s）
        claim_next(dept_id="d1", agent_code="a", owner="p")
        self.assertIsNotNone(
            find_mergeable(dept_id="d1", agent_code="a", goal="看下 报表"),
            "执行中的任务必须仍可合并，否则重复 @ 会再跑一整轮",
        )

    # ── 10. 重试退队 ─────────────────────────────────────────────────
    def test_requeue_for_retry(self) -> None:
        from evoflow.persistence.dept_group_wake_repositories import (
            claim_next,
            enqueue_wake_job,
            get_wake_job,
            requeue_for_retry,
        )

        enqueue_wake_job(job_id="j1", dept_id="d1", agent_code="a", goal="一")
        claim_next(dept_id="d1", agent_code="a", owner="p")
        self.assertTrue(requeue_for_retry("j1", error="正忙"))
        job = get_wake_job("j1")
        self.assertEqual(job["status"], "queued")
        self.assertEqual(job["attempts"], 1, "attempts 在 claim 时已 +1，重试不再重复加")


if __name__ == "__main__":
    unittest.main()
