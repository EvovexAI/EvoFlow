"""任务 thread_id 绑定优先级：本任务的专用执行会话可以接管，别的桶不许抢。

【self-evolution-bot · 2026-11-22 · 第125轮 · 模型:deepseek-v4.1-flash】
现网实证（2026-11-22，直接查 evoflow.db）：
  · 40 条带 thread_id 的任务里 **16 条**的 thread 指向的不是 task 桶；
  · 例：task 2611221757_60a8（执行人 case-fullstack-dev）thread=8bcaa342 →
    by-thread 回 `proactive:case-fullstack-dev:chat:dept-28baad343765`（28 条普通聊天），
    真正的执行记录在 `proactive:case-fullstack-dev:task:2611221757_60a8`（5 条）。
根因：`_bind_task_thread` 只在 task.thread_id 为空时写入。派单先落到发起人 chat 会话时
就占了位，之后真正的执行会话写不进去 → 任务详情按 thread 读，读到别人的对话。
"""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

TASK_ID = "2611221757_60a8"
AGENT = "case-fullstack-dev"
TASK_SK = f"proactive:{AGENT}:task:{TASK_ID}"
CHAT_SK = f"proactive:{AGENT}:chat:dept-28baad343765"
TASK_THREAD = "thread-task-bucket"
CHAT_THREAD = "thread-chat-bucket"
COLLAB_THREAD = "thread-collab-lead"


