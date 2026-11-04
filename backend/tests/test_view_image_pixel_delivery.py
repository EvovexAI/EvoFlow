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


def _inject_with_pixels(payload: str = "AAAA") -> HumanMessage:
    return HumanMessage(
        name="view_image_inject",
        content=[
            {"type": "text", "text": "Here are the images you've viewed:"},
            {
                "type": "image_url",
                "image_url": {"url": f"data:image/png;base64,{payload}"},
            },
        ],
    )


def _has_image_url(msg: HumanMessage) -> bool:
    content = msg.content
    return isinstance(content, list) and any(
        isinstance(b, dict) and b.get("type") == "image_url" for b in content
    )


def test_mode_a_strip_preserves_inject_when_no_real_user():
    """Proactive runs have no real user; strip must not erase just-injected pixels."""
    inject = _inject_with_pixels()
    messages = [
        AIMessage(content="ok"),
        ToolMessage(content="{}", tool_call_id="c1"),
        inject,
    ]
    out = strip_image_base64_from_messages(messages)
    assert out is messages or out[-1].content == inject.content
    assert _has_image_url(out[-1])


def test_mode_a_strip_preserves_inject_when_live_footer_follows():
    """Live footers after ViewImage must not shift the strip boundary past inject."""
    inject = _inject_with_pixels("PIXELS")
    messages = [
        HumanMessage(content="blindtest please describe the image"),
        AIMessage(
            content="",
            tool_calls=[{"id": "c1", "name": "read", "args": {"path": "b1.png"}}],
        ),
        ToolMessage(content='{"pixels_delivered":false}', tool_call_id="c1"),
        inject,
        # Middleware order: ViewImage then Collab/Xiaomi footers append after inject.
        HumanMessage(content="<collab_live>plan</collab_live>", name="session_collab_live"),
        HumanMessage(content="<xiaomi>page</xiaomi>", name="xiaomi_ui_context"),
    ]
    out = strip_image_base64_from_messages(messages)
    assert _has_image_url(out[3]), (
        "inject pixels were stripped because a live footer was treated as the latest real user"
    )


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
    sources = (update["messages"][0].additional_kwargs or {}).get("view_image_sources")
    assert isinstance(sources, list) and sources and sources[0]["path"] == str(img_path)


def test_mode_a_old_inject_collapses_to_stub_not_omitted_placeholder():
    """Prior-turn injects must not become the misleading 'base64 omitted' image line."""
    old_inject = _inject_with_pixels("OLD")
    messages = [
        HumanMessage(content="first turn"),
        AIMessage(content="ok"),
        old_inject,
        HumanMessage(content="second turn — new question"),
    ]
    out = strip_image_base64_from_messages(messages)
    collapsed = out[2]
    assert isinstance(collapsed.content, str)
    assert "base64 data omitted" not in collapsed.content
    assert "removed from context" in collapsed.content


def test_wrap_reattaches_pixels_after_omitted_placeholder(tmp_path: Path, vision_enabled):
    """Compaction strip left omitted text; wrap_model_call must restore data-URIs."""
    img_path = tmp_path / "reattach.png"
    img_path.write_bytes(_png_bytes((40, 170, 70)))
    path = str(img_path.resolve())

    stripped = HumanMessage(
        name="view_image_inject",
        content=[
            {"type": "text", "text": "Here are the images you've viewed:"},
            {"type": "text", "text": f"\n- **{path}** (image/png)\n[Image attached at: {path}]"},
            {
                "type": "text",
                "text": "[Image (image/png) — base64 data omitted to save context]",
            },
        ],
        additional_kwargs={
            "view_image_sources": [
                {
                    "ref": path,
                    "path": path,
                    "mime_type": "image/png",
                    "is_remote": False,
                    "auto": False,
                    "label": "",
                }
            ]
        },
    )
    request = MagicMock()
    request.messages = [HumanMessage(content="look"), stripped]
    request.override = lambda **kw: MagicMock(messages=kw["messages"])

    mw = ViewImageMiddleware()
    patched = mw._reattach_pixels_on_request(request)
    rebuilt = patched.messages[-1]
    assert _has_image_url(rebuilt)
    assert not any(
        isinstance(b, dict) and "base64 data omitted" in str(b.get("text") or "")
        for b in rebuilt.content
        if isinstance(b, dict)
    )
