"""LoopDetectionMiddleware -- block duplicates, keep run alive."""

from __future__ import annotations

from types import SimpleNamespace

from langchain_core.messages import AIMessage, ToolMessage

from evoflow.agents.middlewares.loop_detection_middleware import (
    _BLOCK_MSG,
    _EXPLORE_BLOCK_MSG,
    _EXPLORE_WARNING_MSG,
    _explore_loop_fingerprint,
    _terminal_command_fingerprint,
    LoopDetectionMiddleware,
)


def _runtime(tid: str = "t-loop") -> SimpleNamespace:
    return SimpleNamespace(context={"thread_id": tid})


def _ai_tool(name: str, args: dict, call_id: str = "c1"):
    from langchain_core.messages import AIMessage

    return AIMessage(
        content="",
        tool_calls=[{"name": name, "args": args, "id": call_id}],
    )


def test_list_dir_repeat_not_blocked_when_explore_loop_disabled() -> None:
    mw = LoopDetectionMiddleware()
    runtime = _runtime("t-explore")
    state: dict = {"messages": []}
    args = {"path": r"D:\repo"}

    for i in range(6):
        state["messages"] = [_ai_tool("list_dir", args, call_id=f"c{i}")]
        msg = mw._track_and_check(state, runtime)  # type: ignore[arg-type]
        assert msg != _EXPLORE_BLOCK_MSG

    blocked = mw._maybe_block_tool(
        SimpleNamespace(
            tool_call={"name": "list_dir", "args": args, "id": "c5"},
            runtime=runtime,
        )
    )  # type: ignore[arg-type]
    assert blocked is None


def test_list_dir_same_path_different_depth_not_same_fingerprint() -> None:
    mw = LoopDetectionMiddleware()
    runtime = _runtime("t-depth")
    state: dict = {"messages": []}
    path = r"D:\github\EvoFlow"

    for depth in (1, 2, 3):
        state["messages"] = [_ai_tool("list_dir", {"path": path, "depth": depth}, call_id=f"c{depth}")]
        msg = mw._track_and_check(state, runtime)  # type: ignore[arg-type]
        assert msg != _EXPLORE_BLOCK_MSG

    # ``ls`` alias + new depth ? not the same fingerprint as prior list_dir calls
    state["messages"] = [_ai_tool("ls", {"path": path, "depth": 4}, call_id="c-ls")]
    msg = mw._track_and_check(state, runtime)  # type: ignore[arg-type]
    assert msg != _EXPLORE_BLOCK_MSG


def test_list_dir_same_path_depth_not_blocked_when_explore_loop_disabled() -> None:
    mw = LoopDetectionMiddleware()
    runtime = _runtime("t-same-depth")
    state: dict = {"messages": []}
    args = {"path": r"D:\repo", "depth": 2}

    for i in range(6):
        state["messages"] = [_ai_tool("list_dir", args, call_id=f"c{i}")]
        msg = mw._track_and_check(state, runtime)  # type: ignore[arg-type]
        assert msg != _EXPLORE_BLOCK_MSG

    blocked = mw._maybe_block_tool(
        SimpleNamespace(tool_call={"name": "list_dir", "args": args, "id": "c5"}, runtime=runtime)
    )  # type: ignore[arg-type]
    assert blocked is None


def test_terminal_repeat_not_blocked_when_explore_loop_disabled() -> None:
    mw = LoopDetectionMiddleware()
    runtime = _runtime("t-terminal")
    state: dict = {"messages": []}
    args = {"command": 'echo "Smoke test 1: Basic echo"'}

    msgs: list[str | None] = []
    for i in range(6):
        state["messages"] = [_ai_tool("terminal", args, call_id=f"c{i}")]
        msgs.append(mw._track_and_check(state, runtime))  # type: ignore[arg-type]

    assert _EXPLORE_WARNING_MSG not in msgs
    assert _EXPLORE_BLOCK_MSG not in msgs
    blocked = mw._maybe_block_tool(
        SimpleNamespace(tool_call={"name": "terminal", "args": args, "id": "c5"}, runtime=runtime)
    )  # type: ignore[arg-type]
    assert blocked is None


