"""Tests for parallel worker() file-edit tool."""

from __future__ import annotations

import asyncio
from unittest.mock import patch

from evoflow.scheduler.engine import format_execution_report_xml
from evoflow.subagents.builtins.file_worker import FILE_WORKER_CONFIG
from evoflow.subagents.builtins.search_worker import SEARCH_WORKER_CONFIG
from evoflow.tools.builtins.worker_tool import (
    WorkerTaskSpec,
    _inner_tools_from_subagent,
    action_display_tool_name,
    build_search_worker_prompt,
    build_worker_prompt,
    validate_worker_tasks,
    worker_tool_call_id,
)
from evoflow.tools.host_direct.workspace_path_guard import runtime_with_workspace


class _ToolStub:
    def __init__(self, name: str) -> None:
        self.name = name


def test_build_worker_prompt_edit():
    from evoflow.tools.builtins.worker_tool import WorkerTaskSpec

    spec = WorkerTaskSpec(path="src/a.py", action="edit", instruction="Add retry backoff")
    text = build_worker_prompt(spec)
    assert "path: src/a.py" in text
    assert "action: edit" in text
    assert "Add retry backoff" in text
    assert "only modify the path above" in text


def test_build_worker_prompt_write_with_content():
    from evoflow.tools.builtins.worker_tool import WorkerTaskSpec

    spec = WorkerTaskSpec(path="b.py", action="write", content="hello\nworld")
    text = build_worker_prompt(spec)
    assert "content:" in text
    assert "hello" in text


def test_build_search_worker_prompt():
    from evoflow.tools.builtins.worker_tool import WorkerTaskSpec

    spec = WorkerTaskSpec(action="search", query="worker|file_worker", read_limit=3)
    text = build_search_worker_prompt(spec)
    assert "query: worker|file_worker" in text
    assert "read_limit: 3" in text
    assert "search_code_index with the read_limit above" in text
    assert "read-only" in text


def test_action_display_tool_name_mapping():
    assert action_display_tool_name("write") == "write_to_file"
    assert action_display_tool_name("replace") == "replace_in_file"
    assert action_display_tool_name("delete") == "delete_file"
    assert action_display_tool_name("edit") == "worker"
    assert action_display_tool_name("search") == "search_code_index"


def test_worker_tool_call_id_stable():
    a = worker_tool_call_id(0, "foo.py")
    b = worker_tool_call_id(0, "foo.py")
    c = worker_tool_call_id(1, "foo.py")
    assert a == b
    assert a != c
    assert a.startswith("worker-0-")


def test_validate_empty_tasks():
    specs, err = validate_worker_tasks([])
    assert specs is None
    assert "at least one task" in err


def test_validate_same_path_multiple_tasks_ok(tmp_path):
    """Same path in multiple tasks is allowed; execution serializes them."""
    root = tmp_path / "ws"
    root.mkdir()
    (root / "dup.py").write_text("x", encoding="utf-8")
    rt = runtime_with_workspace(str(root))
    raw = [
        {"path": "dup.py", "action": "edit", "instruction": "a"},
        {"path": "dup.py", "action": "edit", "instruction": "b"},
    ]
    specs, err = validate_worker_tasks(raw, runtime=rt)
    assert err is None
    assert specs is not None
    assert len(specs) == 2


def test_validate_many_tasks(tmp_path):
    root = tmp_path / "ws"
    root.mkdir()
    rt = runtime_with_workspace(str(root))
    raw = [{"path": f"f{i}.py", "action": "write", "content": "x"} for i in range(12)]
    specs, err = validate_worker_tasks(raw, runtime=rt)
    assert err is None
    assert specs is not None
    assert len(specs) == 12


def test_validate_search_defaults_read_limit():
    specs, err = validate_worker_tasks([{"action": "search", "query": "foo"}])
    assert err is None
    assert specs is not None
    # Default is 0 (catalog only) to align with the worker_tool prompt contract
    # and the main-thread search_code_index behaviour; explicit 1-4 opt-in for prefetch.
    assert specs[0].read_limit == 0


def test_validate_search_respects_read_limit_zero():
    specs, err = validate_worker_tasks(
        [{"action": "search", "query": "foo", "read_limit": 0}],
    )
    assert err is None
    assert specs is not None
    assert specs[0].read_limit == 0


def test_validate_search_requires_query():
    specs, err = validate_worker_tasks([{"action": "search"}])
    assert specs is None
    assert "search requires query" in err


