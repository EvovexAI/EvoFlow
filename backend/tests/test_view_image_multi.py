"""view_image accepts one path or a list of paths/URLs."""

from __future__ import annotations

import io
import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from langchain_core.messages import ToolMessage
from langgraph.types import Command
from PIL import Image

from evoflow.tools.builtins.view_image_tool import (
    VIEW_IMAGE_MAX_REFS,
    normalize_image_path_args,
    view_image_tool,
)
from evoflow.tools.builtins.vision_analysis_core import (
    format_native_batch_tool_result,
    format_vision_batch_tool_result,
)


def _png_bytes() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (8, 8), color=(20, 40, 60)).save(buf, format="PNG")
    return buf.getvalue()


def _runtime(*, native_refs: list[str] | None = None) -> MagicMock:
    rt = MagicMock()
    rt.state = {"native_viewed_image_refs": list(native_refs or [])}
    rt.context = {}
    return rt


@pytest.mark.parametrize(
    "raw,expected",
    [
        (None, []),
        ("", []),
        ("/a/b.png", ["/a/b.png"]),
        ("https://ex.com/a,b.png", ["https://ex.com/a,b.png"]),
        (["/a.png", "/b.png", "/a.png"], ["/a.png", "/b.png"]),
        ('["/a.png", "/b.png"]', ["/a.png", "/b.png"]),
    ],
)
def test_normalize_image_path_args(raw, expected):
    assert normalize_image_path_args(raw) == expected


def test_format_native_batch_keeps_single_compat_fields():
    payload = json.loads(
        format_native_batch_tool_result(
            images=[
                {
                    "image_ref": "/a.png",
                    "mime_type": "image/png",
                    "image_size_bytes": 12,
                    "cached": False,
                }
            ]
        )
    )
    assert payload["count"] == 1
    assert payload["image_ref"] == "/a.png"
    assert payload["mode"] == "native"


def test_format_vision_batch_includes_load_errors():
    payload = json.loads(
        format_vision_batch_tool_result(
            {"analysis": "ok", "vision_model": "v1", "image_size_bytes": 9},
            image_refs=["/a.png", "/b.png"],
            load_errors=[{"image_ref": "/c.png", "error": "missing"}],
        )
    )
    assert payload["count"] == 2
    assert payload["analysis"] == "ok"
    assert payload["load_errors"][0]["image_ref"] == "/c.png"


def test_view_image_rejects_over_max():
    refs = [f"/tmp/img_{i}.png" for i in range(VIEW_IMAGE_MAX_REFS + 1)]
    out = view_image_tool.func(runtime=_runtime(), image_path=refs, tool_call_id="c1")
    assert isinstance(out, str)
    assert "Too many images" in out


def test_view_image_batch_native_stages_all(tmp_path: Path):
    paths = []
    for name in ("a.png", "b.png"):
        p = tmp_path / name
        p.write_bytes(_png_bytes())
        paths.append(str(p.resolve()))

    with patch(
        "evoflow.tools.builtins.view_image_tool.decide_view_image_route",
        return_value="native",
    ):
        out = view_image_tool.func(
            runtime=_runtime(),
            image_path=paths,
            tool_call_id="call-multi",
        )

    assert isinstance(out, Command)
    viewed = out.update["viewed_images"]
    assert set(viewed.keys()) == set(paths)
    assert out.update["native_viewed_image_refs"] == paths
    msg = out.update["messages"][0]
    assert isinstance(msg, ToolMessage)
    body = json.loads(msg.content)
    assert body["mode"] == "native"
    assert body["count"] == 2
    assert len(body["images"]) == 2


def test_view_image_batch_text_calls_multi_analyze(tmp_path: Path):
    paths = []
    for name in ("a.png", "b.png"):
        p = tmp_path / name
        p.write_bytes(_png_bytes())
        paths.append(str(p.resolve()))

    with (
        patch(
            "evoflow.tools.builtins.view_image_tool.decide_view_image_route",
            return_value="text",
        ),
        patch(
            "evoflow.tools.builtins.view_image_tool.analyze_images_bytes",
            return_value={
                "analysis": "two pictures",
                "vision_model": "vision-x",
                "image_size_bytes": 99,
            },
        ) as analyze_multi,
    ):
        out = view_image_tool.func(
            runtime=_runtime(),
            image_path=paths,
            tool_call_id="call-text-multi",
        )

    assert isinstance(out, str)
    body = json.loads(out)
    assert body["mode"] == "text"
    assert body["count"] == 2
    assert body["analysis"] == "two pictures"
    assert body["image_refs"] == paths
    analyze_multi.assert_called_once()
    args = analyze_multi.call_args.args[0]
    assert len(args) == 2
    assert args[0][2] == paths[0]


def test_view_image_single_string_still_works(tmp_path: Path):
    p = tmp_path / "one.png"
    p.write_bytes(_png_bytes())
    path = str(p.resolve())

    with patch(
        "evoflow.tools.builtins.view_image_tool.decide_view_image_route",
        return_value="native",
    ):
        out = view_image_tool.func(
            runtime=_runtime(),
            image_path=path,
            tool_call_id="call-one",
        )

    assert isinstance(out, Command)
    body = json.loads(out.update["messages"][0].content)
    assert body["mode"] == "native"
    assert body["image_ref"] == path
    assert "count" not in body or body.get("count") == 1


def test_view_image_hard_blocks_duplicate_native_read(tmp_path: Path):
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

    assert isinstance(out, str)
    assert out.startswith("Error: Image already in model context")
    assert "do not call read" in out.lower()
