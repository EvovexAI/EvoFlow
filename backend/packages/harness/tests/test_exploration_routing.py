"""Tests for exploration task routing and budgets."""

from __future__ import annotations

from evoflow.exploration.exploration_budget import (
    check_tool_budget,
    clear_exploration_budget,
    is_unbounded_recurse_command,
    maybe_reset_exploration_budget_on_turn,
    record_tool_attempt,
    score_search_output,
)
from evoflow.exploration.task_router import (
    classify_task_type_heuristic,
    looks_like_filename_query,
    suggest_find_file_message,
)


def test_looks_like_filename_query():
    assert looks_like_filename_query("agent-trace.html")
    assert looks_like_filename_query("*agent-trace*")
    assert not looks_like_filename_query("path:evopanel FeishuChannel")
    assert not looks_like_filename_query("FeishuChannel|lark")
    assert not looks_like_filename_query(
        "backend/packages/harness/evoflow/observability/queries.py _summarize_response_for_list"
    )
    assert not looks_like_filename_query("fetchObsModels obs-api obs-api.ts")


def test_classify_task_type_data_bug():
    assert classify_task_type_heuristic("agent-trace 表格显示数据有问题") == "data_bug"


def test_classify_task_type_locate_file():
    assert classify_task_type_heuristic("agent-trace.html 在哪") == "locate_file"


def test_suggest_find_file_message():
    msg = suggest_find_file_message("agent-trace.html")
    assert "find(pattern=" in msg
    assert "agent-trace.html" in msg


def test_search_budget_blocks_filename_query():
    clear_exploration_budget("t-budget")
    err = check_tool_budget("t-budget", "search_code_index", {"query": "agent-trace.html"})
    assert err is not None
    assert "find(pattern=" in err


def test_low_signal_search_triggers_budget():
    clear_exploration_budget("t-low")
    noisy = "Symbols:\n  - function agent_client @ backend/tests/x.py:1\n\nContent:\n  - README.md: agent"
    for q in ("agent-trace.html", "trace-panel.html", "settings-panel.html"):
        record_tool_attempt(
            "t-low",
            tool_name="search_code_index",
            tool_input={"query": q},
            output_text=noisy,
        )
    err = check_tool_budget("t-low", "search_code_index", {"query": "agent-trace.html"})
    assert err is not None
    assert "low-signal" in err.lower() or "Switch strategy" in err or "find" in err


def test_path_scoped_search_not_low_signal():
    out = score_search_output(
        "Symbols:\n  - function agent_client @ backend/tests/x.py:1\n\nContent:\n  - README.md: agent",
        "path:packages/content-catalog topic",
    )
    assert out == "ok"


def test_score_search_output_low_signal_for_filename_miss():
    out = score_search_output(
        "Symbols:\n  - function agent_client @ backend/tests/x.py:1",
        "agent-trace.html",
    )
    assert out == "low_signal"


def test_find_no_match_does_not_count_toward_budget():
    clear_exploration_budget("t-find-miss")
    for i in range(10):
        record_tool_attempt(
            "t-find-miss",
            tool_name="find",
            tool_input={"pattern": f"*miss{i}*", "root": "packages"},
            output_text="No files matching pattern '*miss0*' under packages.",
        )
    err = check_tool_budget("t-find-miss", "find", {"pattern": "*new*", "root": "packages"})
    assert err is None


def test_find_duplicate_pattern_blocked():
    clear_exploration_budget("t-find-dup")
    record_tool_attempt(
        "t-find-dup",
        tool_name="find",
        tool_input={"pattern": "*topic*", "root": "packages/content-catalog"},
        output_text="Found 2 file(s) matching '*topic*' under packages/content-catalog:\n\n  [0] a.ts",
    )
    err = check_tool_budget(
        "t-find-dup",
        "find",
        {"pattern": "*topic*", "root": "packages/content-catalog"},
    )
    assert err is not None
    assert "already tried" in err.lower()


def test_rg_not_turn_limited():
    clear_exploration_budget("t-rg")
    for i in range(20):
        record_tool_attempt("t-rg", tool_name="rg", tool_input={"pattern": f"foo{i}"}, output_text="(no matches)")
    err = check_tool_budget("t-rg", "rg", {"pattern": "foo99"})
    assert err is None


def test_reset_exploration_budget_on_new_human_turn():
    clear_exploration_budget("t-turn")
    maybe_reset_exploration_budget_on_turn("t-turn", "turn-1")
    for i in range(20):
        record_tool_attempt(
            "t-turn",
            tool_name="find",
            tool_input={"pattern": f"*hit{i}*", "root": "src"},
            output_text=f"Found 1 file(s) matching '*hit{i}*' under src:\n\n  [0] f{i}.ts",
        )
    err = check_tool_budget("t-turn", "find", {"pattern": "*fresh*", "root": "src"})
    assert err is None
    maybe_reset_exploration_budget_on_turn("t-turn", "turn-2")
    err2 = check_tool_budget("t-turn", "find", {"pattern": "*after-reset*", "root": "src"})
    assert err2 is None


def test_classify_ui_layout_as_implement():
    assert classify_task_type_heuristic("把 Requests 筛选栏合并成一行") == "implement"
    assert classify_task_type_heuristic("改一下页面布局") == "implement"


def test_unbounded_recurse_does_not_cross_powershell_segments():
    cmd = (
        'Remove-Item -Recurse -Force "D:\\dev\\coding\\video-douyin\\outputs\\_lint_all"; '
        'Get-ChildItem "D:\\dev\\coding\\video-douyin\\outputs\\compositions" | Select-Object Name, Length'
    )
    assert is_unbounded_recurse_command(cmd) is False


def test_unbounded_recurse_still_blocks_bare_get_childitem_recurse():
    assert is_unbounded_recurse_command("Get-ChildItem -Recurse -Filter *.tsx") is True
    assert is_unbounded_recurse_command("Get-ChildItem -Path C:\\repo -Recurse") is False
