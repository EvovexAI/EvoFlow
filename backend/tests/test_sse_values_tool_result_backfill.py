"""values 快照补发 tool_result：messages 流丢结果时 V4 不再永久「等待中」。"""

from __future__ import annotations

from app.gateway.sse_ui_normalize import UiStreamNormalizer


def test_values_emits_tool_result_for_started_tool_missing_result() -> None:
    n = UiStreamNormalizer(thread_id="t-values-sci", anchored=True)
    n.emitted_tool_call_ids.add("tc-sci")
    assert "tc-sci" not in n.emitted_tool_result_ids

    out = n._on_values(
        {
            "messages": [
                {"type": "human", "content": "搜一下"},
                {
                    "type": "ai",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "tc-sci",
                            "name": "search_code_index",
                            "args": {"query": "x"},
                        }
                    ],
                },
                {
                    "type": "tool",
                    "name": "search_code_index",
                    "tool_call_id": "tc-sci",
                    "content": "[index] age=1s\n\nSymbols:\n  - function Foo @ a.py:1",
                },
            ]
        }
    )
    results = [x for x in out if isinstance(x, dict) and x.get("type") == "tool_result"]
    assert len(results) == 1, out
    assert results[0]["tool_call_id"] == "tc-sci"
    assert "Foo" in str(results[0].get("content") or "")
    assert "tc-sci" in n.emitted_tool_result_ids

    # 再次 values 不得重复下发
    out2 = n._on_values(
        {
            "messages": [
                {"type": "human", "content": "搜一下"},
                {
                    "type": "tool",
                    "name": "search_code_index",
                    "tool_call_id": "tc-sci",
                    "content": "[index] age=1s\n\nSymbols:\n  - function Foo @ a.py:1",
                },
            ]
        }
    )
    results2 = [x for x in out2 if isinstance(x, dict) and x.get("type") == "tool_result"]
    assert results2 == []


def test_values_skips_tool_result_without_prior_start() -> None:
    """历史 ToolMessage 回放不得造卡（必须先有 emitted START）。"""
    n = UiStreamNormalizer(thread_id="t-values-hist", anchored=True)
    out = n._on_values(
        {
            "messages": [
                {"type": "human", "content": "旧轮"},
                {
                    "type": "tool",
                    "name": "search_code_index",
                    "tool_call_id": "tc-old",
                    "content": "old body",
                },
            ]
        }
    )
    results = [x for x in out if isinstance(x, dict) and x.get("type") == "tool_result"]
    assert results == []
