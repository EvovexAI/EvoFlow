"""Tests for LoopDetectionMiddleware.

Covers the global identical-batch hash plus the three restored interception paths:

- global batch hash: non-explore batches warn at ``warn_threshold`` and block at
  ``hard_limit`` (synthetic error ToolMessage, run continues);
- explore loops: same-target read/list_dir/terminal warn at 3 / block at 5; search
  tools warn but never block; offset-bucket pagination does not trip;
- explore streak: 8 consecutive read batches with no act/progress warn once, act resets;
- error repeat: three identical real tool errors → fourth identical call blocked.
"""

import asyncio
from unittest.mock import MagicMock

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from evoflow.agents.middlewares.loop_detection_middleware import (
    _BLOCK_MSG,
    _ERROR_BLOCK_MSG,
    _EXPLORE_BLOCK_MSG,
    _EXPLORE_STREAK_WARN_MSG,
    _EXPLORE_WARNING_MSG,
    _WARNING_MSG,
    LoopDetectionMiddleware,
    _hash_tool_calls,
    _single_tool_fingerprint,
)


def _make_runtime(thread_id="test-thread"):
    """Build a minimal Runtime mock with context."""
    runtime = MagicMock()
    runtime.context = {"thread_id": thread_id}
    return runtime


def _make_state(tool_calls=None, content=""):
    """Build a minimal AgentState dict with an AIMessage."""
    msg = AIMessage(content=content, tool_calls=tool_calls or [])
    return {"messages": [msg]}


def _replace_call(key="a"):
    """Non-explore tool call → goes through the global identical-batch hash."""
    return {"name": "replace", "id": f"call_{key}", "args": {"path": "x.py", "content": key}}


def _read_call(path="/tmp/x.txt", offset=None, limit=None, call_id="call_read"):
    args = {"path": path}
    if offset is not None:
        args["offset"] = offset
    if limit is not None:
        args["limit"] = limit
    return {"name": "read_file", "id": call_id, "args": args}


def _rg_call(pattern="foo", call_id="call_rg"):
    return {"name": "rg", "id": call_id, "args": {"pattern": pattern}}


def _bash_call(cmd="node script.js", call_id=None):
    return {"name": "bash", "id": call_id or f"call_{cmd}", "args": {"command": cmd}}


def _tool_request(call, thread_id="test-thread"):
    req = MagicMock()
    req.tool_call = call
    runtime = MagicMock()
    runtime.context = {"thread_id": thread_id}
    req.runtime = runtime
    return req


def _handler_returning(result):
    return lambda request: result


def _error_tool_message(call, content):
    return ToolMessage(
        content=content,
        tool_call_id=call["id"],
        name=str(call.get("name") or "tool"),
        status="error",
    )


class TestHashToolCalls:
    def test_same_calls_same_hash(self):
        a = [{"name": "replace", "args": {"path": "a.py"}}]
        b = [{"name": "replace", "args": {"path": "a.py"}}]
        h1 = _hash_tool_calls(a)
        h2 = _hash_tool_calls(b)
        assert isinstance(h1, str)
        assert h1 == h2

    def test_different_calls_different_hash(self):
        a = [{"name": "replace", "args": {"path": "a.py"}}]
        b = [{"name": "replace", "args": {"path": "b.py"}}]
        assert _hash_tool_calls(a) != _hash_tool_calls(b)

    def test_order_independent(self):
        a = [
            {"name": "replace", "args": {"path": "a.py"}},
            {"name": "platform", "args": {"action": "show"}},
        ]
        b = [
            {"name": "platform", "args": {"action": "show"}},
            {"name": "replace", "args": {"path": "a.py"}},
        ]
        assert _hash_tool_calls(a) == _hash_tool_calls(b)

    def test_empty_calls(self):
        h = _hash_tool_calls([])
        assert isinstance(h, str)
        assert len(h) > 0


class TestSingleToolFingerprint:
    def test_pagination_offsets_differ(self):
        path = r"C:\tmp\large.txt"
        a = _single_tool_fingerprint(
            {"name": "read_file", "args": {"path": path, "offset": 0, "limit": 120}}
        )
        b = _single_tool_fingerprint(
            {"name": "read_file", "args": {"path": path, "offset": 250, "limit": 120}}
        )
        assert a != b


