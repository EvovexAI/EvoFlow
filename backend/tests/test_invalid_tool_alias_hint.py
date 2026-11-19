"""幻觉工具名必须直接告诉调用方该用哪个（2026-11-19 第67轮）。

【self-evolution-bot · 2026-11-19 · 第67轮 · 模型:deepseek-v4.1-flash-1017】

## 现象（现网 obs，近 7 天）

| 工具名 | 次数 | 失败率 | 最后出现 |
|---|---|---|---|
| `read_file` | 24 | **100%** | 2026-11-18 17:43 |
| `edit_file` | 1 | 100% | 2026-11-19 13:12 |
| `edit` | 1 | 100% | 2026-11-15 16:10 |
| `Read` | 1 | 100% | 2026-11-13 10:29 |

模型按通用 agent 的习惯（`read_file` / `edit_file` / `str_replace`）发调用，而本仓
叫 `read` / `replace` / `write`。框架只回一句原文：

    Error: read_file is not a valid tool, try one of [assets, todo_write, tasks, read, ...]

**不带「你其实想用哪个」**，调用方只能从十几个名字里自己猜——每次都是一步白绕。

## 修法

`_HALLUCINATED_TOOL_ALIASES` + `_alias_hint_for_tool()`：命中时错误里直接写
「本仓没有 'read_file'；你大概想用 'read'，直接改用 'read' 再调用一次」。

## 这两条测试怎么才算真守住

- 正向：常见幻觉名必须给出**具体**目标，不能只给清单；
- 反证：**不是**幻觉名（真拼错、随便一个词）不许瞎指路——乱指比不指更糟。
"""

from __future__ import annotations

import pytest

from evoflow.agents.middlewares.invalid_tool_call_middleware import (
    _HALLUCINATED_TOOL_ALIASES,
    _alias_hint_for_tool,
)


@pytest.mark.parametrize(
    ("wrong", "expected"),
    [
        ("read_file", "read"),
        ("Read", "read"),
        ("edit_file", "replace"),
        ("edit", "replace"),
        ("str_replace", "replace"),
        ("write_file", "write"),
        ("search_content", "grep"),
        ("terminal", "bash"),
    ],
)
def test_hallucinated_tool_name_points_at_real_tool(wrong: str, expected: str) -> None:
    """正向：必须写出**具体**目标工具名，而不是罗列清单。"""
    hint = _alias_hint_for_tool(wrong)
    assert hint, f"{wrong} 没有给出任何提示"
    assert expected in hint, f"{wrong} 的提示没指向 {expected}: {hint}"
    # 只给清单等于没修：错误里必须出现"改用 X 再调用"
    assert "再调用" in hint or "改用" in hint, hint


def test_alias_targets_exist_in_alias_table_values() -> None:
    """反证：别名表的值必须是**真实工具名**，不能指向另一个幻觉名。"""
    real = {"read", "replace", "write", "bash", "grep", "fetch_url"}
    bad = {v for v in _HALLUCINATED_TOOL_ALIASES.values() if v not in real}
    assert not bad, f"别名指向了非真实工具: {bad}"


@pytest.mark.parametrize("unknown", ["nonsense_tool_zzz", "", "   ", "totally_made_up"])
def test_unknown_name_gets_no_fake_guidance(unknown: str) -> None:
    """反证：不是幻觉名就不许乱指路（乱指比不指更糟）。"""
    assert _alias_hint_for_tool(unknown) == ""
# 【self-evolution-bot · 2026-11-19 · 第67轮 · 模型:deepseek-v4.1-flash-1017】
# 只测 _alias_hint_for_tool 等于没测：第16轮起我的判据是「声明处 ↔ 使用处 ↔ 落盘输出处
# 数三遍」。上面 13 条只覆盖第 1 处，下面这两条走真正的调用入口，断言最终发给模型的
# ToolMessage.content 里带目标工具名——这才是模型实际看到的那段字。


def _state_with_invalid_call(name: str) -> dict:
    from langchain_core.messages import AIMessage

    ai = AIMessage(
        content="",
        invalid_tool_calls=[
            {"id": "call_x1", "name": name, "args": "{}", "error": f"{name} is not a valid tool"},
        ],
    )
    return {"messages": [ai]}


def _tool_messages_of(state: dict) -> list:
    from evoflow.agents.middlewares.invalid_tool_call_middleware import _process_invalid_tool_calls

    out = _process_invalid_tool_calls(state)
    assert out is not None, "幻觉工具名没有产生任何回执"
    return [m for m in out["messages"] if getattr(m, "type", "") == "tool"]


