"""提示条「这一步在做什么」的接线断言。

【self-evolution-bot · 2026-11-19 · 第71轮 · 模型:deepseek-v4.1-flash-1017】
为什么不用「调函数断言返回值」的写法：
    `_emit_cua_glow_step` 本来就支持 `title` 参数，函数层怎么测都是绿的。
    真实缺陷是**调用点没传 title**，于是永远退回关键词表猜（认不出就只剩
    「EvoFlow 正在操作电脑」，用户看不到在做什么）。
    这类「函数有、调用点没用」的缺陷，只有查调用点的实参才能抓住 —— 这正是
    我反复踩的「只测函数不测接线」。所以这里用 AST 查 `_run` 里的调用点。
"""

from __future__ import annotations

import ast
import inspect

from evoflow.plugins import node_repl_tool


def _module_ast() -> ast.Module:
    return ast.parse(inspect.getsource(node_repl_tool))


def _calls_in(func_name: str, callee: str) -> list[ast.Call]:
    """找 `func_name` 函数体里所有对 `callee` 的调用节点。"""
    out: list[ast.Call] = []
    for node in ast.walk(_module_ast()):
        if not isinstance(node, ast.FunctionDef) or node.name != func_name:
            continue
        for inner in ast.walk(node):
            if not isinstance(inner, ast.Call):
                continue
            fn = inner.func
            name = fn.attr if isinstance(fn, ast.Attribute) else getattr(fn, "id", "")
            if name == callee:
                out.append(inner)
    return out


def test_run_passes_title_into_step_emitter():
    """`_run` 必须把模型写的 title 传给步骤发射器。"""
    calls = _calls_in("_run", "_emit_cua_glow_step")
    assert calls, "`_run` 里找不到 `_emit_cua_glow_step` 调用 —— 接线被整体删掉了"
    keywords = {kw.arg for call in calls for kw in call.keywords}
    assert "title" in keywords, (
        "`_emit_cua_glow_step` 调用点没有传 title —— 提示条只能退回关键词表，"
        f"用户看不到模型写的具体操作（现有实参：{sorted(keywords)}）"
    )


def test_run_passes_cua_code_as_first_arg():
    """第一个位置参数必须是 code（否则关键词兜底也失效）。"""
    calls = _calls_in("_run", "_emit_cua_glow_step")
    assert calls
    call = calls[0]
    assert call.args, "`_emit_cua_glow_step` 调用没有位置参数"
    assert getattr(call.args[0], "id", "") == "code", (
        f"第一个位置参数应是 code，实际是 {ast.dump(call.args[0])[:60]}"
    )


def test_title_is_truncated_to_what_the_card_can_show():
    """截断判据必须是**显示宽度**，不是字符数（中英混排按字数截会误伤）。"""
    # 纯中文超长：必须截断
    long_cn = "正在打开系统设置里的显示设置并调整缩放比例到百分之两百"
    out = node_repl_tool._sanitize_cua_step_title(long_cn)
    assert out.endswith("…"), f"超长中文标题应截断并补省略号，实际 {out!r}"
    assert node_repl_tool._text_display_px(out) <= 156, (
        f"截断后仍超卡片宽度（{node_repl_tool._text_display_px(out):.0f}px > 156px）：{out!r}"
    )

    # 中英混排但放得下：不能被误截（这是我按字数截时踩的坑）
    mixed = "点击 Chrome 地址栏"
    assert node_repl_tool._sanitize_cua_step_title(mixed) == mixed, (
        f"中英混排 {node_repl_tool._text_display_px(mixed):.0f}px 放得下，"
        f"不该被截：{node_repl_tool._sanitize_cua_step_title(mixed)!r}"
    )


def test_title_with_implementation_terms_is_dropped_not_mangled():
    """含实现术语的标题整条丢弃，而不是抠词拼成读不通的句子。"""
    assert node_repl_tool._sanitize_cua_step_title("用 JavaScript 调 node_repl 截图") == ""
    # 正常标题原样保留
    assert node_repl_tool._sanitize_cua_step_title("点击 Chrome 地址栏") == "点击 Chrome 地址栏"
