"""部门群聊自动回执：run 终态 → dept_group_timeline_session 落群。

2026-11-07 前「员工回合结束后才完成的任务」对群完全静默——回执钩子补上
这条汇报断点。锁三件事：
1. 终态 run（thread 直查 / collab 任务反查）→ 员工名义 final 气泡进群；
2. 幂等：同一终态重复 heal 不重复落群（message_id 固定 + skip_if_message_id_exists）；
3. 非部门会话 / 非终态不落群。
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
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

WORK_SK = "proactive:dev-a:chat:dept-rd"
GROUP_SK = "dept:rd:chat"


class DeptGroupRunReceiptTest(unittest.TestCase):
    tmp_dir: tempfile.TemporaryDirectory | None = None
    db_path: str | None = None
    _previous_db_path: str | None = None
    _previous_storage_env: str | None = None

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp_dir = tempfile.TemporaryDirectory(prefix="evoflow-dept-receipt-")
        cls.db_path = str(Path(cls.tmp_dir.name) / "evoflow.db")
        cls._previous_db_path = os.environ.get("EVOFLOW_DB_PATH")
        cls._previous_storage_env = os.environ.get("EVOFLOW_STORAGE_SQLITE_PATH")
        os.environ["EVOFLOW_DB_PATH"] = cls.db_path
        os.environ["EVOFLOW_STORAGE_SQLITE_PATH"] = cls.db_path

    @classmethod
    def tearDownClass(cls) -> None:
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
        from evoflow.persistence.schema import ensure_app_schema
        from evoflow.persistence.session_repositories import (
            invalidate_session_key_cache,
            invalidate_session_select_cache,
            upsert_session_row,
        )

        db_mod.reset_db_for_tests()
        try:
            Path(self.db_path or "").unlink(missing_ok=True)
        except OSError:
            pass
        conn = db_mod.get_db(storage_sqlite_path=self.db_path)
        ensure_app_schema(conn)
        invalidate_session_select_cache()
        invalidate_session_key_cache()

        # 群时间线会话 + 员工工作会话（带反查上下文）
        upsert_session_row(GROUP_SK, title="研发群", context={"dept_group_id": "rd"})
        upsert_session_row(
            WORK_SK,
            title="开发A",
            context={
                "dept_group_id": "rd",
                "dept_group_name": "研发群",
                "dept_group_im": True,
                "dept_group_timeline_session": GROUP_SK,
                "proactive_agent_code": "dev-a",
                "agent_name": "开发A",
            },
        )
        # app + run 落库
        conn.execute(
            "INSERT OR REPLACE INTO evoflow_apps (id, name, status) VALUES (?, ?, ?)",
            ("app-1", "周报生成器", "published"),
        )
        conn.commit()

    def tearDown(self) -> None:
        import time as _time

        from evoflow.persistence import db as db_mod
        from evoflow.persistence.session_repositories import (
            invalidate_session_key_cache,
            invalidate_session_select_cache,
        )

        # 回执走 daemon 线程：给它半秒收尾，避免 Windows 下 db 文件仍被占用
        _time.sleep(0.3)
        invalidate_session_select_cache()
        invalidate_session_key_cache()
        db_mod.reset_db_for_tests()

    def _receipt_rows(self, run_id: str) -> list[dict]:
        from evoflow.persistence.db import get_db

        rows = get_db().execute(
            "SELECT message_id, role, turn_state, content_json FROM evoflow_chat_messages "
            "WHERE session_key = ? AND message_id = ?",
            (GROUP_SK, f"dept-receipt-{run_id}"),
        ).fetchall()
        out = []
        for r in rows:
            try:
                blob = json.loads(str(r[3] or "{}"))
            except Exception:
                blob = {}
            out.append({"turn_state": r[2], "blob": blob, "content": str(blob.get("content") or "")})
        return out

    def _wait_receipt(self, run_id: str, timeout: float = 6.0) -> list[dict]:
        deadline = time.monotonic() + timeout
        rows: list[dict] = []
        while time.monotonic() < deadline:
            rows = self._receipt_rows(run_id)
            if rows:
                return rows
            time.sleep(0.1)
        return rows

    def test_terminal_run_posts_receipt_via_thread(self) -> None:
        from evoflow.persistence.app_repositories import save_run, update_run_status
        from evoflow.persistence.session_repositories import invalidate_session_key_cache

        save_run(
            "run-th-1",
            {"app_id": "app-1", "task_id": "task-th-1", "thread_id": "thread-x", "status": "running"},
        )
        from evoflow.persistence.db import get_db

        get_db().execute(
            "UPDATE evoflow_chat_sessions SET thread_id = ? WHERE session_key = ?",
            ("thread-x", WORK_SK),
        )
        get_db().commit()
        invalidate_session_key_cache()

        update_run_status("run-th-1", "completed", result_summary="产出 3 篇文案")
        rows = self._wait_receipt("run-th-1")
        self.assertEqual(len(rows), 1)
        meta = rows[0]["blob"].get("dept_group") or {}
        self.assertEqual(meta.get("msg_kind"), "agent")
        self.assertEqual(meta.get("speaker_code"), "dev-a")
        self.assertEqual(meta.get("speaker_name"), "开发A")
        self.assertEqual(meta.get("stream_state"), "final")
        self.assertTrue(meta.get("auto_receipt"))
        self.assertEqual(rows[0]["turn_state"], "final")
        self.assertIn("已完成", rows[0]["content"] or rows[0]["blob"].get("content") or "")
        self.assertIn("周报生成器", rows[0]["content"] or rows[0]["blob"].get("content") or "")
        self.assertIn("自动回执", rows[0]["content"] or rows[0]["blob"].get("content") or "")

    def test_terminal_run_posts_receipt_via_task_reverse_lookup(self) -> None:
        from evoflow.persistence.app_repositories import save_run, update_run_status
        from evoflow.persistence.db import get_db

        save_run(
            "run-task-1",
            {"app_id": "app-1", "task_id": "task-9", "thread_id": None, "status": "running"},
        )
        get_db().execute(
            "UPDATE evoflow_chat_sessions SET collab_task_id = ? WHERE session_key = ?",
            ("task-9", WORK_SK),
        )
        get_db().commit()

        update_run_status("run-task-1", "failed", error="LLM 超时")
        rows = self._wait_receipt("run-task-1")
        self.assertEqual(len(rows), 1)
        meta = rows[0]["blob"].get("dept_group") or {}
        self.assertEqual(meta.get("receipt_status"), "failed")
        self.assertIn("失败", rows[0]["content"] or "")
        self.assertIn("LLM 超时", rows[0]["content"] or "")

    def test_repeated_terminal_heal_does_not_duplicate(self) -> None:
        from evoflow.persistence.app_repositories import save_run, update_run_status
        from evoflow.persistence.db import get_db
        from evoflow.persistence.session_repositories import invalidate_session_key_cache

        save_run(
            "run-idem-1",
            {"app_id": "app-1", "task_id": "task-idem", "thread_id": "thread-y", "status": "running"},
        )
        get_db().execute(
            "UPDATE evoflow_chat_sessions SET thread_id = ? WHERE session_key = ?",
            ("thread-y", WORK_SK),
        )
        get_db().commit()
        invalidate_session_key_cache()

        update_run_status("run-idem-1", "completed", result_summary="一次")
        update_run_status("run-idem-1", "completed", result_summary="二次")
        update_run_status("run-idem-1", "completed", result_summary="三次")
        rows = self._wait_receipt("run-idem-1")
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline and len(self._receipt_rows("run-idem-1")) > 1:
            time.sleep(0.1)
        self.assertEqual(len(self._receipt_rows("run-idem-1")), 1)

    def test_non_dept_session_and_non_terminal_are_silent(self) -> None:
        from evoflow.persistence.app_repositories import save_run, update_run_status
        from evoflow.persistence.db import get_db
        from evoflow.persistence.session_repositories import (
            invalidate_session_key_cache,
            upsert_session_row,
        )

        # 无 dept_group_timeline_session 的普通会话
        upsert_session_row("agent:main:x", title="普通会话")
        get_db().execute(
            "UPDATE evoflow_chat_sessions SET thread_id = ? WHERE session_key = ?",
            ("thread-plain", "agent:main:x"),
        )
        get_db().commit()
        invalidate_session_key_cache()

        save_run(
            "run-plain-1",
            {"app_id": "app-1", "task_id": "t-plain", "thread_id": "thread-plain", "status": "running"},
        )
        update_run_status("run-plain-1", "completed", result_summary="无群可落")
        # 非终态同样静默
        save_run(
            "run-running-1",
            {"app_id": "app-1", "task_id": "t-run", "thread_id": "thread-x", "status": "running"},
        )
        update_run_status("run-running-1", "running", progress=50)
        time.sleep(1.0)
        self.assertEqual(self._receipt_rows("run-plain-1"), [])
        self.assertEqual(self._receipt_rows("run-running-1"), [])

    def test_prompt_block_requires_reporting_rule(self) -> None:
        from evoflow.proactive.employee_prompting.dept_group_im import (
            DEPT_GROUP_IM_OPEN,
            build_dept_group_im_block,
        )

        self.assertIn('version="2"', DEPT_GROUP_IM_OPEN)
        for steward in (True, False):
            block = build_dept_group_im_block(dept_name="研发群", steward=steward, roster=["开发A"])
            self.assertIn("回合结束前必须交代结果", block)
            self.assertIn("自动回执", block)
        steward_block = build_dept_group_im_block(dept_name="研发群", steward=True, roster=["开发A"])
        member_block = build_dept_group_im_block(dept_name="研发群", steward=False, roster=["开发A"])
        # 编号连续：管家块 1-6、成员块 1-6
        for block in (steward_block, member_block):
            for i in range(1, 7):
                self.assertIn(f"{i}. ", block)

    # ── 协作任务终态回执（save_task_bundle 差分钩子） ─────────────────────────

    def _save_bundle(self, main_id: str, name: str, status: str, **task_extra) -> None:
        from evoflow.persistence.task_repositories import save_task_bundle

        save_task_bundle(
            main_id,
            {
                "id": main_id,
                "name": name,
                "status": status,
                "tasks": [
                    {
                        "id": main_id,
                        "name": name,
                        "status": status,
                        "progress": 100 if status == "completed" else 0,
                        **task_extra,
                    }
                ],
            },
        )

    def test_collab_task_terminal_posts_receipt(self) -> None:
        from evoflow.persistence.db import get_db

        get_db().execute(
            "UPDATE evoflow_chat_sessions SET collab_task_id = ? WHERE session_key = ?",
            ("mt-1", WORK_SK),
        )
        get_db().commit()

        # 首次落库：pending → 不回执
        self._save_bundle("mt-1", "周报整理", "pending")
        self.assertEqual(self._task_receipt_rows("mt-1"), [])
        # 转入 completed → 回执落群
        self._save_bundle("mt-1", "周报整理", "completed")
        rows = self._wait_task_receipt("mt-1")
        self.assertEqual(len(rows), 1)
        meta = rows[0]["blob"].get("dept_group") or {}
        self.assertEqual(meta.get("msg_kind"), "agent")
        self.assertEqual(meta.get("speaker_code"), "dev-a")
        self.assertEqual(meta.get("speaker_name"), "开发A")
        self.assertEqual(meta.get("receipt_task_id"), "mt-1")
        self.assertIn("已完成", rows[0]["content"])
        self.assertIn("周报整理", rows[0]["content"])
        self.assertIn("自动回执", rows[0]["content"])
        # 同终态重复保存（reconciler 反复写）不重复落群
        self._save_bundle("mt-1", "周报整理", "completed")
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline and len(self._task_receipt_rows("mt-1")) > 1:
            time.sleep(0.1)
        self.assertEqual(len(self._task_receipt_rows("mt-1")), 1)

    def test_app_sourced_task_does_not_double_post(self) -> None:
        from evoflow.persistence.db import get_db

        get_db().execute(
            "UPDATE evoflow_chat_sessions SET collab_task_id = ? WHERE session_key = ?",
            ("mt-2", WORK_SK),
        )
        get_db().commit()
        # app 源任务（extra_json 带 app_definition_snapshot）：run 终态回执已覆盖，不落任务回执
        self._save_bundle("mt-2", "工作流任务", "pending")
        self._save_bundle("mt-2", "工作流任务", "completed", app_definition_snapshot={"app_id": "app-1"})
        time.sleep(1.0)
        self.assertEqual(self._task_receipt_rows("mt-2"), [])

    def _task_receipt_rows(self, main_id: str) -> list[dict]:
        from evoflow.persistence.db import get_db

        rows = get_db().execute(
            "SELECT turn_state, content_json FROM evoflow_chat_messages "
            "WHERE session_key = ? AND message_id = ?",
            (GROUP_SK, f"dept-receipt-task-{main_id}"),
        ).fetchall()
        out = []
        for r in rows:
            try:
                blob = json.loads(str(r[1] or "{}"))
            except Exception:
                blob = {}
            out.append({"turn_state": r[0], "blob": blob, "content": str(blob.get("content") or "")})
        return out

    def _wait_task_receipt(self, main_id: str, timeout: float = 6.0) -> list[dict]:
        deadline = time.monotonic() + timeout
        rows: list[dict] = []
        while time.monotonic() < deadline:
            rows = self._task_receipt_rows(main_id)
            if rows:
                return rows
            time.sleep(0.1)
        return rows


if __name__ == "__main__":
    unittest.main()
