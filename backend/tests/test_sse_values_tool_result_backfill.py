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


def test_values_emits_tool_result_when_toolmessage_name_is_missing() -> None:
    """【self-evolution-bot · 2026-11-23 · 第128轮 · 模型:deepseek-v4.1-flash】

    现网形态：ToolMessage 只带 tool_call_id / type，没有 name。
    `_slim_tool_result_message` 会把 name 兜底成字面量 "tool"，而
    `tool_omit_from_chat_panel("tool")` 返回 True（把「未知工具」当内部工具隐藏）
    → 已落库全文的 result 被静默丢弃，V4 卡永久「等待中」+「检索中…」。

    本用例锁的就是这条：名字缺失时必须用 START 登记表补回真名并下发。
    现网复算（20 份 sse-recv）：search_code_index 5 次调用 4 次没下发（80%），
    bash 4% / platform 8% / read 0% —— 缺的就是这条兜底。
    """
    n = UiStreamNormalizer(thread_id="t-name-missing", anchored=False)
    n._on_values({"messages": [{"type": "human", "content": "搜一下"}]})
    n._on_messages(
        {
            "type": "AIMessageChunk",
            "content": "",
            "tool_call_chunks": [
                {"id": "tc-noName", "name": "search_code_index", "args": "{}"}
            ],
        }
    )
    out = n._on_values(
        {
            "messages": [
                {"type": "human", "content": "搜一下"},
                {
                    "type": "ai",
                    "content": "",
                    "tool_calls": [
                        {"id": "tc-noName", "name": "search_code_index", "args": {}}
                    ],
                },
                # ← 关键：没有 name 字段，正是现网丢结果的那个形状
                {
                    "type": "tool",
                    "tool_call_id": "tc-noName",
                    "content": "[index] age=1s\n\nSymbols:\n  - function Foo @ a.py:1",
                },
            ]
        }
    )
    results = [x for x in out if isinstance(x, dict) and x.get("type") == "tool_result"]
    assert len(results) == 1, out
    assert results[0]["tool_call_id"] == "tc-noName"
    # 名字必须补回真名，不能是兜底的 "tool"（否则卡面显示成未知工具）
    assert results[0]["name"] == "search_code_index", results[0]
    assert "Foo" in str(results[0].get("content") or "")


def test_genuinely_hidden_tool_is_still_omitted() -> None:
    """反证：真正的内部工具（todo_write）不许因为这次补名改动而漏到聊天区。

    【self-evolution-bot · 2026-11-23 · 第128轮】补名只解决「名字丢了」，
    不能顺手把 CHAT_PANEL_HIDDEN_TOOL_NAMES 的隐藏语义废掉。
    """
    n = UiStreamNormalizer(thread_id="t-hidden", anchored=False)
    n._on_values({"messages": [{"type": "human", "content": "列个待办"}]})
    n._on_messages(
        {
            "type": "AIMessageChunk",
            "content": "",
            "tool_call_chunks": [
                {"id": "tc-todo", "name": "todo_write", "args": "{}"}
            ],
        }
    )
    out = n._on_values(
        {
            "messages": [
                {"type": "human", "content": "列个待办"},
                {
                    "type": "ai",
                    "content": "",
                    "tool_calls": [{"id": "tc-todo", "name": "todo_write", "args": {}}],
                },
                {
                    "type": "tool",
                    "name": "todo_write",
                    "tool_call_id": "tc-todo",
                    "content": '[{"content":"x","status":"pending"}]',
                },
            ]
        }
    )
    results = [x for x in out if isinstance(x, dict) and x.get("type") == "tool_result"]
    assert results == [], out


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
