"""工具**返回**一句 "Error: ..."（而非抛异常）时，ToolMessage.status 必须变 error。

【self-evolution-bot · 2026-11-22 · 第124轮 · 模型:deepseek-v4.1-flash】
现网实证（2026-11-22 18:01）：case-fullstack-dev 的 `search_code_index` 返回纯字符串
"Error: search_code_index failed: database disk image is malformed"。
三方口径互相打架：
  · obs 表记 status=error（`_completed_tool_should_log_as_error` 认了 Error: 前缀）；
  · 右侧面板那张卡显示「代码索引 / 查找 RightStagePanel / **已执行**」；
  · 模型看到的是错误正文。
根因链（逐层取证）：
  ToolMessage.status 始终是 None → `sse_ui_normalize._slim_tool_result_message`
  把 None 丢掉 → tool_result.status 缺省 "ok" → TOOL_CALL_RESULT.status="ok"
  → `agui_mirror._normalize_agui_tool_status("ok")` → "success" → 卡面「已执行」。
  同时 `if v4_status == "error": result_row["error"]={…}` 永不触发，错误字段也不写。
所以失败信号必须在**结果整形阶段**就落到 ToolMessage.status 上——本测试锁这一米。
"""

from __future__ import annotations

from types import SimpleNamespace

from langchain_core.messages import ToolMessage

from evoflow.agents.middlewares.tool_error_handling_middleware import (
    ToolErrorHandlingMiddleware,
)


def _request(tool_name: str = "search_code_index") -> SimpleNamespace:
    return SimpleNamespace(
        tool_call={"name": tool_name, "args": {"query": "RightStagePanel"}, "id": "tc-1"},
        runtime=SimpleNamespace(context={"thread_id": ""}, config={}),
    )


def _shape(content: str, *, tool_name: str = "search_code_index") -> ToolMessage:
    mw = ToolErrorHandlingMiddleware()
    msg = ToolMessage(content=content, tool_call_id="tc-1", name=tool_name)
    out = mw._apply_tool_result_shaping(msg, _request(tool_name))
    assert isinstance(out, ToolMessage)
    return out


def test_plain_error_string_sets_status_error():
    """现网原句：纯文本 Error: 前缀 → status 必须 flush 成 error。"""
    content = "Error: search_code_index failed: database disk image is malformed"
    out = _shape(content)
    assert str(out.status or "").strip().lower() == "error", (
        "裸文本 Error: 若仍留 status=None，V4 卡面会照旧显示「已执行」"
    )
    # 正文必须原样保留：模型与 obs 都靠这句排错。
    assert "database disk image is malformed" in str(out.content)


def test_success_result_keeps_status_non_error():
    """反证：正常结果不许被误标成失败（否则每个成功卡都变红）。"""
    out = _shape("Found 3 symbols for 'RightStagePanel'")
    assert str(out.status or "").strip().lower() != "error"


def test_json_error_envelope_still_works():
    """JSON 错误信封原有路径不受影响（既有的 _evoflow_tool / ok:false 判定）。"""
    out = _shape('{"ok": false, "error": "not_found", "hint": "ls the dir first"}')
    assert str(out.status or "").strip().lower() == "error"
