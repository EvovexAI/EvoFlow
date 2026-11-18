"""自定义 args_schema 不得切断运行时参数注入（第57轮修复契约）。

【为什么有这份测试】第54轮为了接住模型放在工具顶层的 `title`/`notes`，给 `platform`
加了 `_PlatformArgsSchema`。但 langchain 只在 **args_schema 的注解里**看到
`InjectedToolCallId` 时才注入 tool_call_id（见 langchain_core.tools.base 的
`get_all_basemodel_annotations(input_args)` 分支）。schema 里没登记 →
`platform_tool() missing 1 required positional argument: 'tool_call_id'`
—— 工具**完全不可用**，而 py_compile 和既有 7 条测试全绿（它们都直接调 `.func`
并手动传 tool_call_id，正好绕开了真实注入路径）。

现网原件（2026-11-18 重启后实测 2 次）：
    Error: Tool 'platform' failed with TypeError:
    platform_tool() missing 1 required positional argument: 'tool_call_id'

本测试的正向断言必须走 **真实 ToolCall 形式**（`platform_tool.invoke`），
不能调 `.func` —— 否则等于自己把注入参数补上，永远测不到断链。
"""

from __future__ import annotations

import json

from evoflow.tools.builtins.platform_tool import platform_tool


def _invoke_via_toolcall(args: dict, call_id: str = "call_probe_1") -> str:
    """走真实 ToolCall 形式：tool_call_id 由 langchain 从消息体注入。"""
    out = platform_tool.invoke(
        {"name": "platform", "args": args, "type": "tool_call", "id": call_id}
    )
    # StructuredTool.invoke 返回 ToolMessage，正文在 .content
    return out.content if hasattr(out, "content") else str(out)


def test_tool_call_id_is_registered_in_args_schema() -> None:
    """正向断言：注入参数必须出现在 args_schema 里，否则注入链断开。"""
    fields = set(platform_tool.args_schema.model_fields)
    assert "tool_call_id" in fields, (
        "tool_call_id 不在 args_schema 里，langchain 不会注入它，"
        f"工具会报 missing required positional argument。当前字段：{sorted(fields)}"
    )


def test_real_toolcall_invocation_does_not_raise_missing_argument() -> None:
    """正向断言：真实 ToolCall 调用不得抛 TypeError（这就是那次事故的形态）。"""
    text = _invoke_via_toolcall({"action": "catalog"})
    assert "missing 1 required positional argument" not in text
    # catalog 是只读列举，必然成功
    assert text.strip(), "catalog 不该返回空"


def test_domain_only_action_still_returns_suggestions_after_fix() -> None:
    """端到端：注入修好后，只给域名的建议修复也必须同时生效。"""
    payload = json.loads(_invoke_via_toolcall({"action": "agents"}))
    assert payload.get("ok") is False
    suggestions = payload.get("suggestions") or []
    assert suggestions, "agents 是合法域，建议不该为空"
    assert all(s.startswith("agents.") for s in suggestions), suggestions
    assert "无相近动作" not in str(payload.get("suggestion_basis") or "")


def test_tool_call_id_not_leaked_into_args_json() -> None:
    """反证：注入的 tool_call_id 不能被并进 args_json（那会污染下游参数）。"""
    text = _invoke_via_toolcall({"action": "catalog"})
    assert "call_probe_1" not in text, "工具自身的调用 id 不该出现在业务返回里"