def test_global_hard_limit_blocks_batch_without_ending_run() -> None:
    mw = LoopDetectionMiddleware(warn_threshold=2, hard_limit=3)
    runtime = _runtime("t-global")
    state: dict = {"messages": []}
    args = {"command": "echo loop"}

    for i in range(2):
        state["messages"] = [_ai_tool("bash", args, call_id=f"c{i}")]
        mw._track_and_check(state, runtime)  # type: ignore[arg-type]

    state["messages"] = [_ai_tool("bash", args, call_id="c2")]
    msg = mw._track_and_check(state, runtime)  # type: ignore[arg-type]
    assert msg == _BLOCK_MSG

    req = SimpleNamespace(
        tool_call={"name": "bash", "args": args, "id": "c2"},
        runtime=runtime,
    )
    blocked = mw._maybe_block_tool(req)  # type: ignore[arg-type]
    assert blocked is not None
    assert blocked.status == "error"


def test_read_file_error_repeat_is_not_blocked() -> None:
    mw = LoopDetectionMiddleware()
    runtime = _runtime("t-read-err")
    path = r"D:\other\project\secret.txt"
    req = SimpleNamespace(
        tool_call={"name": "read_file", "args": {"path": path}, "id": "c-read"},
        runtime=runtime,
    )

    for _ in range(5):
        mw._track_tool_result_errors(
            req,  # type: ignore[arg-type]
            ToolMessage(
                content=f"Error: Permission denied reading file: {path}",
                tool_call_id="c-read",
                name="read_file",
                status="error",
            ),
        )

    blocked = mw._maybe_block_error_repeat(req)  # type: ignore[arg-type]
    assert blocked is None


def test_cd_node_different_scripts_have_distinct_fingerprints() -> None:
    topic_list = {
        "command": (
            "cd D:/dev/github/ContentOS; "
            "node skills/contentos-topic-research/scripts/mcp-call.js topic_list '{}'"
        )
    }
    search = {
        "command": (
            "cd D:/dev/github/ContentOS; "
            'node skills/contentos-topic-research/scripts/search.js '
            '"{\\"keyword\\":\\"AI\\",\\"limit\\":10}"'
        )
    }
    topic_create = {
        "command": (
            "cd D:/dev/github/ContentOS; "
            "node skills/contentos-topic-research/scripts/mcp-call.js topic_create "
            '"{\\"title\\":\\"x\\"}"'
        )
    }
    fp_list = _terminal_command_fingerprint(topic_list)
    fp_search = _terminal_command_fingerprint(search)
    fp_create = _terminal_command_fingerprint(topic_create)
    assert fp_list == "terminal:node:mcp-call.js:topic_list"
    assert fp_search == "terminal:node:search.js"
    assert fp_create == "terminal:node:mcp-call.js:topic_create"
    assert len({fp_list, fp_search, fp_create}) == 3


def test_read_offset_micro_nudge_shares_fingerprint() -> None:
    path = r"D:/dev/github/EvoFlow/evopanel/src/react/hooks/useSessionList.ts"
    fp_a = _explore_loop_fingerprint(
        {"name": "read", "args": {"path": path, "offset": 130, "limit": 30}}
    )
    fp_b = _explore_loop_fingerprint(
        {"name": "read", "args": {"path": path, "offset": 132, "limit": 20}}
    )
    fp_far = _explore_loop_fingerprint(
        {"name": "read", "args": {"path": path, "offset": 515, "limit": 50}}
    )
    assert fp_a == fp_b
    assert fp_a != fp_far


def test_rg_ignores_context_jitter_in_fingerprint() -> None:
    path = r"D:/dev/github/EvoFlow/evopanel/src/react/hooks/useSessionList.ts"
    fp_a = _explore_loop_fingerprint(
        {
            "name": "rg",
            "args": {
                "path": path,
                "pattern": r"return \{",
                "context_before": 10,
                "context_after": 30,
                "max_results": 5,
            },
        }
    )
    fp_b = _explore_loop_fingerprint(
        {
            "name": "rg",
            "args": {
                "path": path,
                "pattern": r"return \{",
                "context_before": 5,
                "context_after": 20,
                "max_results": 10,
            },
        }
    )
    assert fp_a == fp_b