def test_validate_search_rejects_filename_query():
    specs, err = validate_worker_tasks(
        [{"action": "search", "query": "agent-trace.html"}],
    )
    assert specs is None
    assert err is not None
    assert "find_file" in err


def test_validate_locate_requires_pattern():
    specs, err = validate_worker_tasks([{"action": "locate"}])
    assert specs is None
    assert "locate requires query" in err


def test_validate_locate_accepts_pattern():
    specs, err = validate_worker_tasks(
        [{"action": "locate", "query": "*settings*", "path": "src"}],
    )
    assert err is None
    assert specs is not None
    assert specs[0].action == "locate"


def test_validate_locate_with_thread_id_does_not_raise():
    from evoflow.tools.host_direct.workspace_path_guard import runtime_with_workspace

    rt = runtime_with_workspace(".", "t-locate-budget")
    specs, err = validate_worker_tasks(
        [{"action": "locate", "query": "superpowers*", "path": "skills"}],
        runtime=rt,
    )
    assert err is None
    assert specs is not None
    assert specs[0].query == "superpowers*"


def test_validate_duplicate_query():
    raw = [
        {"action": "search", "query": "foo|bar"},
        {"action": "search", "query": "foo|bar"},
    ]
    specs, err = validate_worker_tasks(raw)
    assert specs is None
    assert "duplicate query" in err


def test_validate_redundant_search_query_reorder():
    raw = [
        {"action": "search", "query": "foo|bar"},
        {"action": "search", "query": "bar|foo"},
    ]
    specs, err = validate_worker_tasks(raw)
    assert specs is None
    assert "redundant search query" in err


def test_validate_redundant_search_query_subset():
    raw = [
        {"action": "search", "query": "MessageRow"},
        {"action": "search", "query": "MessageRow|message-content"},
    ]
    specs, err = validate_worker_tasks(raw)
    assert specs is None
    assert "redundant search query" in err


def test_validate_distinct_parallel_search_queries_ok():
    raw = [
        {"action": "search", "query": "MessageRow|message-content"},
        {"action": "search", "query": "feishu|lark|FeishuChannel"},
    ]
    specs, err = validate_worker_tasks(raw)
    assert err is None
    assert specs and len(specs) == 2


def test_validate_mixed_search_and_locate_ok():
    raw = [
        {"action": "search", "query": "path:backend automation|schedule"},
        {"action": "search", "query": "path:backend gateway scheduler|trigger"},
        {"action": "locate", "query": "*automation*", "path": "backend"},
        {"action": "locate", "query": "*schedul*", "path": "backend"},
    ]
    specs, err = validate_worker_tasks(raw)
    assert err is None
    assert specs is not None
    assert len(specs) == 4


def test_validate_mixed_search_and_file_rejected(tmp_path):
    root = tmp_path / "ws"
    root.mkdir()
    (root / "a.py").write_text("x", encoding="utf-8")
    rt = runtime_with_workspace(str(root))
    raw = [
        {"action": "search", "query": "worker"},
        {"path": "a.py", "action": "edit", "instruction": "fix"},
    ]
    specs, err = validate_worker_tasks(raw, runtime=rt)
    assert specs is None
    assert "cannot mix read-only discovery" in err


def test_validate_edit_requires_instruction(tmp_path):
    root = tmp_path / "ws"
    root.mkdir()
    rt = runtime_with_workspace(str(root))
    specs, err = validate_worker_tasks([{"path": "x.py", "action": "edit"}], runtime=rt)
    assert specs is None
    assert "edit requires instruction" in err


def test_format_worker_search_deliverable_hoists_path_and_code():
    from evoflow.tools.builtins.worker_tool import _format_worker_search_deliverable

    result_rows = [
        {
            "index": 0,
            "ok": True,
            "query": "feishu|lark",
            "inner_tools": [
                {
                    "output": (
                        "catalog hits\n"
                        "<post_search_reads offset=0 limit=2>\n"
                        "[tool:summary] tool=read_file\npath: src/a.py\ncore: alpha\n\n"
                        "[tool:summary] tool=read_file\npath: src/b.py\ncore: beta\n"
                        "</post_search_reads>"
                    ),
                },
            ],
        },
    ]
    out = _format_worker_search_deliverable(result_rows)
    assert out.startswith("<worker_code_reads>")
    assert "path: src/a.py" in out
    assert "core: alpha" in out
    assert "path: src/b.py" in out
    assert "<post_search_reads" in out


