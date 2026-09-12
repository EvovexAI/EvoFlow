from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from evoflow.config.tool_results_config import ToolResultsConfig, set_tool_results_config
from evoflow.context.tool_code_compact import compact_code_light
from evoflow.tools.tool_result_shaper import format_prefetch_snippet, shape_tool_result


def test_compact_code_strips_line_comments():
    src = "// header\n\nfn main() {\n  return 1;\n}\n"
    out = compact_code_light(src)
    assert "//" not in out
    assert "fn main()" in out


def test_shape_small_inline():
    set_tool_results_config(
        ToolResultsConfig(
            shaping_enabled=True,
            use_token_tiers=True,
            tier_small_tokens=10_000,
            tier_medium_tokens=20_000,
            llm_summary_enabled=False,
        )
    )
    body = "ok: small result"
    out = shape_tool_result(body, "grep", "tc1", thread_id="t1")
    assert out == body


def test_shape_medium_truncates_terminal_with_warning():
    set_tool_results_config(
        ToolResultsConfig(
            shaping_enabled=True,
            use_token_tiers=True,
            tier_small_tokens=100,
            tier_medium_tokens=200,
            llm_summary_enabled=False,
        )
    )
    body = "FAILED line\n" * 500
    out = shape_tool_result(body, "terminal", "tc-term", thread_id="t1")
    assert "Warning: truncated output (original token count:" in out
    assert "Total output lines:" in out
    assert "FAILED line" in out
    assert len(out) < len(body)


def test_shape_medium_returns_full_body_when_under_medium_cap():
    set_tool_results_config(
        ToolResultsConfig(
            shaping_enabled=True,
            use_token_tiers=True,
            tier_small_tokens=100,
            tier_medium_tokens=10_000,
            threshold_chars=50_000,
            llm_summary_enabled=True,
        )
    )
    body = "line\n" * 400
    out = shape_tool_result(body, "grep", "tc2", thread_id="t1")
    assert out == body
    assert "[tool:summary]" not in out


def test_shape_partial_read_skips_persist():
    set_tool_results_config(
        ToolResultsConfig(
            shaping_enabled=True,
            use_token_tiers=True,
            tier_small_tokens=100,
            tier_medium_tokens=500,
            threshold_chars=50_000,
            llm_summary_enabled=False,
        )
    )
    body = "x" * 20_000
    out = shape_tool_result(body, "read_file", "tc-partial", thread_id="t1", partial_read=True)
    assert "[ToolResult persisted" not in out
    assert "x" * 100 in out


def test_shape_medium_non_whitelist_no_tool_summary_tag():
    set_tool_results_config(
        ToolResultsConfig(
            shaping_enabled=True,
            use_token_tiers=True,
            tier_small_tokens=100,
            tier_medium_tokens=10_000,
            llm_summary_enabled=True,
            llm_summary_tool_names=["search_code_index"],
        )
    )
    body = "line\n" * 400
    out = shape_tool_result(body, "read_file", "tc3", thread_id="t1")
    assert out == body
    assert "[tool:summary]" not in out


def test_format_prefetch_uses_warning_when_shaping_on():
    set_tool_results_config(
        ToolResultsConfig(
            shaping_enabled=True,
            use_token_tiers=True,
            tier_small_tokens=800,
            tier_medium_tokens=200,
            code_compact_enabled=False,
        )
    )
    lines = [f"line {i}" for i in range(200)]
    body = "\n".join(lines)
    out = format_prefetch_snippet("/src/a.py", body)
    assert "Warning: truncated output (original token count:" in out
    assert "--- /src/a.py ---" in out
    assert "line 0" in out


def test_format_prefetch_plain_header_when_shaping_off():
    import os

    prev = os.environ.get("EVOFLOW_TOOL_RESULT_SHAPING")
    os.environ["EVOFLOW_TOOL_RESULT_SHAPING"] = "0"
    try:
        set_tool_results_config(ToolResultsConfig(shaping_enabled=True))
        lines = [f"line {i}" for i in range(200)]
        body = "\n".join(lines)
        out = format_prefetch_snippet("/src/a.py", body)
        assert "Warning: truncated output" not in out
        assert "--- /src/a.py ---" in out
        assert "line 0" in out
    finally:
        if prev is None:
            os.environ.pop("EVOFLOW_TOOL_RESULT_SHAPING", None)
        else:
            os.environ["EVOFLOW_TOOL_RESULT_SHAPING"] = prev


