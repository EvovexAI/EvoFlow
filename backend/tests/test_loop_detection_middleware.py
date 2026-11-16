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
    _terminal_command_fingerprint,
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

    def test_gate_commands_on_different_tests_dont_share_fingerprint(self):
        """【fullstack-dev · 2026-11-15 · 第12轮】新建。

        真实现场：本岗门禁一律写 ``cd X && PYTHONPATH=… python -m pytest tests/a.py -q``。
        旧逻辑先看末段、再取"前 2 token"兜底，于是 ``tests/a.py`` / ``tests/b.py`` / ``tests/a+b``
        三种**真在跑不同东西**的调用撞成同一指纹，第 3 次起被拦 —— 我本轮被拦 3 次。
        """
        mw = LoopDetectionMiddleware()
        seen = set()
        for cmd in (
            "cd /d/repo/backend && PYTHONPATH=packages/harness:. python -m pytest tests/a.py -q",
            "cd /d/repo/backend && PYTHONPATH=packages/harness:. python -m pytest tests/b.py -q",
            "cd /d/repo/backend && PYTHONPATH=packages/harness:. python -m pytest tests/a.py tests/b.py -q",
            "cd /d/repo && ruff check x.py && cd backend && PYTHONPATH=packages/harness python -m pytest tests/c.py -q",
        ):
            call = _bash_call(cmd, call_id=f"c_{len(seen)}")
            out = mw._check_explore_loops("gate-thread", [call])
            assert out is None, f"{cmd} tripped at #{len(seen)}: {out}"
            seen.add(_terminal_command_fingerprint(call["args"]))
        assert len(seen) == 4, seen

    def test_obs_query_different_sql_do_not_share_fingerprint(self):
        """【fullstack-dev · 2026-11-15 · 第17轮】新建。

        真实现场：本轮我连发两条 ``obs_query.py --sql "…不同查询…"``, 两条都被
        「重复探索·已拦截」挡下 —— 旧指纹只到 ``terminal:python:obs_query.py``，
        flag 值（即「这次到底在算什么」）完全不进键。obs_query.py 是第13轮为
        「别每轮现写 python -c 探针」固化的只读入口，若每个新查询都算重复探索，
        等于固化了个用不了的工具。近 2 天该拦截共 700 次。
        """
        base = (
            "cd /d/dev/github/EvoFlow/backend && "
            "PYTHONPATH=packages/harness:. python packages/harness/scripts/obs_query.py --db obs "
        )
        cmd_a = base + '--sql "SELECT tool_name, count(*) FROM t GROUP BY tool_name"'
        cmd_b = base + '--sql "SELECT substr(input_json,1,100) FROM t WHERE agent_code=\'x\'"'
        cmd_c = base + '--sql "SELECT tool_name, count(*) FROM t GROUP BY tool_name"'  # 与 A 同一条
        fa = _terminal_command_fingerprint({"command": cmd_a})
        fb = _terminal_command_fingerprint({"command": cmd_b})
        fc = _terminal_command_fingerprint({"command": cmd_c})
        assert fa != fb, (fa, fb)
        assert fa == fc, (fa, fc)
        # 不含 payload flag 的调用仍按脚本名归并（不削弱原有检测）
        f_list = _terminal_command_fingerprint(
            {"command": "cd /b && PYTHONPATH=packages/harness:. python scripts/obs_query.py --list-tables"}
        )
        assert f_list == "terminal:python:obs_query.py", f_list

    def test_uv_run_prefix_does_not_collapse_every_script(self):
        """【fullstack-dev · 2026-11-15 · 第17轮】新建。

        真实现场：近 2 天「重复探索·已拦截」共 701 次（release-engineer 486 / 本岗 113），
        最大误拦桶是 ``terminal:uv run python`` —— 同一指纹下塌了 **24 条不同命令**。
        本仓后端门禁惯例是 ``PYTHONPATH=. uv run pytest tests/x.py``，旧逻辑只截到
        ``uv run python`` 三个 token，真正被跑的脚本/测试文件完全不进指纹，
        于是"跑 a 脚本""跑 b 脚本""换文件再跑"三次不同调用撞成同一目标被拦。
        """
        seen = set()
        for cmd in (
            "cd /d/dev/github/EvoFlow/backend && PYTHONPATH=. uv run python scripts/verify_a.py",
            "cd /d/dev/github/EvoFlow/backend && PYTHONPATH=. uv run python scripts/verify_b.py",
            "cd /d/dev/github/EvoFlow/backend && PYTHONPATH=. uv run pytest tests/test_x.py -q",
            "cd /d/dev/github/EvoFlow/backend && PYTHONPATH=. uv run python -m pytest tests/test_y.py -q",
        ):
            fp = _terminal_command_fingerprint({"command": cmd})
            assert fp is not None, cmd
            seen.add(fp)
        assert len(seen) == 4, seen
        # 同一门禁重复跑仍算同一目标（不得因剥前缀而失去检测力）
        again = _terminal_command_fingerprint(
            {"command": "cd /d/dev/github/EvoFlow/backend && PYTHONPATH=. uv run pytest tests/test_x.py -q"}
        )
        assert again in seen, again

    def test_flags_do_not_eat_the_positional_target(self):
        """【fullstack-dev · 2026-11-15 · 第17轮】新建。

        真实现场：obs 近 2 天最大误拦桶 ``terminal:ls -l --time-style=+%h:%m:%s`` = **137 次**，
        全是**不同文件**的目录列举 —— 因为兜底分支把 flags 也算进 ``len(tokens) >= 3`` 预算，
        ``-l`` 与 ``--time-style=…`` 两个 flag 就吃满配额，真正被看的文件**进不了指纹**。
        函数注释写着"flags 一律忽略"，实现却没忽略 —— 注释与实现相反（第12轮那次没修干净）。
        """
        a = _terminal_command_fingerprint({"command": "ls -l --time-style=+%H:%M:%S round6-review.md"})
        b = _terminal_command_fingerprint({"command": "ls -l --time-style=+%H:%M:%S round7-closeout.md"})
        assert a != b, (a, b)
        assert "round6-review.md" in a, a
        # 短横 flag 仍进指纹（bash -n / pytest -q 之类模式位有意义，第12轮已固化为契约）
        assert "bash -n" in _terminal_command_fingerprint({"command": "bash -n scripts/a.sh"}), "flag lost"

    def test_timestamp_tail_does_not_hijack_focus(self):
        """【fullstack-dev · 2026-11-15 · 第17轮】新建。

        真实现场：obs 近 2 天 701 次「重复探索·已拦截」里**最大桶**是
        ``terminal:date +%h:%m:%s`` —— 111 次（16%），9 条完全不同的真目标命令
        （跑 pytest / 跑 obs_query / ruff check …）因为尾巴都接了个 ``; date +%H:%M:%S``
        打点，焦点段被 date 抢走，全部塌进同一个键，第 3 次不同调用即被误拦。
        第12轮已把 echo/printf 当打点跳过，但 ``date`` 漏了 —— 同一缺陷的另一半。
        """
        pytest_cmd = (
            "cd /d/dev/github/EvoFlow/backend && PYTHONPATH=packages/harness:. "
            "python -m pytest tests/test_craft_note_body_dedup.py 2>&1 | tail -3; date +%H:%M:%S"
        )
        obs_cmd = (
            "cd /d/dev/github/EvoFlow && python backend/packages/harness/scripts/obs_query.py "
            "--list-tables 2>&1 | tail -10; date +%H:%M:%S"
        )
        f1 = _terminal_command_fingerprint({"command": pytest_cmd})
        f2 = _terminal_command_fingerprint({"command": obs_cmd})
        assert "date" not in f1, f1
        assert "date" not in f2, f2
        assert f1 != f2, (f1, f2)
        # 同一条命令（含同样的 date 尾巴）重复跑，仍须算同一目标 —— 检测力不得丢
        assert _terminal_command_fingerprint({"command": pytest_cmd}) == f1
        # 整条只查时间时，date 本身就是目标，不能被跳成空指纹
        assert _terminal_command_fingerprint({"command": "date +%H:%M:%S"}) is not None

    def test_payload_tag_does_not_leak_into_non_payload_flags(self):
        """``--db``/``--limit`` 这类选择器不得进指纹：同一查询换个 limit 仍算同一目标。"""
        a = _terminal_command_fingerprint(
            {"command": "cd /b && python scripts/obs_query.py --db obs --limit 80 --sql \"SELECT 1 FROM t\""}
        )
        b = _terminal_command_fingerprint(
            {"command": "cd /b && python scripts/obs_query.py --db obs --limit 20 --sql \"SELECT 1 FROM t\""}
        )
        assert a == b, (a, b)

    def test_echo_tail_does_not_replace_real_focus(self):
        """``bash -n x.sh && echo SH_OK`` 的指纹必须落在 x.sh 上，尾巴 echo 不算"跑的东西"。"""
        a = _terminal_command_fingerprint({"command": "cd /d/repo && bash -n scripts/a.sh && echo SH_OK"})
        b = _terminal_command_fingerprint({"command": "cd /d/repo && bash -n scripts/b.sh && echo SH_OK"})
        assert a == "terminal:bash -n a.sh", a
        assert a != b, (a, b)

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