def test_read_rg_thrash_not_blocked_when_explore_loop_disabled() -> None:
    """Repeated read+rg on same file/pattern must not hard-block when explore loop is off."""
    mw = LoopDetectionMiddleware()
    runtime = _runtime("t-adding-refresh")
    state: dict = {"messages": []}
    path = r"D:/dev/github/EvoFlow/evopanel/src/react/hooks/useSessionList.ts"

    for i in range(6):
        offset = 130 + (i % 2)
        state["messages"] = [
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "read",
                        "args": {"path": path, "offset": offset, "limit": 30},
                        "id": f"r{i}",
                    },
                    {
                        "name": "rg",
                        "args": {
                            "path": path,
                            "pattern": r"return \{",
                            "context_before": 5 + i,
                            "max_results": 5,
                        },
                        "id": f"g{i}",
                    },
                ],
            )
        ]
        msg = mw._track_and_check(state, runtime)  # type: ignore[arg-type]
        assert msg != _EXPLORE_BLOCK_MSG

    state["messages"] = [
        AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "read",
                    "args": {"path": path, "offset": 132, "limit": 20},
                    "id": "r6",
                },
                {
                    "name": "rg",
                    "args": {"path": path, "pattern": r"return \{", "max_results": 5},
                    "id": "g6",
                },
                {
                    "name": "replace",
                    "args": {"path": path, "old_string": "a", "new_string": "b"},
                    "id": "w6",
                },
            ],
        )
    ]
    msg = mw._track_and_check(state, runtime)  # type: ignore[arg-type]
    assert msg != _EXPLORE_BLOCK_MSG

    for call_id, name, args in [
        ("r6", "read", {"path": path, "offset": 132, "limit": 20}),
        ("g6", "rg", {"path": path, "pattern": r"return \{", "max_results": 5}),
        ("w6", "replace", {"path": path, "old_string": "a", "new_string": "b"}),
    ]:
        assert (
            mw._maybe_block_tool(
                SimpleNamespace(
                    tool_call={"name": name, "args": args, "id": call_id},
                    runtime=runtime,
                )
            )  # type: ignore[arg-type]
            is None
        )


def test_mixed_batch_blocks_only_offender_terminal_not_write() -> None:
    """Regression: coarse cd+node fingerprints used to block sibling write/knowledge."""
    mw = LoopDetectionMiddleware()
    runtime = _runtime("t-mixed-collateral")
    state: dict = {"messages": []}

    search_cmd = (
        "cd D:/dev/github/ContentOS; "
        'node skills/contentos-topic-research/scripts/search.js '
        '"{\\"keyword\\":\\"AI\\",\\"limit\\":10}"'
    )
    # Seed 4 search.js terminals via mixed batches (explore-only batches skip checks).
    for i in range(4):
        state["messages"] = [
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "knowledge",
                        "args": {"action": "search", "query": f"q{i}"},
                        "id": f"k{i}",
                    },
                    {
                        "name": "terminal",
                        "args": {"command": search_cmd},
                        "id": f"t{i}",
                    },
                ],
            )
        ]
        mw._track_and_check(state, runtime)  # type: ignore[arg-type]

    write_path = r"C:\Users\admin\.evoflow\outputs\????.md"
    topic_create_cmd = (
        "cd D:/dev/github/ContentOS; "
        "node skills/contentos-topic-research/scripts/mcp-call.js topic_create "
        '"{\\"title\\":\\"demo\\"}"'
    )
    # 5th search.js in a batch with write + different terminal should:
    # - block only the search.js offender
    # - allow write and topic_create to run
    state["messages"] = [
        AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "write",
                    "args": {"path": write_path, "content": "hello"},
                    "id": "w1",
                },
                {
                    "name": "terminal",
                    "args": {"command": search_cmd},
                    "id": "t-search-5",
                },
                {
                    "name": "terminal",
                    "args": {"command": topic_create_cmd},
                    "id": "t-create-1",
                },
            ],
        )
    ]
    msg = mw._track_and_check(state, runtime)  # type: ignore[arg-type]
    assert msg != _EXPLORE_BLOCK_MSG

    blocked_search = mw._maybe_block_tool(
        SimpleNamespace(
            tool_call={"name": "terminal", "args": {"command": search_cmd}, "id": "t-search-5"},
            runtime=runtime,
        )
    )  # type: ignore[arg-type]
    assert blocked_search is None

    assert (
        mw._maybe_block_tool(
            SimpleNamespace(
                tool_call={"name": "write", "args": {"path": write_path, "content": "hello"}, "id": "w1"},
                runtime=runtime,
            )
        )  # type: ignore[arg-type]
        is None
    )
    assert (
        mw._maybe_block_tool(
            SimpleNamespace(
                tool_call={
                    "name": "terminal",
                    "args": {"command": topic_create_cmd},
                    "id": "t-create-1",
                },
                runtime=runtime,
            )
        )  # type: ignore[arg-type]
        is None
    )

