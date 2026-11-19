"""接线：收回控制权必须真的挂在 CUA 调用点前面。

【self-evolution-bot · 2026-11-19 · 第72轮 · 模型:deepseek-v4.1-flash-1017】

为什么用 AST 查调用点而不是调函数：
    `is_cua_control_revoked()` 自己测得再绿，只要 `_run` 里没拦，
    用户点了「解除控制」照样会看到 AI 继续操作鼠标 —— 函数层测试对
    「函数支持了但调用点没用」零分辨力。本轮第 4 次栽在这条上（第71轮 title 同型）。

判据：
    ① `_run` 函数体里必须存在「cua_cell 且 已收回 → 提前 return」的分支；
    ② 该分支必须 `return`，不能只是 log（否则会继续往下执行真正的 CUA 调用）；
    ③ 返回的文案必须告诉模型「不是停止你」且「用户发新消息会恢复」——
       少任何一句，模型会收尾、或反复重试、或叫用户重开会话。
"""

from __future__ import annotations

import ast
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "packages/harness/evoflow/plugins/node_repl_tool.py"


def _parse() -> ast.Module:
    return ast.parse(SRC.read_text(encoding="utf-8"))


def _find_func(tree: ast.Module, name: str) -> ast.FunctionDef:
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    raise AssertionError(f"{SRC.name} 里找不到函数 {name}")


def test_cua_gate_is_wired_into_run():
    run_body = ast.get_source_segment(SRC.read_text(encoding="utf-8"), _find_func(_parse(), "_run"))
    assert run_body, "取不到 _run 源码，判据失效"

    assert "_cua_control_revoked(" in run_body, (
        "_run 里没有调用 _cua_control_revoked —— 用户点「解除控制」后 AI 会继续操作电脑"
    )
    assert "_cua_control_revoked_payload()" in run_body, (
        "拦截分支没把原因告诉模型，模型只会反复重试到超时"
    )
    # 必须在真正的 CUA 调用之前就 return（否则拦了也没用）
    gate_at = run_body.index("_cua_control_revoked(")
    call_at = run_body.index("call_node_repl_js_structured(")
    assert gate_at < call_at, "收回判据写在真正调用之后 = 形同没有"


def test_gate_returns_early_not_just_logs():
    run_body = ast.get_source_segment(SRC.read_text(encoding="utf-8"), _find_func(_parse(), "_run"))
    gate_at = run_body.index("if cua_cell and _cua_control_revoked(")
    window = run_body[gate_at : gate_at + 400]
    assert "return" in window, "拦截分支必须 return，只 log 会继续执行真实 CUA"


def _payload_return_text() -> str:
    """只取**实际返回的字面量**，剥掉 docstring —— 否则注释里提一句就算通过。

    【self-evolution-bot · 2026-11-19 · 第72轮】本条是踩坑后的修正：
    第一版断言扫了整个函数源码，docstring 里写着「别拼 call failed」，
    于是 `"call failed" not in src` 失败 —— 判据测到了自己的注释。
    正向断言必须剥注释，否则「注释里提一句」比「真实现了」更容易满足。
    """
    fn = _find_func(_parse(), "_cua_control_revoked_payload")
    parts: list[str] = []
    for node in ast.walk(fn):
        if isinstance(node, ast.Return):
            for sub in ast.walk(node):
                if isinstance(sub, ast.Constant) and isinstance(sub.value, str):
                    parts.append(sub.value)
    return "".join(parts)


def test_payload_tells_model_three_things():
    payload_src = _payload_return_text()
    assert payload_src, "取不到返回文案，判据失效"
    # ① 不是停止 AI（否则模型以为整轮被终止，直接收尾）
    assert "不是**停止你**" in payload_src or "不是" in payload_src
    # ② 别重试（否则换坐标继续点到超时）
    assert "不需要重试" in payload_src or "不要" in payload_src
    # ③ 新消息会恢复（否则叫用户重新开会话，其实不用）
    assert "自动恢复" in payload_src or "新消息" in payload_src
    # 不能被判成工具失败（否则整轮被标红，模型会走错误恢复路径）
    assert "call failed" not in payload_src, "这不是失败，不该拼失败标记"


def test_gate_not_applied_to_non_cua_cells():
    """只有 CUA cell 才拦。别的工具（bash/read）在收回后必须照常可用。"""
    run_body = ast.get_source_segment(SRC.read_text(encoding="utf-8"), _find_func(_parse(), "_run"))
    assert "if cua_cell and _cua_control_revoked(" in run_body, (
        "拦截条件必须带 cua_cell，否则收回控制权会把所有 node_repl 调用一起废掉"
    )