class TestCompoundCommandFingerprint:
    """【self-evolution-bot · 2026-11-16 · 第21轮】新建：复合命令塌缩的回归护栏。

    真实现场（obs 2026-11-09~16，11573 条被指纹覆盖的 bash）：
    ``_terminal_focus_segment`` 只取**最后一段**实质命令，于是「同一尾巴、不同前缀」的
    复合命令全塌进同一个桶 —— 733 个桶吞了 >=2 条不同命令，其中拦截占全部拦截的 84%。
    最狠的单桶 ``terminal:test -f 1.3.28发版核对结论.md`` 吞 24 条不同命令、被拦 100 次；
    受害最大的是同事：release-engineer 2735 次调用被拦 779 次（28.5%）。

    修法：命令含 >=2 个实质段时追加整条命令链的摘要 ``|d:<8hex>``。
    下面每条断言都成对出现 —— 正向证明「不同命令不再共键」，反向证明「同一命令仍共键」，
    否则放宽判据等于把检测削空（第17轮「随机拦与不拦」那个坑）。
    """

    def test_real_prod_bucket_ruff_two_commands_split(self):
        """现网真实原文（非自造）：旧指纹把这两条塌成同一键，被拦 96 次 / 桶内 7 条不同命令。

        取自 obs 2026-11-09~16 的 ``terminal:python:m:ruff:check:tool_error_handling_middleware.py`` 桶。
        这两条**跑的根本不是一回事**：前者只跑 ruff；后者是完整的「py_compile + ruff」双门禁链。
        旧版（第20轮）两条指纹完全相同 —— 已用 ``git show HEAD:<file>`` 换回旧版跑过，
        本条断言在旧版下**确实红**（不是自造样例那种两版都能过的假证据）。
        """
        only_ruff = (
            'cd /d/dev/github/EvoFlow && python -m ruff check '
            'backend/packages/harness/evoflow/agents/middlewares/tool_error_handling_middleware.py'
            '; echo "RUFF_EXIT=$?"'
        )
        compile_plus_ruff = (
            'cd /d/dev/github/EvoFlow && echo "=== FRESH gates on round-5 file ===" && cd backend '
            '&& python -m py_compile packages/harness/evoflow/agents/middlewares/'
            'tool_error_handling_middleware.py; echo "PYC_EXIT=$?"; '
            'python -m ruff check packages/harness/evoflow/agents/middlewares/'
            'tool_error_handling_middleware.py; echo "RUFF_EXIT=$?"'
        )
        a = _terminal_command_fingerprint({"command": only_ruff})
        b = _terminal_command_fingerprint({"command": compile_plus_ruff})
        assert a != b, (a, b)
        # 反向：各自重复跑仍是各自的目标（检测力不得丢）
        assert _terminal_command_fingerprint({"command": only_ruff}) == a
        assert _terminal_command_fingerprint({"command": compile_plus_ruff}) == b

    def test_real_prod_bucket_release_checklist_split(self):
        """现网最大塌缩桶（被拦 100 次 / 24 条不同命令）的真实原文对。

        两条都是发版核对脚本，尾巴都落在 ``test -f …结论.md``，旧指纹只取末段 → 同键。
        实际跑的东西不同：前者只查 E1~E5，后者多查工作区状态与 E6。
        """
        e1_to_e5 = (
            'cd /d/dev/github/EvoFlow && echo "===E1) 三份说明文件无未提交改动（diff应为空）===" '
            '&& git diff --name-only -- evopanel/CHANGELOG.md scripts/maintainer/update/latest.json '
            '; echo "(空=无回退)" && echo "===E5) 交付文档存在===" '
            '&& test -f docs/roles/release-engineer/20261115-16/1.3.28发版核对结论.md && echo ok'
        )
        e1_to_e6 = (
            'cd /d/dev/github/EvoFlow && echo "===E1) 工作区状态（别的工作流未提交，非我造成）===" '
            '&& git status --porcelain && echo "===E2) 我的三份说明文件无未提交回退===" '
            '&& git diff --name-only -- evopanel/CHANGELOG.md ; echo "(空=无回退)" '
            '&& echo "===E6) 交付文档存在===" '
            '&& test -f docs/roles/release-engineer/20261115-16/1.3.28发版核对结论.md && echo ok'
        )
        a = _terminal_command_fingerprint({"command": e1_to_e5})
        b = _terminal_command_fingerprint({"command": e1_to_e6})
        assert a != b, (a, b)
        assert a.startswith("terminal:test -f 1.3.28"), a
        assert b.startswith("terminal:test -f 1.3.28"), b

    def test_middle_segment_distinguishes(self):
        """中段不同（不是尾巴）也要分开 —— 旧指纹只看末段，中段信息全丢。"""
        a = _terminal_command_fingerprint(
            {"command": "cd /d/repo && git ls-remote origin && cd backend && python -m pytest tests/a.py -q"}
        )
        b = _terminal_command_fingerprint(
            {"command": "cd /d/repo && git status --porcelain && cd backend && python -m pytest tests/a.py -q"}
        )
        assert a != b, (a, b)

    def test_single_substantive_segment_keeps_legacy_fingerprint(self):
        """单实质段命令**不加** ``|d:`` 后缀：与第20轮指纹逐字节一致，零行为漂移。

        cd / echo / printf / date / true 都是噪音段（第12/17轮已固化），
        剥掉后只剩 ``bash -n scripts/a.sh`` 一段 —— 这时补丁必须完全不介入。
        """
        fp = _terminal_command_fingerprint({"command": "cd /d/repo && echo START && bash -n scripts/a.sh"})
        assert "|d:" not in fp, fp
        assert fp == "terminal:bash -n a.sh", fp

    def test_separator_style_does_not_change_fingerprint(self):
        """``&&`` 与 ``;`` 只是写法，跑的是同一串工作 → 必须同一指纹（否则拦与不拦变随机）。"""
        a = _terminal_command_fingerprint(
            {"command": "cd /d/repo && git status --porcelain && git rev-parse HEAD"}
        )
        b = _terminal_command_fingerprint(
            {"command": "cd /d/repo; git status --porcelain; git rev-parse HEAD"}
        )
        assert a == b, (a, b)

    def test_volatile_clock_and_timestamp_normalized(self):
        """同一条命令里嵌了毫秒戳/时刻，不得因此变成"新目标"（否则重跑永远不被拦）。"""
        a = _terminal_command_fingerprint(
            {"command": "cd /d/repo && curl -s http://127.0.0.1:8382/health?t=1700000000000 && git status --porcelain"}
        )
        b = _terminal_command_fingerprint(
            {"command": "cd /d/repo && curl -s http://127.0.0.1:8382/health?t=1799999999999 && git status --porcelain"}
        )
        assert a == b, (a, b)

    def test_repeated_compound_command_still_hard_blocked(self):
        """反向护栏（最重要）：同一复合命令第 5 次照样被拦 —— 补丁不是放宽阈值。"""
        from evoflow.agents.middlewares.loop_detection_middleware import (
            _EXPLORE_BLOCK_MSG,
            _EXPLORE_HARD_THRESHOLD,
        )

        mw = LoopDetectionMiddleware()
        cmd = "cd /d/repo && git status --porcelain && python -m pytest tests/a.py --tb=line 2>&1 | tail -20"
        for i in range(_EXPLORE_HARD_THRESHOLD - 1):
            out = mw._check_explore_loops("cmp-thread", [_bash_call(cmd, call_id=f"cmp_{i}")])
            assert out != _EXPLORE_BLOCK_MSG, f"blocked too early at #{i}"
        blocked = mw._check_explore_loops(
            "cmp-thread", [_bash_call(cmd, call_id=f"cmp_{_EXPLORE_HARD_THRESHOLD}")]
        )
        assert blocked == _EXPLORE_BLOCK_MSG, blocked

    def test_distinct_compound_commands_never_block(self):
        """反向护栏：7 条**真在干不同活**的复合命令，一条都不许被拦。"""
        mw = LoopDetectionMiddleware()
        cmds = [
            "cd /d/repo && git status --porcelain && git rev-parse HEAD",
            "cd /d/repo && git diff --name-only -- a.md && git log --oneline -1",
            "cd /d/repo && test -f b.md && git diff --name-only -- b.md",
            "cd /d/repo && python -m pytest tests/a.py -q && echo OK",
            "cd /d/repo && python -m pytest tests/c.py -q && echo OK",
            "cd /d/repo && ruff check x.py && python -m py_compile y.py",
            "cd /d/repo && grep -n def x.py && grep -c class y.py",
        ]
        for i, cmd in enumerate(cmds):
            out = mw._check_explore_loops("distinct-thread", [_bash_call(cmd, call_id=f"d_{i}")])
            assert out is None, f"#{i} {cmd} → {out}"


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


