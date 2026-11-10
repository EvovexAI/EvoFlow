"""MCP worker tooling fixes (2026-11-07 修复提示词 P0/P1)。

- P0-1 ``ensure_mcp_tools_ready``：任意 loop 可就绪 + unavailable reason 留痕
- P0-2 step 显式 tools = 执行白名单（read 不得自动扩族出 bash）
- P0-3 ``partition_tool_names`` 不依赖进程内 MCP 运行时缓存
- P1-2 mcp-status 快照作用域标注
- P1-3 失败级联：上游终态失败 → 传递下游 blocked，不再 waiting_dispatch 卡死
"""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

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


class McpWorkerToolingFixesTest(unittest.TestCase):
    tmp_dir: tempfile.TemporaryDirectory | None = None
    db_path: str | None = None
    _previous_db_path: str | None = None
    _previous_storage_env: str | None = None

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp_dir = tempfile.TemporaryDirectory(prefix="evoflow-mcp-worker-fix-")
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

        db_mod.reset_db_for_tests()
        try:
            Path(self.db_path or "").unlink(missing_ok=True)
        except OSError:
            pass
        conn = db_mod.get_db(storage_sqlite_path=self.db_path)
        ensure_app_schema(conn)
        from evoflow.mcp import cache as mcp_cache

        mcp_cache.reset_mcp_tools_cache()
        mcp_cache._set_unavailable_reason(None)

    def tearDown(self) -> None:
        from evoflow.persistence import db as db_mod

        db_mod.reset_db_for_tests()

    # ── P0-1 ensure_mcp_tools_ready ────────────────────────────────────────

    def test_ensure_mcp_tools_ready_initializes_on_calling_loop(self) -> None:
        from evoflow.mcp import cache as mcp_cache

        fake_tool = SimpleNamespace(name="mcp__srv__health")
        init_calls: list[str] = []

        async def fake_init() -> list:
            init_calls.append("init")
            mcp_cache._mcp_tools_cache = [fake_tool]
            mcp_cache._cache_initialized = True
            return [fake_tool]

        async def main() -> None:
            with patch.object(mcp_cache, "initialize_mcp_tools", side_effect=fake_init):
                tools = await mcp_cache.ensure_mcp_tools_ready(timeout_sec=5)
            self.assertEqual(len(tools), 1)
            self.assertEqual(tools[0].name, "mcp__srv__health")
            # 缓存热后不再重复初始化
            with patch.object(mcp_cache, "initialize_mcp_tools", side_effect=fake_init):
                tools2 = await mcp_cache.ensure_mcp_tools_ready(timeout_sec=5)
            self.assertEqual(len(tools2), 1)
            self.assertIsNone(mcp_cache.mcp_unavailable_reason())

        asyncio.run(main())
        self.assertEqual(len(init_calls), 1)
        self.assertTrue(mcp_cache.mcp_cache_initialized())

    def test_get_cached_mcp_tools_cold_on_loop_records_reason(self) -> None:
        from evoflow.mcp import cache as mcp_cache

        async def main() -> None:
            tools = mcp_cache.get_cached_mcp_tools()
            self.assertEqual(tools, [])
            reason = mcp_cache.mcp_unavailable_reason()
            self.assertIsNotNone(reason)
            self.assertIn("asyncio task", reason)

        asyncio.run(main())

    # ── P0-2 step 显式 tools = 执行白名单 ──────────────────────────────────

    def test_step_tools_whitelist_does_not_augment_file_io(self) -> None:
        from evoflow.collab.worker_tool_allowlist import _intersect_catalog

        catalog = {"read", "write", "replace", "delete", "bash", "taskoutput", "taskstop"}
        # 继承路径：声明 read 自动补齐 file-IO 兄弟（含 bash）——旧行为保留
        inherited = _intersect_catalog(["read"], catalog)
        self.assertIn("bash", inherited)
        # step 显式声明：执行白名单，read 不得带出 bash/write
        explicit = _intersect_catalog(["read"], catalog, augment=False)
        self.assertEqual(explicit, ["read"])

    def test_profile_tools_path_returns_exact_allowlist(self) -> None:
        from evoflow.collab.worker_tool_allowlist import resolve_worker_tool_allowlist

        catalog = {"read", "bash", "write", "mcp__srv__analyze"}
        out = resolve_worker_tool_allowlist(
            profile_tools=["read", "mcp__srv__analyze"],
            assignee_agent_code=None,
            base_subagent="agent",
            subagent_config_tools=None,
            catalog_names=catalog,
            session_key=None,
            session_mode=None,
        )
        self.assertEqual(sorted(out), ["mcp__srv__analyze", "read"])

    # ── P0-3 校验不依赖运行时缓存 ──────────────────────────────────────────

    def test_partition_tool_names_vouches_server_without_runtime_cache(self) -> None:
        from evoflow.config.agent_resource_validation import partition_tool_names

        known, unknown = partition_tool_names(
            ["mcp__ecommerce-shangce__health", "definitely_not_a_tool"],
            extra_allowed_servers={"ecommerce-shangce"},
        )
        self.assertEqual(known, ["mcp__ecommerce-shangce__health"])
        self.assertEqual(unknown, ["definitely_not_a_tool"])

    def test_partition_tool_names_rejects_unrelated_mcp_server(self) -> None:
        from evoflow.config.agent_resource_validation import partition_tool_names

        known, unknown = partition_tool_names(
            ["mcp__other-server__tool"], extra_allowed_servers={"ecommerce-shangce"}
        )
        self.assertEqual(known, [])
        self.assertEqual(unknown, ["mcp__other-server__tool"])

    # ── P1-2 状态快照作用域 ────────────────────────────────────────────────

    def test_mcp_status_snapshot_annotates_scope(self) -> None:
        from evoflow.mcp import cache as mcp_cache
        from evoflow.mcp.status import build_mcp_status_snapshot

        # Never read the developer's real EVOFLOW_HOME snapshot (flaky locally).
        missing = Path(self.tmp_dir.name) / "no-such-mcp-status-snapshot.json"
        with patch.object(mcp_cache, "_mcp_snapshot_path", return_value=missing):
            snap = build_mcp_status_snapshot(raw_servers={"srv-x": {"enabled": True, "command": "x"}})
        self.assertEqual(snap["snapshot_source"], "none")
        self.assertIn("initialized_in_this_process", snap)
        self.assertIn("snapshot_pid", snap)
        self.assertIn("snapshot_at", snap)
        self.assertFalse(snap["initialized_in_this_process"])
        self.assertFalse(snap["cache_initialized"])
        # 语义修正：本进程不可见时不得用 pending 冒充「正在加载」
        self.assertEqual(snap["servers"][0]["load_status"], "unknown")
        self.assertIn("unknown_reason", snap["servers"][0])

    def test_mcp_status_snapshot_reads_persisted_from_other_process(self) -> None:
        """模拟 platform 工具 / CLI 进程：本地缓存冷，但网关进程落的快照可读。

        快照路径 patch 到临时目录——绝不写真实 EVOFLOW_HOME（会污染运行中网关
        的跨进程状态：writer_pid 变成测试进程 → 真网关读到「writer 已死」）。
        """
        from evoflow.mcp import cache as mcp_cache
        from evoflow.mcp.status import build_mcp_status_snapshot

        snap_file = Path(self.tmp_dir.name) / "snap" / "mcp-status-snapshot.json"
        fake_tool = SimpleNamespace(name="mcp__ecommerce-shangce__analyze_project")

        # 1) 写入方（模拟网关进程）：初始化 + 落盘
        mcp_cache._mcp_tools_cache = [fake_tool]
        mcp_cache._cache_initialized = True
        mcp_cache.set_mcp_server_load_status(
            {"ecommerce-shangce": {"load_status": "ready", "tool_count": 1, "error": None}}
        )
        with patch.object(mcp_cache, "_mcp_snapshot_path", return_value=snap_file):
            persisted = mcp_cache.persist_mcp_status_snapshot()
            self.assertIsNotNone(persisted)
            self.assertEqual(persisted["writer_pid"], os.getpid())
            self.assertTrue(snap_file.exists())

            # 2) 读取方（模拟另一个进程）：内存缓存清零，快照仍在
            mcp_cache._mcp_tools_cache = None
            mcp_cache._cache_initialized = False
            snap = build_mcp_status_snapshot(
                raw_servers={"ecommerce-shangce": {"enabled": True, "command": "x"}}
            )
            self.assertTrue(snap["cache_initialized"])
            self.assertFalse(snap["initialized_in_this_process"])
            self.assertEqual(snap["snapshot_source"], "persisted")
            self.assertEqual(snap["total_tools"], 1)
            srv = snap["servers"][0]
            self.assertEqual(srv["load_status"], "ready")
            self.assertEqual(srv["tool_count"], 1)

            # 3) writer 进程死亡 → 快照不可信 → unknown，不得冒充 ready/pending
            with patch.object(mcp_cache, "_process_alive", side_effect=lambda pid: False):
                snap_dead = build_mcp_status_snapshot(
                    raw_servers={"ecommerce-shangce": {"enabled": True, "command": "x"}}
                )
        self.assertFalse(snap_dead["cache_initialized"])
        self.assertEqual(snap_dead["snapshot_source"], "none")
        self.assertEqual(snap_dead["servers"][0]["load_status"], "unknown")

    # ── P1-3 失败级联 ──────────────────────────────────────────────────────

    @staticmethod
    def _fake_storage(subtasks: list[dict]) -> SimpleNamespace:
        project = {"id": "p1", "tasks": [{"id": "mt", "name": "T", "subtasks": subtasks}]}
        return SimpleNamespace(
            list_projects=lambda: [{"id": "p1"}],
            load_project=lambda pid, bypass_cache=False: project,
        )

    def test_cascade_failure_blocks_transitive_dependents(self) -> None:
        import evoflow.collab.subtask_outcome as so

        subtasks = [
            {"id": "a", "name": "A", "status": "timed_out"},
            {"id": "b", "name": "B", "status": "waiting_dispatch", "depends_on": ["a"]},
            {"id": "c", "name": "C", "status": "waiting_dispatch", "depends_on": ["b"]},
            {"id": "d", "name": "D", "status": "completed", "depends_on": ["a"]},
            {"id": "e", "name": "E", "status": "waiting_dispatch", "depends_on": ["d"]},
            {"id": "f", "name": "F", "status": "failed", "depends_on": ["a"]},
            {"id": "g", "name": "G", "status": "waiting_dispatch", "depends_on": ["f"]},
        ]
        calls: list[dict] = []

        async def fake_report(**kw):
            calls.append(kw)
            return {"ok": True}

        with patch.object(so, "apply_subtask_outcome_report", side_effect=fake_report):
            blocked = asyncio.run(
                so.cascade_failure_to_dependents(
                    "mt",
                    "a",
                    outcome="timed_out",
                    error="Execution timed out after 900 seconds",
                    storage=self._fake_storage(subtasks),
                )
            )
        # b/c 直系+传递下游被阻断；g 因 f 已失败也阻断；d(completed)→e 正常不受影响
        self.assertEqual(blocked, ["b", "c", "g"])
        for kw in calls:
            self.assertEqual(kw["outcome"], "failed")
            self.assertEqual(kw["reported_by"], "system")
            self.assertIn("900 seconds", kw["summary"])

    def test_cascade_noop_for_success_and_unknown(self) -> None:
        import evoflow.collab.subtask_outcome as so

        subtasks = [
            {"id": "a", "name": "A", "status": "completed"},
            {"id": "b", "name": "B", "status": "waiting_dispatch", "depends_on": ["a"]},
        ]

        async def fake_report(**kw):
            raise AssertionError("must not cascade on success")

        with patch.object(so, "apply_subtask_outcome_report", side_effect=fake_report):
            self.assertEqual(
                asyncio.run(
                    so.cascade_failure_to_dependents("mt", "a", outcome="completed", storage=self._fake_storage(subtasks))
                ),
                [],
            )
            self.assertEqual(
                asyncio.run(
                    so.cascade_failure_to_dependents("mt", "missing", outcome="failed", storage=self._fake_storage(subtasks))
                ),
                [],
            )


if __name__ == "__main__":
    unittest.main()
