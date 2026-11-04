"""Regression for 读图工具故障报告 Mode A / Mode B (2026-11-04)."""

from __future__ import annotations

import io
import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.types import Command
from PIL import Image

from evoflow.agents.context_compaction_core import strip_image_base64_from_messages
from evoflow.agents.middlewares.view_image_middleware import ViewImageMiddleware
from evoflow.tools.builtins.view_image_tool import view_image_tool


def _png_bytes(color: tuple[int, int, int] = (200, 30, 30)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (64, 64), color=color).save(buf, format="PNG")
    return buf.getvalue()


def _runtime(*, native_refs: list[str] | None = None) -> MagicMock:
    rt = MagicMock()
    rt.state = {"native_viewed_image_refs": list(native_refs or [])}
    rt.context = {}
    return rt


def _turn_with_view_image(tool_call_id: str = "call-1") -> list:
    return [
        AIMessage(
            content="",
            tool_calls=[{"id": tool_call_id, "name": "view_image", "args": {"image_path": "x.png"}}],
        ),
        ToolMessage(content="staged", tool_call_id=tool_call_id),
    ]


@pytest.fixture
def vision_enabled():
    with patch(
        "evoflow.agents.middlewares.view_image_middleware.main_model_supports_vision",
        return_value=True,
    ):
        yield


def test_mode_a_strip_preserves_inject_when_no_real_user():
    """Proactive runs have no real user; strip must not erase just-injected pixels."""
    inject = HumanMessage(
        name="view_image_inject",
        content=[
            {"type": "text", "text": "Here are the images you've viewed:"},
            {
                "type": "image_url",
                "image_url": {"url": "data:image/png;base64,AAAA"},
            },
        ],
    )
    messages = [
        AIMessage(content="ok"),
        ToolMessage(content="{}", tool_call_id="c1"),
        inject,
    ]
    out = strip_image_base64_from_messages(messages)
    assert out is messages or out[-1].content == inject.content
    blocks = out[-1].content
    assert any(isinstance(b, dict) and b.get("type") == "image_url" for b in blocks)


def test_mode_a_strip_all_keeps_latest_inject():
    inject = HumanMessage(
        name="view_image_inject",
        content=[
            {"type": "text", "text": "Here are the images you've viewed:"},
            {
                "type": "image_url",
                "image_url": {"url": "data:image/png;base64,BBBB"},
            },
        ],
    )
    older = HumanMessage(
        content=[
            {
                "type": "image_url",
                "image_url": {"url": "data:image/png;base64,OLD"},
            }
        ]
    )
    messages = [older, AIMessage(content="x"), inject]
    out = strip_image_base64_from_messages(messages, strip_all=True)
    assert any(
        isinstance(b, dict) and b.get("type") == "image_url" for b in out[-1].content
    )
    # Older image before the inject boundary is stripped.
    assert not any(
        isinstance(b, dict) and b.get("type") == "image_url" for b in out[0].content
    )


def test_mode_b_empty_viewed_images_does_not_inject_no_images_message(vision_enabled):
    state = {
        "messages": _turn_with_view_image(),
        "viewed_images": {},
    }
    mw = ViewImageMiddleware()
    assert mw._inject_image_message(state, runtime=None) is None


def test_mode_b_reread_restages_instead_of_hard_block(tmp_path: Path):
    p = tmp_path / "dup.png"
    p.write_bytes(_png_bytes())
    path = str(p.resolve())

    with patch(
        "evoflow.tools.builtins.view_image_tool.decide_view_image_route",
        return_value="native",
    ):
        out = view_image_tool.func(
            runtime=_runtime(native_refs=[path]),
            image_path=path,
            tool_call_id="call-dup",
        )

    assert isinstance(out, Command)
    body = json.loads(out.update["messages"][0].content)
    assert body["mode"] == "native"
    assert body["pixels_delivered"] is False
    assert body["pixels_status"] == "pending_inject"
    assert path in out.update["viewed_images"]
    # Delivery marker is middleware-owned, not tool-owned.
    assert "native_viewed_image_refs" not in out.update


def test_inject_marks_native_refs_only_when_pixels_delivered(tmp_path: Path, vision_enabled):
    img_path = tmp_path / "ok.png"
    img_path.write_bytes(_png_bytes())
    state = {
        "messages": _turn_with_view_image(),
        "viewed_images": {
            str(img_path): {"path": str(img_path), "mime_type": "image/png"},
        },
    }
    mw = ViewImageMiddleware()
    update = mw._inject_image_message(state, runtime=None)
    assert update is not None
    assert update["messages"][0].name == "view_image_inject"
    assert any(
        isinstance(b, dict) and b.get("type") == "image_url"
        for b in update["messages"][0].content
    )
    assert update["native_viewed_image_refs"] == [str(img_path)]
    assert update["viewed_images"] == {}