class TestGlobalBatchHash:
    def test_no_tool_calls_returns_none(self):
        mw = LoopDetectionMiddleware()
        runtime = _make_runtime()
        state = {"messages": [AIMessage(content="hello")]}
        result = mw._apply(state, runtime)
        assert result is None

    def test_below_threshold_returns_none(self):
        mw = LoopDetectionMiddleware(warn_threshold=3)
        runtime = _make_runtime()
        call = [_replace_call("a")]

        for _ in range(2):
            result = mw._apply(_make_state(tool_calls=call), runtime)
            assert result is None

    def test_warn_at_threshold(self):
        mw = LoopDetectionMiddleware(warn_threshold=3, hard_limit=5)
        runtime = _make_runtime()
        call = [_replace_call("a")]

        for _ in range(2):
            mw._apply(_make_state(tool_calls=call), runtime)

        result = mw._apply(_make_state(tool_calls=call), runtime)
        assert result is not None
        msgs = result["messages"]
        assert len(msgs) == 1
        assert isinstance(msgs[0], HumanMessage)
        assert _WARNING_MSG == msgs[0].content

    def test_warn_only_injected_once(self):
        mw = LoopDetectionMiddleware(warn_threshold=3, hard_limit=10)
        runtime = _make_runtime()
        call = [_replace_call("a")]

        for _ in range(2):
            mw._apply(_make_state(tool_calls=call), runtime)

        result = mw._apply(_make_state(tool_calls=call), runtime)
        assert result is not None

        # Warning already injected — subsequent identical batch returns None.
        result = mw._apply(_make_state(tool_calls=call), runtime)
        assert result is None

    def test_hard_limit_blocks_but_run_continues(self):
        mw = LoopDetectionMiddleware(warn_threshold=2, hard_limit=4)
        runtime = _make_runtime()
        call = [_replace_call("a")]

        for _ in range(3):
            mw._apply(_make_state(tool_calls=call), runtime)

        # Fourth batch hits hard limit — blocked ids registered, warn message returned.
        result = mw._apply(_make_state(tool_calls=call), runtime)
        assert result is not None
        msgs = result["messages"]
        assert len(msgs) == 1
        assert isinstance(msgs[0], HumanMessage)
        assert _BLOCK_MSG == msgs[0].content

        # wrap_tool_call rejects the blocked call with a synthetic error ToolMessage.
        request = _tool_request(call[0])
        executed = {"v": False}

        def handler(_request):
            executed["v"] = True
            return ToolMessage(content="ok", tool_call_id=call[0]["id"])

        blocked = mw.wrap_tool_call(request, handler)
        assert isinstance(blocked, ToolMessage)
        assert blocked.status == "error"
        assert _BLOCK_MSG == blocked.content
        assert not executed["v"]

    def test_different_calls_dont_trigger(self):
        mw = LoopDetectionMiddleware(warn_threshold=2)
        runtime = _make_runtime()

        for i in range(10):
            result = mw._apply(_make_state(tool_calls=[_replace_call(f"c{i}")]), runtime)
            assert result is None

    def test_window_sliding(self):
        mw = LoopDetectionMiddleware(warn_threshold=3, window_size=5)
        runtime = _make_runtime()
        call = [_replace_call("a")]

        mw._apply(_make_state(tool_calls=call), runtime)
        mw._apply(_make_state(tool_calls=call), runtime)

        for i in range(5):
            mw._apply(_make_state(tool_calls=[_replace_call(f"other_{i}")]), runtime)

        result = mw._apply(_make_state(tool_calls=call), runtime)
        assert result is None

    def test_reset_clears_state(self):
        mw = LoopDetectionMiddleware(warn_threshold=2)
        runtime = _make_runtime()
        call = [_replace_call("a")]

        mw._apply(_make_state(tool_calls=call), runtime)
        mw.reset(thread_id="test-thread")
        result = mw._apply(_make_state(tool_calls=call), runtime)
        assert result is None

    def test_non_ai_message_ignored(self):
        mw = LoopDetectionMiddleware()
        runtime = _make_runtime()
        state = {"messages": [HumanMessage(content="hi")]}
        assert mw._apply(state, runtime) is None

    def test_thread_safe_mutations(self):
        import threading

        mw = LoopDetectionMiddleware()
        runtime = _make_runtime("threaded")

        def worker():
            for _ in range(20):
                mw._apply(_make_state(tool_calls=[_replace_call("a")]), runtime)

        threads = [threading.Thread(target=worker) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        # No assertion beyond "no exception" — concurrent appends must not corrupt state.


class TestExploreLoops:
    def test_pagination_does_not_trip(self):
        mw = LoopDetectionMiddleware()
        runtime = _make_runtime("explore-pagination")
        path = r"C:\Users\80820\.evoflow\large_tool_results\read.txt"
        for offset in (0, 120, 250):
            call = [_read_call(path, offset=offset, limit=120)]
            result = mw._apply(_make_state(tool_calls=call), runtime)
            assert result is None, f"offset={offset} should not trip"

    def test_same_target_warns_at_three(self):
        mw = LoopDetectionMiddleware()
        runtime = _make_runtime("explore-warn")
        call = [_read_call("/tmp/x.txt")]

        mw._apply(_make_state(tool_calls=call), runtime)
        mw._apply(_make_state(tool_calls=call), runtime)
        result = mw._apply(_make_state(tool_calls=call), runtime)
        assert result is not None
        assert isinstance(result["messages"][0], HumanMessage)
        assert _EXPLORE_WARNING_MSG == result["messages"][0].content

    def test_same_target_blocks_at_five(self):
        mw = LoopDetectionMiddleware()
        runtime = _make_runtime("explore-block")
        call = [_read_call("/tmp/x.txt", call_id="call_r5")]

        for _ in range(4):
            mw._apply(_make_state(tool_calls=call), runtime)

        result = mw._apply(_make_state(tool_calls=call), runtime)
        assert result is not None
        assert _EXPLORE_BLOCK_MSG == result["messages"][0].content

        # The offending call id is blocked with a synthetic error ToolMessage.
        request = _tool_request(call[0], thread_id="explore-block")
        executed = {"v": False}

        def handler(_request):
            executed["v"] = True
            return ToolMessage(content="data", tool_call_id=call[0]["id"])

        blocked = mw.wrap_tool_call(request, handler)
        assert isinstance(blocked, ToolMessage)
        assert blocked.status == "error"
        assert _EXPLORE_BLOCK_MSG == blocked.content
        assert not executed["v"]

        # A different target in a later batch still executes.
        other = _read_call("/tmp/other.txt", call_id="call_ok")
        executed["v"] = False

        def ok_handler(_request):
            executed["v"] = True
            return ToolMessage(content="fine", tool_call_id=other["id"])

        out = mw.wrap_tool_call(_tool_request(other), ok_handler)
        assert executed["v"]
        assert out.content == "fine"

    def test_search_tools_warn_but_never_block(self):
        mw = LoopDetectionMiddleware()
        runtime = _make_runtime("explore-search")
        call = [_rg_call("foo")]

        warned_content = None
        for i in range(8):
            batch = [dict(call[0], id=f"call_rg_{i}")]
            result = mw._apply(_make_state(tool_calls=batch), runtime)
            if result is not None:
                warned_content = result["messages"][0].content

            request = _tool_request(batch[0])
            executed = {"v": False}

            def handler(_request):
                executed["v"] = True
                return ToolMessage(content="matches", tool_call_id=batch[0]["id"])

            out = mw.wrap_tool_call(request, handler)
            assert executed["v"], "search tools must never be blocked"
            assert out.content == "matches"
        assert warned_content == _EXPLORE_WARNING_MSG  # warned once, never blocked

    def test_streak_warns_after_eight_batches(self):
        mw = LoopDetectionMiddleware()
        runtime = _make_runtime("explore-streak")

        decision = None
        for i in range(8):
            # Fresh path every batch — same-target explore never fires.
            call = [_read_call(f"/tmp/fresh_{i}.txt")]
            result = mw._apply(_make_state(tool_calls=call), runtime)
            if result is not None:
                decision = result["messages"][0].content
        assert decision == _EXPLORE_STREAK_WARN_MSG

    def test_streak_resets_on_act(self):
        mw = LoopDetectionMiddleware()
        runtime = _make_runtime("explore-streak-reset")

        for i in range(7):
            mw._apply(_make_state(tool_calls=[_read_call(f"/tmp/a_{i}.txt")]), runtime)
        act = [{"name": "replace", "id": "call_write", "args": {"path": "x.py", "content": "done"}}]
        mw._apply(_make_state(tool_calls=act), runtime)
        for i in range(7):
            result = mw._apply(_make_state(tool_calls=[_read_call(f"/tmp/b_{i}.txt")]), runtime)
            assert result is None


class TestErrorRepeat:
    def test_fourth_identical_failed_read_blocked(self):
        mw = LoopDetectionMiddleware()
        err_content = "Error: file not found: /tmp/missing.txt"

        for i in range(3):
            call = _read_call("/tmp/missing.txt", call_id=f"call_err_{i}")
            request = _tool_request(call)
            result = mw.wrap_tool_call(request, _handler_returning(_error_tool_message(call, err_content)))
            assert isinstance(result, ToolMessage)
            assert result.status == "error"

        # Fourth identical attempt — blocked before execution.
        call = _read_call("/tmp/missing.txt", call_id="call_err_4")
        request = _tool_request(call)
        executed = {"v": False}

        def handler(_request):
            executed["v"] = True
            return ToolMessage(content="should not run", tool_call_id=call["id"])

        blocked = mw.wrap_tool_call(request, handler)
        assert isinstance(blocked, ToolMessage)
        assert blocked.status == "error"
        assert _ERROR_BLOCK_MSG == blocked.content
        assert not executed["v"]

    def test_different_path_still_executes(self):
        mw = LoopDetectionMiddleware()
        err_content = "Error: file not found: /tmp/missing.txt"

        for i in range(3):
            call = _read_call("/tmp/missing.txt", call_id=f"call_a_{i}")
            mw.wrap_tool_call(_tool_request(call), _handler_returning(_error_tool_message(call, err_content)))

        call = _read_call("/tmp/other.txt", call_id="call_b")
        executed = {"v": False}

        def handler(_request):
            executed["v"] = True
            return ToolMessage(content="data", tool_call_id=call["id"])

        out = mw.wrap_tool_call(_tool_request(call), handler)
        assert executed["v"]
        assert out.content == "data"

    def test_bash_timeout_repeat_blocked(self):
        mw = LoopDetectionMiddleware()
        err_content = "Error: Command timed out after 120 seconds"
        call_tpl = _bash_call("node long_task.js")

        for i in range(3):
            call = dict(call_tpl, id=f"call_t_{i}")
            mw.wrap_tool_call(_tool_request(call), _handler_returning(_error_tool_message(call, err_content)))

        call = dict(call_tpl, id="call_t_4")
        executed = {"v": False}

        def handler(_request):
            executed["v"] = True
            return ToolMessage(content="nope", tool_call_id=call["id"])

        blocked = mw.wrap_tool_call(_tool_request(call), handler)
        assert isinstance(blocked, ToolMessage)
        assert _ERROR_BLOCK_MSG == blocked.content
        assert not executed["v"]

    def test_success_results_not_tracked(self):
        mw = LoopDetectionMiddleware()
        call = _read_call("/tmp/fine.txt")

        for i in range(5):
            request = _tool_request(dict(call, id=f"call_fine_{i}"))
            out = mw.wrap_tool_call(
                request,
                _handler_returning(ToolMessage(content="data", tool_call_id=call["id"])),
            )
            assert out.content == "data"

        # A later error on the same path has no failure history — executes normally.
        err_call = _read_call("/tmp/fine.txt", call_id="call_fine_err")
        executed = {"v": False}

        def handler(_request):
            executed["v"] = True
            return ToolMessage(
                content="Error: file not found: /tmp/fine.txt",
                tool_call_id=err_call["id"],
                status="error",
            )

        out = mw.wrap_tool_call(_tool_request(err_call), handler)
        assert executed["v"]
        assert out.content != _ERROR_BLOCK_MSG


class TestAsyncWrap:
    def test_awrap_tool_call_blocks_after_hard_limit(self):
        mw = LoopDetectionMiddleware()
        runtime = _make_runtime("async-thread")
        call = [_replace_call("a")]

        for _ in range(5):
            mw._apply(_make_state(tool_calls=call), runtime)

        async def go():
            request = _tool_request(call[0], thread_id="async-thread")

            async def handler(_request):
                return ToolMessage(content="ok", tool_call_id=call[0]["id"])

            out = await mw.awrap_tool_call(request, handler)
            assert isinstance(out, ToolMessage)
            assert out.status == "error"
            assert _BLOCK_MSG == out.content

        asyncio.run(go())


class TestSupervisorExemption:
    def test_supervisor_polling_not_flagged(self):
        mw = LoopDetectionMiddleware(warn_threshold=2)
        runtime = _make_runtime()
        call = [
            {
                "name": "supervisor",
                "id": "call_sup",
                "args": {"action": "get_status", "task_id": "t1"},
            }
        ]
        for _ in range(6):
            result = mw._apply(_make_state(tool_calls=call), runtime)
            assert result is None
