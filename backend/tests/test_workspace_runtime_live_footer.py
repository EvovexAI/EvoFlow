"""Live ``<workspace>`` footer: clock + active model lines.

The model line tells the agent which model it is running as (same channel the
live clock uses — upserted per model call, stripped before re-injection so a
mid-session model switch rewrites instead of stacking).
"""

from __future__ import annotations

from types import SimpleNamespace

from evoflow.agents.middlewares.workspace_runtime_live_footer_middleware import (
    _extract_model_name,
    inject_runtime_clock_into_workspace,
    inject_runtime_lines_into_workspace,
    strip_runtime_clock_lines_from_system_prompt,
)

WS_BLOCK = "<workspace>\nD:\\work\\proj\n\nOS: Windows\nShell: bash\n</workspace>"


def test_injects_clock_and_model_after_path():
    out = inject_runtime_lines_into_workspace(
        WS_BLOCK, ["时间: 2026-11-15 10:00", "模型: glm-5.3-flash"]
    )
    assert out.index("D:\\work\\proj") < out.index("时间:") < out.index("模型:")
    assert out.index("模型: glm-5.3-flash") < out.index("OS: Windows")
    assert out.count("<workspace>") == 1


def test_model_switch_rewrites_line_not_stack():
    first = inject_runtime_lines_into_workspace(WS_BLOCK, ["时间: T1", "模型: model-a"])
    second = inject_runtime_lines_into_workspace(first, ["时间: T2", "模型: model-b"])
    assert "模型: model-b" in second
    assert "model-a" not in second
    assert second.count("模型:") == 1


def test_follow_mode_drops_stale_model_line():
    # 会话解除 pin 后下一行只有时钟：旧的模型行必须被剥离而不是残留
    pinned = inject_runtime_lines_into_workspace(WS_BLOCK, ["时间: T1", "模型: model-a"])
    follow = inject_runtime_lines_into_workspace(pinned, ["时间: T2"])
    assert "模型:" not in follow
    assert "时间: T2" in follow


def test_creates_workspace_block_when_missing():
    out = inject_runtime_lines_into_workspace("普通系统提示词", ["时间: T", "模型: m1"])
    assert "<workspace>" in out and "模型: m1" in out and "时间: T" in out
    out2 = inject_runtime_lines_into_workspace("", ["时间: T", "模型: m1"])
    assert out2.startswith("<workspace>")


def test_clock_only_keeps_legacy_wrapper():
    out = inject_runtime_clock_into_workspace(WS_BLOCK, "时间: T1")
    assert "时间: T1" in out
    assert "模型:" not in out


def test_strip_removes_model_and_clock_lines():
    text = "前文\n模型: model-a\nModel: model-b\n时间: T\n\n后文"
    out = strip_runtime_clock_lines_from_system_prompt(text)
    assert "模型:" not in out and "Model:" not in out and "时间:" not in out
    assert "前文" in out and "后文" in out


def test_extract_model_name_variants():
    assert _extract_model_name(SimpleNamespace(model_name="glm-5")) == "glm-5"
    assert _extract_model_name(SimpleNamespace(model="k2")) == "k2"
    assert _extract_model_name(SimpleNamespace()) == ""
    assert _extract_model_name(None) == ""
    # 列表形态（多模态名）取第一个
    assert _extract_model_name(SimpleNamespace(model_name=["a", "b"])) == "a"