def test_history_ager_single_cold_tool_gets_summary_when_compression_on():
    from evoflow.agents.middlewares.tool_history_ager_middleware import apply_tool_history_fast

    set_tool_results_config(
        ToolResultsConfig(
            enabled=True,
            shaping_enabled=True,
            history_summarize_enabled=True,
            history_merge_enabled=True,
            history_merge_min_tools=2,
            history_merge_min_tokens=999_999,
            history_background_llm=False,
            history_keep_full_tools=1,
            history_tail_token_budget=50_000,
            llm_summary_enabled=False,
        )
    )
    big = "x" * 5000
    messages = [
        HumanMessage(content="hi"),
        AIMessage(content="", tool_calls=[{"id": "a1", "name": "grep", "args": {}}]),
        ToolMessage(content=big, tool_call_id="a1", name="grep"),
        AIMessage(content="", tool_calls=[{"id": "a2", "name": "grep", "args": {}}]),
        ToolMessage(content=big, tool_call_id="a2", name="grep"),
    ]
    aged, jobs = apply_tool_history_fast(messages, thread_id="thread-1")
    assert aged is not None
    assert "[tool:summary]" in aged[2].content
    assert aged[-1].content == big
    assert jobs == []


def test_shape_list_agents_keeps_full_body():
    set_tool_results_config(
        ToolResultsConfig(
            shaping_enabled=True,
            use_token_tiers=True,
            tier_small_tokens=100,
            tier_medium_tokens=500,
            threshold_chars=50_000,
            medium_threshold_chars=8_000,
            llm_summary_enabled=True,
        )
    )
    body = '{"agents": [' + ",".join(f'{{"id":"a{i}"}}' for i in range(200)) + "]}"
    out = shape_tool_result(body, "list_agents", "tc-agents", thread_id="t1")
    assert out == body
    assert "[ToolResult summary" not in out
    assert "[tool:summary]" not in out


def test_shape_worker_preserves_code_reads_inline():
    set_tool_results_config(
        ToolResultsConfig(
            shaping_enabled=True,
            use_token_tiers=True,
            tier_small_tokens=100,
            tier_medium_tokens=500,
            threshold_chars=50_000,
            llm_summary_enabled=False,
        )
    )
    reads = (
        "<worker_code_reads>\n"
        "[tool:summary] tool=read_file\npath: src/a.py\ncore: alpha\n"
        "</worker_code_reads>"
    )
    body = reads + "\n\n" + ("catalog line\n" * 400)
    out = shape_tool_result(body, "worker", "tc-worker", thread_id="t1")
    assert "path: src/a.py" in out
    assert "core: alpha" in out
    assert "catalog line" in out
    assert "[ToolResult persisted" not in out


def test_shape_search_code_index_preserves_post_search_reads_inline():
    set_tool_results_config(
        ToolResultsConfig(
            shaping_enabled=True,
            use_token_tiers=True,
            tier_small_tokens=100,
            tier_medium_tokens=10_000,
            threshold_chars=50_000,
            llm_summary_enabled=True,
        )
    )
    reads = (
        "<post_search_reads offset=0 limit=2>\n"
        "[tool:summary] tool=read_file\npath: src/b.py\ncore: beta\n"
        "</post_search_reads>"
    )
    body = reads + "\n\n" + ("hit line\n" * 400)
    out = shape_tool_result(body, "search_code_index", "tc-search", thread_id="t1")
    assert "path: src/b.py" in out
    assert "core: beta" in out
    assert "hit line" in out
    assert "[ToolResult persisted" not in out


def test_shape_read_file_keeps_full_body_below_large_threshold():
    set_tool_results_config(
        ToolResultsConfig(
            shaping_enabled=True,
            use_token_tiers=True,
            tier_small_tokens=800,
            tier_medium_tokens=3000,
            threshold_chars=50_000,
            medium_threshold_chars=8_000,
            llm_summary_enabled=False,
        )
    )
    body = "x" * 12_405
    out = shape_tool_result(body, "read_file", "tc-read", thread_id="t1")
    assert out == body
    assert "[ToolResult summary" not in out


def test_load_tool_results_config_respects_runtime_flags():
    from evoflow.config.tool_results_config import (
        get_tool_results_config,
        load_tool_results_config_from_dict,
        tool_result_compression_active,
        tool_result_shaping_active,
    )

    load_tool_results_config_from_dict(
        {
            "shaping_enabled": True,
            "enabled": True,
            "history_summarize_enabled": True,
            "history_merge_enabled": True,
            "llm_summary_enabled": True,
            "code_compact_enabled": True,
        }
    )
    cfg = get_tool_results_config()
    assert cfg.enabled is True
    assert cfg.shaping_enabled is True
    assert tool_result_shaping_active() is True
    assert tool_result_compression_active() is True