@pytest.mark.parametrize(("wrong", "expected"), [("read_file", "read"), ("edit_file", "replace")])
def test_middleware_output_actually_carries_target_tool(wrong: str, expected: str) -> None:
    """接线：模型最终收到的 ToolMessage 里必须出现正确工具名。"""
    msgs = _tool_messages_of(_state_with_invalid_call(wrong))
    assert msgs, f"{wrong} 没有生成 ToolMessage"
    body = str(msgs[0].content)
    assert f"'{expected}'" in body, f"回执没告诉模型该改用 {expected}: {body}"
    assert "再调用" in body, f"回执没给下一步动作: {body}"


def test_middleware_output_keeps_plain_error_for_unknown_tool() -> None:
    """反证：不是幻觉名时不许凭空指路，但原错误必须还在。"""
    msgs = _tool_messages_of(_state_with_invalid_call("zzz_made_up_tool"))
    body = str(msgs[0].content)
    assert "zzz_made_up_tool is not a valid tool" in body, body
    assert "你再调用" not in body and "大概想用" not in body, f"对未知工具名瞎指路: {body}"
# ── 以下是第67轮的第二次接线修复：上一版接错了钩子 ────────────────────────
# 上一版 alias hint 只挂在 after_model 的 invalid_tool_calls 分支。取证：现网
# 2026-11-19 13:12:40 `edit_file is not a valid tool, try one of [...]` 出自
# LangGraph ToolNode._validate_tool_call，而「模型发了个不存在的工具名」走的是正常
# tool_calls（不是 invalid_tool_calls），所以那条分支一次都没跑到。
# 真正生效点是 wrap_tool_call。下面的测试**必须走真 ToolNode**，否则又是只测自己那层。


def _toolnode_with_middleware():
    from langchain_core.tools import tool
    from langgraph.prebuilt.tool_node import ToolNode

    from evoflow.agents.middlewares.invalid_tool_call_middleware import (
        InvalidToolCallMiddleware,
    )

    @tool
    def read(query: str) -> str:
        """read"""
        return "ok"

    node = ToolNode([read])
    node._wrap_tool_call = InvalidToolCallMiddleware().wrap_tool_call
    return node


def _runtime():
    from langgraph.prebuilt.tool_node import ToolRuntime

    return ToolRuntime(
        state={},
        context=None,
        config={},
        stream_writer=lambda _e: None,
        tool_call_id="c1",
        store=None,
    )


@pytest.mark.parametrize(("wrong", "expected"), [("edit_file", "replace"), ("read_file", "read")])
def test_toolnode_receipt_is_rewritten_by_middleware(wrong: str, expected: str) -> None:
    """接线（真 ToolNode）：未知工具名的回执必须带出该用的工具名。"""
    node = _toolnode_with_middleware()
    call = {"id": "c1", "name": wrong, "args": {}, "type": "tool_call"}
    res = node._run_one(call, "dict", _runtime())
    body = str(getattr(res, "content", "") or "")
    assert f"'{expected}'" in body, f"ToolNode 回执没被改写: {body}"
    # 旧文案是「try one of [...]」，只给清单不给答案 —— 必须消失
    assert "try one of" not in body, f"仍是旧的清单式报错: {body}"


def test_toolnode_receipt_unchanged_for_unknown_tool() -> None:
    """反证：真·未知名字不许瞎指路，ToolNode 原文必须保留。"""
    node = _toolnode_with_middleware()
    call = {"id": "c2", "name": "zzz_unknown_tool", "args": {}, "type": "tool_call"}
    res = node._run_one(call, "dict", _runtime())
    body = str(getattr(res, "content", "") or "")
    assert "is not a valid tool" in body, f"未知工具名的原文被动了: {body}"
    assert "大概想用" not in body, f"对未知工具名瞎指路: {body}"


def test_toolnode_receipt_unchanged_for_known_tool() -> None:
    """反证：真工具的正常返回绝不能被改写（别为了修这条把正常结果吞了）。"""
    node = _toolnode_with_middleware()
    call = {"id": "c3", "name": "read", "args": {"query": "x"}, "type": "tool_call"}
    res = node._run_one(call, "dict", _runtime())
    assert str(getattr(res, "content", "") or "") == "ok"
