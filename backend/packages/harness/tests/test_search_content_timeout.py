"""search_content wall-clock timeout must not wait for slow workers on pool exit."""

from __future__ import annotations

import time
from concurrent.futures import TimeoutError as FuturesTimeoutError
from unittest.mock import patch


def test_search_content_pool_timeout_returns_before_worker_finishes() -> None:
    from evoflow.tools.host_direct.search_content import _SEARCH_CONTENT_POOL

    def slow_search() -> str:
        time.sleep(10)
        return "done"

    t0 = time.time()
    fut = _SEARCH_CONTENT_POOL.submit(slow_search)
    try:
        fut.result(timeout=2.0)
    except FuturesTimeoutError:
        pass
    elapsed = time.time() - t0
    assert elapsed < 4.0


def test_search_content_tool_timeout_message() -> None:
    from concurrent.futures import TimeoutError as FuturesTimeoutError

    from langgraph.prebuilt.tool_node import ToolRuntime

    from evoflow.tools.host_direct.search_content import _SEARCH_CONTENT_POOL, search_content_hd

    rt = ToolRuntime(
        state={"messages": []},
        context={},
        config={"configurable": {}},
        store=None,
        stream_writer=lambda x: None,
        tool_call_id="tc-1",
    )

    with patch.object(_SEARCH_CONTENT_POOL, "submit") as submit:
        fut = submit.return_value
        fut.result.side_effect = FuturesTimeoutError()
        with patch(
            "evoflow.tools.host_direct.workspace_path_guard.resolve_filesystem_search_root",
            return_value=(".", None),
        ):
            out = search_content_hd.invoke({"pattern": "x", "runtime": rt})
    assert "timed out" in str(out).lower()
