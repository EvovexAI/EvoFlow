"""Issue #106: split LangGraph process must warm MCP without Gateway init loop."""

from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

_BACKEND_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND_ROOT))
sys.path.insert(0, str(_BACKEND_ROOT / "packages" / "harness"))


class McpSplitLangGraphCacheTest(unittest.TestCase):
    def setUp(self) -> None:
        from evoflow.mcp import cache as mcp_cache

        mcp_cache.reset_mcp_tools_cache()
        mcp_cache._set_unavailable_reason(None)
        mcp_cache._registered_init_loop = None
        mcp_cache._dedicated_init_loop = None
        mcp_cache._dedicated_init_thread = None

    def tearDown(self) -> None:
        from evoflow.mcp import cache as mcp_cache

        # Stop dedicated loop if we started one.
        loop = mcp_cache._dedicated_init_loop
        if loop is not None and loop.is_running():
            loop.call_soon_threadsafe(loop.stop)
        mcp_cache.reset_mcp_tools_cache()
        mcp_cache._registered_init_loop = None
        mcp_cache._dedicated_init_loop = None
        mcp_cache._dedicated_init_thread = None
        mcp_cache._set_unavailable_reason(None)

    def test_get_cached_mcp_tools_inits_via_dedicated_loop_without_gateway(self) -> None:
        from evoflow.mcp import cache as mcp_cache

        fake_tool = SimpleNamespace(name="mcp__demo__ping")

        async def fake_init() -> list:
            mcp_cache._mcp_tools_cache = [fake_tool]
            mcp_cache._cache_initialized = True
            return [fake_tool]

        with patch.object(mcp_cache, "initialize_mcp_tools", side_effect=fake_init):
            tools = mcp_cache.get_cached_mcp_tools()

        self.assertEqual(len(tools), 1)
        self.assertEqual(tools[0].name, "mcp__demo__ping")
        self.assertTrue(mcp_cache.mcp_cache_initialized())
        self.assertIsNone(mcp_cache.mcp_unavailable_reason())

    def test_chinese_server_name_becomes_ascii_tool_id(self) -> None:
        from evoflow.mcp.binding import (
            allowed_mcp_server_ids,
            filter_tools_by_mcp_servers,
            mcp_server_tool_id,
            qualified_mcp_tool_name,
        )

        display = "中文示例"
        tool_id = mcp_server_tool_id(display)
        self.assertTrue(tool_id)
        self.assertNotEqual(tool_id, display)
        self.assertRegex(tool_id, r"^[a-zA-Z0-9_-]+$")

        qname = qualified_mcp_tool_name(display, "ping")
        self.assertEqual(qname, f"mcp__{tool_id}__ping")
        self.assertRegex(qname, r"^mcp__[a-zA-Z0-9_-]+__ping$")

        tool = SimpleNamespace(name=qname)
        kept = filter_tools_by_mcp_servers([tool], [display])
        self.assertEqual(len(kept), 1)
        self.assertIn(tool_id, allowed_mcp_server_ids([display]))

    def test_ascii_server_name_unchanged(self) -> None:
        from evoflow.mcp.binding import mcp_server_tool_id, qualified_mcp_tool_name

        self.assertEqual(mcp_server_tool_id("demo"), "demo")
        self.assertEqual(qualified_mcp_tool_name("demo", "ping"), "mcp__demo__ping")

    def test_asyncio_cold_path_kicks_background_warmup(self) -> None:
        from evoflow.mcp import cache as mcp_cache

        kicked: list[str] = []

        def fake_kick() -> None:
            kicked.append("kick")

        async def main() -> None:
            with patch.object(mcp_cache, "kick_mcp_tools_warmup_background", side_effect=fake_kick):
                tools = mcp_cache.get_cached_mcp_tools()
            self.assertEqual(tools, [])
            self.assertEqual(kicked, ["kick"])

        asyncio.run(main())


if __name__ == "__main__":
    unittest.main()
