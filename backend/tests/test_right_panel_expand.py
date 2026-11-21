"""ui.show(expand=...) 必须能把「让用户看见」透传到 surface。

【self-evolution-bot · 2026-11-20 · 第91轮 · 模型:deepseek-v4.1-flash-1017】
改了什么：新建本测试。
为什么：用户让我「用平台工具打开面板给他看」，我实测发现右栏被用户收起后
``ui.show`` 返回 ok:true 但**完全不撑开**（DOM 里 ``.react-chat-right-stage-shell``
根本不存在）。工具说「已打开」、用户屏幕上什么都没有，这是最直接的一步绕路。
修法是加显式 ``expand`` 开关；本测试锁住三件事：
1. 默认（不带 expand）surface 上不得出现 ``expand``，保持「模型不抢视线」；
2. expand=True 时进度类与非进度类都必须带上 ``expand: True``；
3. 前端三处消费点（store.applyRemote / applyStageSetPayload / openProgressFromPanelSet）
   必须真的读取这个字段，否则后端写了也是白写。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from evoflow.tools.builtins.stage_tool import apply_right_panel


@pytest.fixture(autouse=True)
def _isolated_side_effects(tmp_path, monkeypatch):
    """把状态盘 + 审计日志都指到 tmp_path。

    【self-evolution-bot · 2026-11-20 · 第101轮 · 模型:deepseek-v4.1-flash-1017】
    改了什么：给本文件加 autouse 隔离夹具。
    为什么（本轮自撞）：这个文件此前直接调 ``apply_right_panel``，既读用户现网状态、
      又往 ``right-stage-2026-11-20.log`` 写 ``[py] emit no-writer`` 行 —— 23:26:11
      跑一次就污染了 4 行，而那正是我要拿去当证据的文件。
      判据：跑本文件前后 ``right-stage-*.log`` 行数必须完全不变。
    """
    from app.gateway.routers import stage_right_panel as srp
    from evoflow.stage import right_stage_audit_log as audit

    monkeypatch.setattr(srp, "right_stage_state_path", lambda: tmp_path / "state.json")
    monkeypatch.setattr(audit, "_logs_dir", lambda: tmp_path)
    srp._STATE.clear()  # noqa: SLF001
    yield
    srp._STATE.clear()  # noqa: SLF001

_REPO = Path(__file__).resolve().parents[2]
_EVOPANEL = _REPO / "evopanel" / "src" / "lib" / "right-stage"


def _show(**kwargs):
    return apply_right_panel(action="show", thread_id="", session_key="", **kwargs)


def test_progress_kind_default_has_no_expand_flag():
    """默认不抢视线：surface 上不得出现 expand。"""
    out = _show(kind="employeeProcess", data={"agentCode": "self-evolution-bot"})
    assert out["ok"] is True
    assert "expand" not in out["surface"]


def test_progress_kind_expand_is_passed_through():
    out = _show(
        kind="employeeProcess",
        data={"agentCode": "self-evolution-bot"},
        expand=True,
    )
    assert out["ok"] is True
    assert out["surface"]["expand"] is True


def test_plain_kind_expand_is_passed_through():
    """非进度类（shell-page / web-embed）走另一条 surface 构造分支，同样要带。"""
    out = _show(kind="shell-page", data={"path": "/tasks"}, expand=True)
    assert out["ok"] is True
    assert out["surface"]["kind"] == "shell-page"
    assert out["surface"]["expand"] is True


def test_plain_kind_default_has_no_expand_flag():
    out = _show(kind="web-embed", data={"url": "https://example.com"})
    assert out["ok"] is True
    assert "expand" not in out["surface"]


def test_frontend_consumers_read_expand_flag():
    """后端写了 expand，前端必须真的读它 —— 否则只是换了个字段名空转。"""
    store_src = (_EVOPANEL / "right-stage-store.ts").read_text(encoding="utf-8")
    assert "forceExpand: surfNorm.expand === true" in store_src, (
        "store.applyRemote 没把 surface.expand 映射成 show() 的 forceExpand"
    )

    agui_src = (_EVOPANEL / "right-stage-agui.ts").read_text(encoding="utf-8")
    assert "forceExpand: payload.surface.expand === true" in agui_src, (
        "applyStageSetPayload 进度类分支没把 surface.expand 传给 openProgressFromPanelSet"
    )


def test_surface_type_declares_expand():
    types_src = (_EVOPANEL / "right-stage-types.ts").read_text(encoding="utf-8")
    assert "expand?: boolean" in types_src, "RightStageSurface 缺 expand 字段声明"