def test_format_worker_search_deliverable_dedupes_same_path_across_workers():
    from evoflow.tools.builtins.worker_tool import _format_worker_search_deliverable

    snippet = (
        "<post_search_reads offset=0 limit=1>\n"
        "[tool:summary] tool=read_file\npath: src/shared.py\ncore: same snippet\n"
        "</post_search_reads>"
    )
    result_rows = [
        {"index": 0, "ok": True, "query": "feishu", "inner_tools": [{"output": f"hits\n{snippet}"}]},
        {"index": 1, "ok": True, "query": "lark", "inner_tools": [{"output": f"hits\n{snippet}"}]},
    ]
    out = _format_worker_search_deliverable(result_rows)
    assert out.count("path: src/shared.py") == 1
    assert out.count("same snippet") == 1
    assert "### query: feishu" in out
    assert "### query: lark" in out


def test_format_worker_execution_report_puts_reads_first():
    from evoflow.scheduler.engine import ExecutionReport
    from evoflow.tools.builtins.worker_tool import _format_worker_execution_report

    report = ExecutionReport(
        status="ok",
        results=[{"op": "worker=0 query=foo action=search", "ok": True, "output_preview": "status"}],
    )
    result_rows = [
        {
            "index": 0,
            "ok": True,
            "query": "foo",
            "inner_tools": [
                {
                    "output": (
                        "hits\n<post_search_reads>\n"
                        "[tool:summary] tool=read_file\npath: x.py\ncore: snippet\n"
                        "</post_search_reads>"
                    ),
                },
            ],
        },
    ]
    text = _format_worker_execution_report(report, result_rows, batch_kind="search")
    reads_pos = text.index("<worker_code_reads>")
    next_pos = text.index("<worker_search_next_step>")
    report_pos = text.index("<execution_report>")
    json_pos = text.index("<worker_search_results>")
    assert reads_pos < next_pos < report_pos < json_pos
    assert "path: x.py" in text
    assert "core: snippet" in text
    assert "NOT done if the user asked" in text


def test_format_worker_search_next_step_lists_catalog_paths():
    from evoflow.tools.builtins.worker_tool import _format_worker_search_next_step

    rows = [
        {
            "index": 0,
            "ok": True,
            "inner_tools": [
                {
                    "output": (
                        "Read catalog:\n  [0] src/a.py:10\n  [1] src/b.py:20\n"
                        "<post_search_reads>\n"
                        "[tool:summary] tool=read_file\npath: src/a.py\ncore: alpha\n"
                        "</post_search_reads>"
                    ),
                },
            ],
        },
    ]
    block = _format_worker_search_next_step(rows)
    assert "src/a.py" in block
    assert "src/b.py" in block
    assert "edit|replace" in block


def test_build_search_inner_tools_includes_output():
    from evoflow.tools.builtins.worker_tool import WorkerTaskSpec, _build_search_inner_tools

    spec = WorkerTaskSpec(action="search", query="feishu|lark", read_limit=8)
    out = "hits\n<post_search_reads>\n[tool:summary] tool=read_file\npath: a.py\ncore: x\n</post_search_reads>"
    rows = _build_search_inner_tools(spec, out, parent_worker_tc_id="tc-parent", index=0)
    assert len(rows) == 1
    assert rows[0]["name"] == "search_code_index"
    assert rows[0]["output"] == out
    assert rows[0]["input"]["read_limit"] == 8


def test_inner_tools_from_subagent_search_and_read():
    spec = WorkerTaskSpec(action="search", query="worker|file_worker", read_limit=2)
    stream = [
        {
            "type": "tool",
            "name": "search_code_index",
            "content": "hits\n<post_search_reads>\n[tool:summary] tool=read_file\npath: src/a.py\ncore: alpha\n</post_search_reads>",
        },
        {
            "type": "tool",
            "name": "read_file",
            "content": "[tool:summary] tool=read_file\npath: src/b.py\ncore: beta",
        },
    ]
    rows = _inner_tools_from_subagent(
        spec,
        stream,
        parent_worker_tc_id="tc-parent",
        index=0,
    )
    names = [r["name"] for r in rows]
    assert names.count("search_code_index") == 1
    assert "read_file" in names
    assert rows[0]["input"]["query"] == "worker|file_worker"
    assert any(r.get("input", {}).get("path") == "src/b.py" for r in rows if r["name"] == "read_file")


def test_search_worker_tool_filtering():
    assert SEARCH_WORKER_CONFIG.tools == [
        "read_file",
        "find_file",
        "rg",
        "search_code_index",
    ]
    denied = set(SEARCH_WORKER_CONFIG.disallowed_tools or [])
    assert "write_to_file" in denied
    assert "terminal" in denied
    assert "worker" in denied