def test_explore_streak_disabled_no_warn() -> None:
    from evoflow.agents.middlewares.loop_detection_middleware import (
        _EXPLORE_STREAK_BLOCK_MSG,
        _EXPLORE_STREAK_WARN_MSG,
    )

    mw = LoopDetectionMiddleware()
    runtime = _runtime("t-streak")
    state: dict = {"messages": []}
    msgs: list[str | None] = []
    for i in range(10):
        state["messages"] = [_ai_tool("read", {"path": f"src/file_{i}.ts"}, call_id=f"r{i}")]
        msgs.append(mw._track_and_check(state, runtime))  # type: ignore[arg-type]

    assert _EXPLORE_STREAK_WARN_MSG not in msgs
    assert _EXPLORE_STREAK_BLOCK_MSG not in msgs

    blocked = mw._maybe_block_tool(
        SimpleNamespace(
            tool_call={"name": "read", "args": {"path": "src/file_9.ts"}, "id": "r9"},
            runtime=runtime,
        )
    )  # type: ignore[arg-type]
    assert blocked is None


def test_search_tools_never_blocked_by_explore_streak() -> None:
    from evoflow.agents.middlewares.loop_detection_middleware import (
        _EXPLORE_STREAK_BLOCK_MSG,
        _EXPLORE_STREAK_WARN_MSG,
    )

    mw = LoopDetectionMiddleware()
    runtime = _runtime("t-search-streak")
    state: dict = {"messages": []}
    msgs: list[str | None] = []
    for i in range(12):
        state["messages"] = [
            _ai_tool("rg", {"pattern": f"pattern_{i}", "path": "backend/packages/harness/evoflow"}, call_id=f"g{i}")
        ]
        msgs.append(mw._track_and_check(state, runtime))  # type: ignore[arg-type]

    assert _EXPLORE_STREAK_WARN_MSG not in msgs
    assert _EXPLORE_STREAK_BLOCK_MSG not in msgs
    blocked = mw._maybe_block_tool(
        SimpleNamespace(
            tool_call={
                "name": "rg",
                "args": {"pattern": "pattern_11", "path": "backend/packages/harness/evoflow"},
                "id": "g11",
            },
            runtime=runtime,
        )
    )  # type: ignore[arg-type]
    assert blocked is None


def test_rg_repeat_not_warned_when_explore_loop_disabled() -> None:
    mw = LoopDetectionMiddleware()
    runtime = _runtime("t-rg-repeat")
    state: dict = {"messages": []}
    args = {"pattern": "LoopDetectionMiddleware", "path": "backend/packages/harness/evoflow"}

    msgs: list[str | None] = []
    for i in range(6):
        state["messages"] = [_ai_tool("rg", args, call_id=f"g{i}")]
        msgs.append(mw._track_and_check(state, runtime))  # type: ignore[arg-type]

    assert _EXPLORE_WARNING_MSG not in msgs
    assert _EXPLORE_BLOCK_MSG not in msgs
    blocked = mw._maybe_block_tool(
        SimpleNamespace(tool_call={"name": "rg", "args": args, "id": "g5"}, runtime=runtime)
    )  # type: ignore[arg-type]
    assert blocked is None


def test_explore_streak_resets_on_replace() -> None:
    from evoflow.agents.middlewares.loop_detection_middleware import _EXPLORE_STREAK_WARN_MSG

    mw = LoopDetectionMiddleware()
    runtime = _runtime("t-streak-reset")
    state: dict = {"messages": []}
    for i in range(7):
        state["messages"] = [_ai_tool("read", {"path": f"src/a_{i}.ts"}, call_id=f"g{i}")]
        mw._track_and_check(state, runtime)  # type: ignore[arg-type]

    state["messages"] = [_ai_tool("replace", {"path": "src/a.ts", "old_string": "a", "new_string": "b"}, call_id="w1")]
    assert mw._track_and_check(state, runtime) is None  # type: ignore[arg-type]

    # Streak reset ?? four more explores should not yet warn (warn at 5).
    msgs: list[str | None] = []
    for i in range(7):
        state["messages"] = [_ai_tool("read", {"path": f"src/z_{i}.ts"}, call_id=f"z{i}")]
        msgs.append(mw._track_and_check(state, runtime))  # type: ignore[arg-type]
    assert _EXPLORE_STREAK_WARN_MSG not in msgs