class TaskThreadBindingTest(unittest.TestCase):
    tmp_dir: tempfile.TemporaryDirectory | None = None
    db_path: str | None = None
    _prev_env: str | None = None

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp_dir = tempfile.TemporaryDirectory(prefix="evoflow-taskbind-")
        cls.db_path = str(Path(cls.tmp_dir.name) / "evoflow.db")
        cls._prev_env = os.environ.get("EVOFLOW_DB_PATH")
        os.environ["EVOFLOW_DB_PATH"] = cls.db_path

    @classmethod
    def tearDownClass(cls) -> None:
        try:
            from evoflow.persistence import db as db_mod

            db_mod.reset_db_for_tests()
        except Exception:
            pass
        if cls._prev_env is None:
            os.environ.pop("EVOFLOW_DB_PATH", None)
        else:
            os.environ["EVOFLOW_DB_PATH"] = cls._prev_env
        if cls.tmp_dir is not None:
            cls.tmp_dir.cleanup()
            cls.tmp_dir = None

    def setUp(self) -> None:
        from evoflow.persistence import db as db_mod
        from evoflow.persistence.schema import ensure_app_schema

        db_mod.reset_db_for_tests()
        conn = db_mod.get_db(storage_sqlite_path=self.db_path)
        ensure_app_schema(conn)
        for table in ("evoflow_chat_sessions", "evoflow_chat_messages", "evoflow_collab_tasks"):
            try:
                conn.execute(f"DELETE FROM {table}")
            except Exception:
                pass
        conn.commit()
        # 【self-evolution-bot · 2026-11-22 · 第125轮 · 模型:deepseek-v4.1-flash】
        # 必须建一个 active 角色：`prepare_proactive_chat_session` 入口有
        # `_employee_code_accepts_sessions(code)` 守卫，员工不存在就直接 return None，
        # 于是绑定逻辑一行都跑不到（我第一次漏了这步，两条用例红在「根本不是代码错」）。
        self._seed_role()

    def _seed_role(self) -> None:
        from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig
        from evoflow.proactive.repositories import ProactiveRepository

        ProactiveRepository.save_role(
            ProactiveRole(
                agent_code=AGENT,
                role_name="案例全栈开发工程师",
                config=ProactiveRoleConfig(),
                status="active",
            )
        )

    # ── helpers ──────────────────────────────────────────────────────────

    def _seed_session(self, session_key: str, thread_id: str) -> None:
        from evoflow.persistence import db as db_mod

        conn = db_mod.get_db(storage_sqlite_path=self.db_path)
        conn.execute(
            """
            INSERT INTO evoflow_chat_sessions (session_key, thread_id, message_count, is_deleted)
            VALUES (?, ?, 0, 0)
            ON CONFLICT(session_key) DO UPDATE SET thread_id = excluded.thread_id
            """,
            (session_key, thread_id),
        )
        conn.commit()

    def _seed_task_thread(self, thread_id: str | None) -> None:
        from evoflow.persistence import db as db_mod

        conn = db_mod.get_db(storage_sqlite_path=self.db_path)
        conn.execute("DELETE FROM evoflow_collab_tasks WHERE task_id = ?", (TASK_ID,))
        conn.execute(
            """
            INSERT INTO evoflow_collab_tasks (main_task_id, task_id, name, status, assigned_to, thread_id)
            VALUES (?, ?, '绑定优先级用例', 'executing', ?, ?)
            """,
            (TASK_ID, TASK_ID, AGENT, thread_id),
        )
        conn.commit()

    def _task_thread(self) -> str:
        from evoflow.persistence import db as db_mod

        conn = db_mod.get_db(storage_sqlite_path=self.db_path)
        row = conn.execute(
            "SELECT thread_id FROM evoflow_collab_tasks WHERE task_id = ?", (TASK_ID,)
        ).fetchone()
        return str((row["thread_id"] if row is not None else "") or "").strip()

    def _prepare(self, session_key: str, thread_id: str) -> None:
        from evoflow.proactive.chat_session import prepare_proactive_chat_session

        prepare_proactive_chat_session(
            agent_code=AGENT,
            role_name="案例全栈开发工程师",
            thread_id=thread_id,
            prompt="跑一次",
            session_key=session_key,
            task_id=TASK_ID,
        )

    # ── 用例 ─────────────────────────────────────────────────────────────

    def test_empty_binding_gets_filled(self):
        """原行为不许退化：thread_id 为空时照旧绑定。"""
        self._seed_task_thread(None)
        self._seed_session(TASK_SK, TASK_THREAD)
        self._prepare(TASK_SK, TASK_THREAD)
        self.assertEqual(self._task_thread(), TASK_THREAD)

    def test_task_bucket_takes_over_chat_bucket_binding(self):
        """本轮修复的主用例：chat 桶先占了位 → 本任务专用会话必须接管。"""
        self._seed_task_thread(CHAT_THREAD)
        self._seed_session(CHAT_SK, CHAT_THREAD)
        self._seed_session(TASK_SK, TASK_THREAD)
        self._prepare(TASK_SK, TASK_THREAD)
        self.assertEqual(
            self._task_thread(),
            TASK_THREAD,
            "执行会话建好后仍指向普通对话 = 任务详情会展示别人的聊天（用户说的「误导」）",
        )

    def test_chat_bucket_never_steals_existing_binding(self):
        """反证：普通对话会话不许把已有绑定改成自己。"""
        self._seed_task_thread(TASK_THREAD)
        self._seed_session(TASK_SK, TASK_THREAD)
        self._seed_session(CHAT_SK, CHAT_THREAD)
        self._prepare(CHAT_SK, CHAT_THREAD)
        self.assertEqual(self._task_thread(), TASK_THREAD)

    def test_task_bucket_binding_is_stable(self):
        """反证：已经绑到本任务 task 桶就不来回改（避免每次跑都翻一次）。"""
        self._seed_task_thread(TASK_THREAD)
        self._seed_session(TASK_SK, TASK_THREAD)
        self._prepare(TASK_SK, TASK_THREAD)
        self.assertEqual(self._task_thread(), TASK_THREAD)

    def test_collab_thread_binding_is_respected(self):
        """边界：绑定在协作/工作流线程（非 proactive 桶）时，task 桶也不许抢。"""
        self._seed_task_thread(COLLAB_THREAD)
        self._seed_session(TASK_SK, TASK_THREAD)
        # 协作线程下的会话不是 proactive 键
        self._seed_session("agent:main:task-x", COLLAB_THREAD)
        self._prepare(TASK_SK, TASK_THREAD)
        self.assertEqual(self._task_thread(), COLLAB_THREAD)


if __name__ == "__main__":
    unittest.main()