def test_file_worker_tool_filtering():
    assert FILE_WORKER_CONFIG.tools == [
        "read",
        "write",
        "replace",
        "delete",
        "read_lints",
    ]
    denied = set(FILE_WORKER_CONFIG.disallowed_tools or [])
    assert "task" in denied
    assert "worker" in denied
    assert "terminal" in denied

    import importlib
    import sys

    mock_holder = sys.modules.get("evoflow.subagents.executor")
    try:
        sys.modules.pop("evoflow.subagents.executor", None)
        executor_mod = importlib.import_module("evoflow.subagents.executor")
        mock_tools = [
            _ToolStub("read"),
            _ToolStub("write"),
            _ToolStub("replace"),
            _ToolStub("delete"),
            _ToolStub("read_lints"),
            _ToolStub("task"),
            _ToolStub("terminal"),
        ]
        filtered = executor_mod._filter_tools(
            mock_tools,
            FILE_WORKER_CONFIG.tools,
            FILE_WORKER_CONFIG.disallowed_tools,
        )
        names = {t.name for t in filtered}
        assert names == {"read", "write", "replace", "delete", "read_lints"}
    finally:
        if mock_holder is not None:
            sys.modules["evoflow.subagents.executor"] = mock_holder


def test_run_workers_parallel_concurrency():
    import sys
    from unittest.mock import MagicMock

    from evoflow.tools.builtins.worker_tool import WorkerTaskSpec, _run_workers_async

    specs = [
        WorkerTaskSpec(path="a.py", action="write", content="a"),
        WorkerTaskSpec(path="b.py", action="write", content="b"),
        WorkerTaskSpec(path="c.py", action="write", content="c"),
    ]
    completed = object()
    running = object()
    pending = object()
    active = 0
    peak = 0
    lock = asyncio.Lock()
    bg_status: dict[str, object] = {}
    bg_results: dict[str, MagicMock] = {}

    class _FakeExecutor:
        def __init__(self, *args, **kwargs):
            pass

        def execute_async(self, task: str, task_id: str | None = None) -> str:
            bg_id = str(task_id or "bg")
            result = MagicMock()
            result.status = pending
            result.result = f"done {task[:20]}"
            result.error = None
            bg_status[bg_id] = pending
            bg_results[bg_id] = result

            async def _finish():
                nonlocal active, peak
                async with lock:
                    active += 1
                    peak = max(peak, active)
                await asyncio.sleep(0.05)
                async with lock:
                    active -= 1
                result.status = completed
                bg_status[bg_id] = completed

            asyncio.get_event_loop().create_task(_finish())
            return bg_id

    def fake_get_result(bg_id: str):
        st = bg_status.get(bg_id)
        if st is pending:
            return bg_results[bg_id]
        if st is completed:
            return bg_results[bg_id]
        return None

    executor_mock = sys.modules["evoflow.subagents.executor"]
    executor_mock.SubagentStatus.COMPLETED = completed
    executor_mock.SubagentStatus.FAILED = object()
    executor_mock.SubagentStatus.PENDING = pending
    executor_mock.SubagentStatus.RUNNING = running

    with patch(
        "evoflow.tools.builtins.worker_tool.SubagentExecutor",
        _FakeExecutor,
    ):
        with patch(
            "evoflow.tools.builtins.worker_tool.get_background_task_result",
            side_effect=fake_get_result,
        ):
            with patch("evoflow.tools.builtins.worker_tool.cleanup_background_task"):
                with patch(
                    "evoflow.tools.builtins.worker_tool.emit_prefetch_tool_result",
                ) as result_emit:
                    with patch(
                        "evoflow.tools.builtins.worker_tool.emit_worker_stream_updates",
                    ) as worker_emit:
                        results = asyncio.run(
                            _run_workers_async(
                                specs,
                                parent_tool_call_id="tc-parent",
                                max_concurrency=2,
                                max_turns=12,
                                tools=[],
                                parent_model=None,
                                sandbox_state=None,
                                thread_data=None,
                                thread_id="test",
                                local_workspace_root=None,
                                trace_id="trace",
                                stream_writer=None,
                            ),
                        )
                        assert result_emit.call_count == 3
                        assert worker_emit.call_count == 3

    assert len(results) == 3
    assert peak <= 2


