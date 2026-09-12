"""Workspace runtime live footer injects clock into system <workspace>, not HumanMessage."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from langchain.agents.middleware.types import ModelRequest
from langchain_core.messages import HumanMessage, SystemMessage

from evoflow.agents.middlewares.workspace_runtime_live_footer_middleware import (
    WorkspaceRuntimeLiveFooterMiddleware,
    inject_runtime_clock_into_workspace,
    strip_runtime_clock_lines_from_system_prompt,
)


def test_inject_runtime_clock_into_workspace_upserts_line() -> None:
    src = "<workspace>\n用户工作目录: D:\\proj\n操作系统: Windows\n</workspace>"
    out = inject_runtime_clock_into_workspace(src, "时间: 2026-08-13 星期四 (UTC+08:00)")
    assert "用户工作目录: D:\\proj" in out
    assert "时间: 2026-08-13 星期四 (UTC+08:00)" in out
    assert out.count("时间:") == 1
    assert "<session_runtime_clock>" not in out


def test_strip_runtime_clock_lines_from_system_prompt() -> None:
    src = (
        "<workspace>\n用户工作目录: /ws\n时间: old\n当前系统时间: legacy\n"
        "<session_runtime_clock>\nCurrent system time: x\n</session_runtime_clock>\n"
        "</workspace>"
    )
    out = strip_runtime_clock_lines_from_system_prompt(src)
    assert "时间:" not in out
    assert "当前系统时间" not in out
    assert "session_runtime_clock" not in out.lower()
    assert "用户工作目录: /ws" in out


def test_workspace_live_footer_injects_clock_into_system_workspace() -> None:
    mw = WorkspaceRuntimeLiveFooterMiddleware()
    req = ModelRequest(
        model=MagicMock(),
        messages=[
            HumanMessage(content="hi"),
            HumanMessage(content="<session_runtime_clock>\nold\n</session_runtime_clock>", name="session_runtime_clock"),
        ],
        tools=[],
        state={
            "messages": [
                HumanMessage(content="hi"),
                HumanMessage(
                    content="<session_runtime_clock>\nold\n</session_runtime_clock>",
                    name="session_runtime_clock",
                ),
            ]
        },
        runtime=MagicMock(),
    )
    req = req.override(
        system_message=SystemMessage(
            content="base system only\n<workspace>\n用户工作目录: D:\\proj\n当前系统时间: 1999-01-01\n</workspace>"
        )
    )

    with (
        patch(
            "evoflow.agents.middlewares.dynamic_system_prompt_middleware._merged_runtime_context",
            return_value={"prompt_language": "zh"},
        ),
        patch(
            "evoflow.agents.middlewares.dynamic_system_prompt_middleware._resolve_prompt_meta",
            return_value={"local_workspace_root": "D:\\proj", "use_virtual_paths": False, "prompt_language": "zh"},
        ),
    ):
        out = mw._patch_request(req)

    text = str(out.system_message.content or "")
    assert "base system only" in text
    assert "<workspace>" in text
    assert "用户工作目录: D:\\proj" in text
    assert "时间:" in text
    assert "当前系统时间" not in text
    assert "1999-01-01" not in text
    assert not any(getattr(m, "name", None) == "session_runtime_clock" for m in out.messages)
    assert out.messages[-1].content == "hi"


def test_workspace_live_footer_does_not_rewrite_workspace_path() -> None:
    mw = WorkspaceRuntimeLiveFooterMiddleware()
    stable = "intro\n<workspace>\n用户工作目录: /tmp/ws\n操作系统: Linux\n</workspace>\n"
    req = ModelRequest(
        model=MagicMock(),
        messages=[HumanMessage(content="next")],
        tools=[],
        state={"messages": [HumanMessage(content="next")]},
        runtime=MagicMock(),
    )
    req = req.override(system_message=SystemMessage(content=stable))

    with (
        patch(
            "evoflow.agents.middlewares.dynamic_system_prompt_middleware._merged_runtime_context",
            return_value={},
        ),
        patch(
            "evoflow.agents.middlewares.dynamic_system_prompt_middleware._resolve_prompt_meta",
            return_value={"local_workspace_root": "/other"},
        ),
    ):
        out = mw._patch_request(req)

    text = str(out.system_message.content or "")
    assert "/tmp/ws" in text
    assert text.count("<workspace>") == 1
    assert "Time:" in text or "时间:" in text
    assert not any(getattr(m, "name", None) == "session_runtime_clock" for m in out.messages)