class TestMutationResetsExploreHistory:
    """【self-evolution-bot · 2026-11-16 · 第20轮】成功写盘后作废探索账本。

    真实现场（obs 2026-11-09~16，1066 次「重复探索·已拦截」）：
      · 302 次（28.3%）发生在一次成功 replace/write 之后的 180s 内；
      · 其中 190 次是 pytest / py_compile / tsc / ruff 验收命令；
      · 被拦最多的单条命令就是 `python -m pytest`（115 次）与 `py_compile`（96 次）。
    判据前提「同一目标 ⇒ 同一内容」在成功写盘后不成立：文件已变，重跑门禁是正确行为。
    下面用那两条真实命令原文复跑，不是自造样例。
    """

    REAL_PYTEST = "cd /d/dev/github/EvoFlow/backend && PYTHONPATH=packages/harness:. python -m pytest"
    REAL_PYCOMPILE = "cd /d/dev/github/EvoFlow/backend && python -m py_compile packages/harness/evoflow/"

    @staticmethod
    def _ok_write(call_id="call_write_ok"):
        """成功落地的 write：非 error、正文不含 ok:false。"""
        return {
            "name": "write",
            "id": call_id,
            "args": {"path": "/tmp/x.py", "content": "print(1)"},
        }

    def _write_request(self, call, thread_id="test-thread"):
        return _tool_request(call, thread_id=thread_id)

    def test_real_pytest_after_successful_write_not_blocked(self):
        """反证：改完代码重跑门禁必须放行 —— 不修的话第 5 次就被拦。"""
        mw = LoopDetectionMiddleware()
        tid = "edit-verify-thread"
        call = _bash_call(self.REAL_PYTEST, call_id="c_pytest")

        # 前 4 次不拦（第 5 次才会触发 HARD）
        for i in range(4):
            out = mw._check_explore_loops(tid, [call])
            assert out != _EXPLORE_BLOCK_MSG, f"第 {i+1} 次就被硬拦了：{out}"

        # 成功写盘一次 → 账本作废
        wcall = self._ok_write()
        req = self._write_request(wcall, thread_id=tid)
        mw.wrap_tool_call(req, _handler_returning(ToolMessage(content="ok", tool_call_id=wcall["id"])))

        # 再跑 4 次同一 pytest：若未重置，累计已到第 8 次，必被拦
        for i in range(4):
            call = _bash_call(self.REAL_PYTEST, call_id=f"c_pytest_after_{i}")
            out = mw._check_explore_loops(tid, [call])
            assert out != _EXPLORE_BLOCK_MSG, f"写盘后第 {i+1} 次重跑门禁被硬拦：{out}"

    def test_real_pycompile_after_successful_replace_not_blocked(self):
        """同上，换 replace + py_compile 那条真实命令。"""
        mw = LoopDetectionMiddleware()
        tid = "edit-verify-pycompile"
        call = _bash_call(self.REAL_PYCOMPILE, call_id="c_pyc")
        for _ in range(4):
            assert mw._check_explore_loops(tid, [call]) != _EXPLORE_BLOCK_MSG

        rcall = {"name": "replace", "id": "call_rep_ok", "args": {"path": "/tmp/x.py"}}
        mw.wrap_tool_call(_tool_request(rcall, thread_id=tid), _handler_returning(ToolMessage(content="ok", tool_call_id="call_rep_ok")))

        for i in range(4):
            call = _bash_call(self.REAL_PYCOMPILE, call_id=f"c_pyc_{i}")
            assert mw._check_explore_loops(tid, [call]) != _EXPLORE_BLOCK_MSG, f"replace 后第 {i+1} 次被拦"

    def test_failed_write_does_not_reset(self):
        """反向：写入失败不得重置 —— 真 thrash 照旧被拦。"""
        mw = LoopDetectionMiddleware()
        tid = "failed-write-thread"
        call = _bash_call(self.REAL_PYTEST, call_id="c_pytest")
        for _ in range(4):
            assert mw._check_explore_loops(tid, [call]) != _EXPLORE_BLOCK_MSG

        # 失败写入（工具层报错）
        fcall = self._ok_write("call_write_fail")
        mw.wrap_tool_call(
            _tool_request(fcall, thread_id=tid),
            _handler_returning(_error_tool_message(fcall, "Error: Permission denied")),
        )

        # 未重置 → 第 5 次必须被拦
        out = mw._check_explore_loops(tid, [_bash_call(self.REAL_PYTEST, call_id="c_pytest5")])
        assert out == _EXPLORE_BLOCK_MSG, f"失败写入不该重置账本，实际：{out}"

    def test_write_with_ok_false_body_does_not_reset(self):
        """反向：工具自报 ok:false（如 String not found）也算没落地。"""
        mw = LoopDetectionMiddleware()
        tid = "ok-false-thread"
        call = _bash_call(self.REAL_PYTEST, call_id="c_pytest")
        for _ in range(4):
            assert mw._check_explore_loops(tid, [call]) != _EXPLORE_BLOCK_MSG

        fcall = {"name": "replace", "id": "call_rep_nf", "args": {"path": "/tmp/x.py"}}
        mw.wrap_tool_call(
            _tool_request(fcall, thread_id=tid),
            _handler_returning(
                ToolMessage(content='{"ok": false, "error": "String not found in file"}', tool_call_id="call_rep_nf")
            ),
        )

        out = mw._check_explore_loops(tid, [_bash_call(self.REAL_PYTEST, call_id="c_pytest5")])
        assert out == _EXPLORE_BLOCK_MSG, f"ok:false 不该重置，实际：{out}"

    def test_non_mutation_tool_does_not_reset(self):
        """反向：读类工具不重置（否则守卫等于没有）。"""
        mw = LoopDetectionMiddleware()
        tid = "read-only-thread"
        call = _bash_call(self.REAL_PYTEST, call_id="c_pytest")
        for _ in range(4):
            assert mw._check_explore_loops(tid, [call]) != _EXPLORE_BLOCK_MSG

        rcall = _read_call("/tmp/x.py", call_id="call_read_ok")
        mw.wrap_tool_call(_tool_request(rcall, thread_id=tid), _handler_returning(ToolMessage(content="file body", tool_call_id="call_read_ok")))

        out = mw._check_explore_loops(tid, [_bash_call(self.REAL_PYTEST, call_id="c_pytest5")])
        assert out == _EXPLORE_BLOCK_MSG, f"读不重置，实际：{out}"

    def test_async_path_also_resets(self):
        """接线：异步钩子 awrap_tool_call 也必须接上。"""
        async def _run():
            mw = LoopDetectionMiddleware()
            tid = "async-thread"
            call = _bash_call(self.REAL_PYTEST, call_id="c_pytest")
            for _ in range(4):
                assert mw._check_explore_loops(tid, [call]) != _EXPLORE_BLOCK_MSG

            wcall = self._ok_write("call_write_async")

            async def handler(_request):
                return ToolMessage(content="ok", tool_call_id=wcall["id"])

            await mw.awrap_tool_call(_tool_request(wcall, thread_id=tid), handler)

            for i in range(4):
                c = _bash_call(self.REAL_PYTEST, call_id=f"c_async_{i}")
                assert mw._check_explore_loops(tid, [c]) != _EXPLORE_BLOCK_MSG, f"异步路径未重置，第 {i+1} 次被拦"

        asyncio.run(_run())