def test_execution_report_xml_partial():
    from evoflow.scheduler.engine import ExecutionReport

    report = ExecutionReport(
        status="partial",
        results=[
            {"op": "worker=0 path=a.py action=write", "ok": True, "output_preview": "ok"},
            {"op": "worker=1 path=b.py action=write", "ok": False, "error": "failed"},
        ],
    )
    xml = format_execution_report_xml(report)
    assert "<execution_report>" in xml
    assert "status: partial" in xml
    assert "worker=0" in xml
    assert "worker=1" in xml


def test_worker_tool_end_to_end_mock(tmp_path):
    import sys
    from unittest.mock import MagicMock

    from evoflow.tools.builtins.worker_tool import worker_tool

    root = tmp_path / "ws"
    root.mkdir()
    (root / "one.py").write_text("1", encoding="utf-8")
    (root / "two.py").write_text("2", encoding="utf-8")
    rt = runtime_with_workspace(str(root))

    tasks = [
        {"path": "one.py", "action": "edit", "instruction": "fix"},
        {"path": "two.py", "action": "edit", "instruction": "fix"},
    ]

    executor_mock = sys.modules["evoflow.subagents.executor"]
    completed = object()
    failed = object()
    executor_mock.SubagentStatus.COMPLETED = completed
    executor_mock.SubagentStatus.FAILED = failed

    async def fake_run_workers_async(specs, **kwargs):
        out = []
        for index, spec in enumerate(specs):
            result = MagicMock()
            if spec.path == "one.py":
                result.status = completed
                result.result = "edited one"
                result.error = None
            else:
                result.status = failed
                result.result = None
                result.error = "boom"
            out.append((index, spec, result, None, None, None))
        return out

    with patch(
        "evoflow.tools.builtins.worker_tool._run_workers_async",
        fake_run_workers_async,
    ):
        with patch("evoflow.tools.get_available_tools", return_value=[]):
            with patch(
                "evoflow.tools.builtins.worker_tool.emit_prefetch_tool_calls_batch",
            ) as batch_emit:
                with patch(
                    "evoflow.tools.builtins.worker_tool.emit_prefetch_tool_result",
                ) as result_emit:
                    out = asyncio.run(
                        worker_tool.ainvoke(
                            {
                                "args": {"tasks": tasks, "runtime": rt},
                                "name": "worker",
                                "type": "tool_call",
                                "id": "tc-worker-1",
                                "tool_call_id": "tc-worker-1",
                            },
                            config={
                                "configurable": {
                                    "thread_id": "test-thread",
                                    "local_workspace_root": str(root),
                                },
                            },
                        ),
                    )
                    text = getattr(out, "content", out)
                    if not isinstance(text, str):
                        text = str(text)
                    assert "<execution_report>" in text
                    assert "status: partial" in text
                    assert "one.py" in text
                    assert "two.py" in text
                    batch_emit.assert_called_once()
                    result_emit.assert_not_called()


def test_worker_tool_search_batch_mock(tmp_path):
    import sys
    from unittest.mock import MagicMock

    from evoflow.tools.builtins.worker_tool import worker_tool

    root = tmp_path / "ws"
    root.mkdir()
    rt = runtime_with_workspace(str(root))

    tasks = [
        {"action": "search", "query": "worker|file_worker"},
        {"action": "search", "query": "search_code_index"},
    ]

    executor_mock = sys.modules["evoflow.subagents.executor"]
    completed = object()
    executor_mock.SubagentStatus.COMPLETED = completed

    async def fake_run_workers_async(specs, **kwargs):
        out = []
        for index, spec in enumerate(specs):
            result = MagicMock()
            result.status = completed
            result.result = f"found {spec.query}"
            result.error = None
            out.append((index, spec, result, None, None, None))
        return out

    with patch(
        "evoflow.tools.builtins.worker_tool._run_workers_async",
        fake_run_workers_async,
    ):
        with patch("evoflow.tools.get_available_tools", return_value=[]):
            with patch("evoflow.tools.builtins.worker_tool.emit_prefetch_tool_calls_batch"):
                out = asyncio.run(
                    worker_tool.ainvoke(
                        {
                            "args": {"tasks": tasks, "runtime": rt},
                            "name": "worker",
                            "type": "tool_call",
                            "id": "tc-worker-search",
                            "tool_call_id": "tc-worker-search",
                        },
                        config={
                            "configurable": {
                                "thread_id": "test-thread",
                                "local_workspace_root": str(root),
                            },
                        },
                    ),
                )
                text = getattr(out, "content", out)
                if not isinstance(text, str):
                    text = str(text)
                assert "<execution_report>" in text
                assert "status: ok" in text
                assert "<worker_search_results>" in text
                assert "worker|file_worker" in text
                assert "search_code_index" in text
