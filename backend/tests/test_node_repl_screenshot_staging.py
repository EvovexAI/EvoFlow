"""node_repl 截图识别链对齐 ZCode 的单测：

- 帧完整性门（``_validate_kernel_images``）：sha256 / 宽高 / EXIF 方向对账，
  不符整图拒收（对齐 ZCode ``preserveOfficialCuaFrameResult``）。
- 注入预算（``prepare_image_bytes_for_native`` 的 ``max_base64_bytes``）：
  输出 data URL base64 不超 ZCode prepareForModel 的 200KB 上限。
- ``ViewImageMiddleware``：auto（工具自行 stage）条目无需 ``view_image``
  调用即可注入；manual/auto 分区文案；注入后清空。
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
from pathlib import Path
from unittest.mock import patch

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.types import Command
from PIL import Image

from evoflow.agents.middlewares.view_image_middleware import ViewImageMiddleware
from evoflow.plugins.node_repl_tool import _validate_kernel_images
from evoflow.tools.builtins.vision_analysis_core import (
    MODEL_INJECT_MAX_BASE64_BYTES,
    prepare_image_bytes_for_native,
)


def _png_bytes(width: int = 64, height: int = 48, color=(120, 30, 200)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (width, height), color).save(buf, format="PNG")
    return buf.getvalue()


def _image_entry(raw: bytes, mime: str = "image/png") -> dict[str, str]:
    return {"data": base64.b64encode(raw).decode("ascii"), "mime_type": mime}


_FRAME_META_KEY = "zcode.cua/official-frame-integrity-v1"


class TestFrameIntegrityGate:
    def test_valid_image_passes_strict_receipt(self):
        raw = _png_bytes()
        meta = {
            _FRAME_META_KEY: {
                "version": 1,
                "frame_id": "frame-abc123",
                "media_type": "image/png",
                "sha256": hashlib.sha256(raw).hexdigest(),
                "width": 64,
                "height": 48,
            }
        }
        valid, notes = _validate_kernel_images([_image_entry(raw)], meta)
        assert len(valid) == 1
        assert notes == []

    def test_sha256_mismatch_rejects_image(self):
        raw = _png_bytes()
        other = _png_bytes(color=(1, 2, 3))
        meta = {
            _FRAME_META_KEY: {
                "version": 1,
                "frame_id": "frame-abc123",
                "media_type": "image/png",
                "sha256": hashlib.sha256(other).hexdigest(),
                "width": 64,
                "height": 48,
            }
        }
        valid, notes = _validate_kernel_images([_image_entry(raw)], meta)
        assert valid == []
        assert len(notes) == 1
        assert "sha256" in notes[0]

    def test_dimension_mismatch_rejects_image(self):
        raw = _png_bytes(width=64, height=48)
        meta = {
            _FRAME_META_KEY: {
                "version": 1,
                "frame_id": "frame-abc123",
                "media_type": "image/png",
                "sha256": hashlib.sha256(raw).hexdigest(),
                "width": 100,
                "height": 100,
            }
        }
        valid, notes = _validate_kernel_images([_image_entry(raw)], meta)
        assert valid == []
        assert any("does not match frame receipt" in note for note in notes)

    def test_non_canonical_exif_orientation_rejects(self):
        buf = io.BytesIO()
        img = Image.new("RGB", (64, 48), (10, 200, 30))
        exif = img.getexif()
        exif[274] = 6  # Orientation: right-top
        img.save(buf, format="PNG", exif=exif.tobytes())
        raw = buf.getvalue()
        valid, notes = _validate_kernel_images([_image_entry(raw)], None)
        assert valid == []
        assert any("orientation" in note for note in notes)

    def test_undecodable_base64_rejects(self):
        valid, notes = _validate_kernel_images([{"data": "!!!not-base64!!!", "mime_type": "image/png"}], None)
        assert valid == []
        assert notes

    def test_multi_image_result_skips_strict_receipt(self):
        # 凭证只绑定"本次最终栅格"；多图结果无法对账，退化为解码检查不误杀。
        raw = _png_bytes()
        meta = {
            _FRAME_META_KEY: {
                "version": 1,
                "frame_id": "frame-abc123",
                "media_type": "image/png",
                "sha256": "deadbeef" * 8,
                "width": 64,
                "height": 48,
            }
        }
        valid, _notes = _validate_kernel_images([_image_entry(raw), _image_entry(raw)], meta)
        assert len(valid) == 2

    def test_no_receipt_still_requires_decodable(self):
        raw = _png_bytes()
        valid, notes = _validate_kernel_images([_image_entry(raw)], None)
        assert len(valid) == 1
        assert notes == []


class TestNativeInjectBudget:
    def test_budget_output_within_limit(self):
        # 2000x1400 噪声图 q85 通常 > 200KB，预算路径必须压到上限内。
        import random

        rng = random.Random(7)
        buf = io.BytesIO()
        img = Image.new("RGB", (2000, 1400))
        img.putdata([(rng.randrange(256), rng.randrange(256), rng.randrange(256)) for _ in range(2000 * 1400)])
        img.save(buf, format="PNG")
        raw = buf.getvalue()
        assert len(raw) > MODEL_INJECT_MAX_BASE64_BYTES

        prepared, mime = prepare_image_bytes_for_native(
            raw, "image/png", max_base64_bytes=MODEL_INJECT_MAX_BASE64_BYTES
        )
        assert mime == "image/jpeg"
        assert (len(prepared) + 2) // 3 * 4 <= MODEL_INJECT_MAX_BASE64_BYTES

    def test_small_image_unchanged_without_budget(self):
        raw = _png_bytes()
        prepared, mime = prepare_image_bytes_for_native(raw, "image/png")
        assert mime in ("image/png", "image/jpeg")
        assert len(prepared) <= max(len(raw), 1024)

    def test_raw_wins_when_both_fit(self):
        raw = _png_bytes(width=32, height=24)
        prepared, _mime = prepare_image_bytes_for_native(
            raw, "image/png", max_base64_bytes=MODEL_INJECT_MAX_BASE64_BYTES
        )
        assert len(prepared) <= len(raw)


@pytest.fixture()
def vision_enabled():
    # 路由判定（image_routing）与中间件门控各自导入了 main_model_supports_vision，
    # 两处都要 patch 才代表"主模型支持视觉"。
    with patch("evoflow.agents.middlewares.view_image_middleware.main_model_supports_vision", return_value=True), patch(
        "evoflow.agents.image_routing.main_model_supports_vision", return_value=True
    ):
        yield


def _turn_messages(tool_name: str = "mcp__node_repl__js") -> list:
    ai = AIMessage(content="", tool_calls=[{"name": tool_name, "args": {"code": "1"}, "id": "call-1"}])
    tool = ToolMessage(content="ok", tool_call_id="call-1")
    return [HumanMessage(content="hi"), ai, tool]


class TestAutoImageInjection:
    def test_auto_staged_image_injects_without_view_image_call(self, tmp_path: Path, vision_enabled):
        img_path = tmp_path / "shot.png"
        img_path.write_bytes(_png_bytes())
        state = {
            "messages": _turn_messages(tool_name="mcp__node_repl__js"),
            "viewed_images": {
                str(img_path): {"path": str(img_path), "mime_type": "image/jpeg", "auto": True, "label": "screen capture"}
            },
        }
        mw = ViewImageMiddleware()
        assert mw._has_auto_images(state) is True
        assert mw._should_inject_image_message(state) == (True, "ok")

        update = mw._inject_image_message(state, runtime=None)
        assert update is not None
        messages = update["messages"]
        assert len(messages) == 1
        content = messages[0].content
        texts = [block.get("text", "") for block in content if isinstance(block, dict)]
        assert any("latest screen captures" in t for t in texts)
        assert any(block.get("type") == "image_url" for block in content if isinstance(block, dict))
        # 注入一次性：状态清空
        assert update["viewed_images"] == {}

    def test_manual_only_gate_still_requires_view_image_call(self, tmp_path: Path, vision_enabled):
        img_path = tmp_path / "manual.png"
        img_path.write_bytes(_png_bytes())
        state = {
            "messages": _turn_messages(tool_name="SomeOtherTool"),
            "viewed_images": {str(img_path): {"path": str(img_path), "mime_type": "image/png"}},
        }
        mw = ViewImageMiddleware()
        assert mw._should_inject_image_message(state) == (False, "no_read_image_tool_and_no_auto")

    def test_mixed_manual_and_auto_sections(self, tmp_path: Path, vision_enabled):
        manual_path = tmp_path / "manual.png"
        manual_path.write_bytes(_png_bytes())
        auto_path = tmp_path / "auto.jpg"
        auto_path.write_bytes(_png_bytes())
        state = {
            "messages": _turn_messages(tool_name="view_image"),
            "viewed_images": {
                str(manual_path): {"path": str(manual_path), "mime_type": "image/png"},
                str(auto_path): {"path": str(auto_path), "mime_type": "image/jpeg", "auto": True},
            },
        }
        mw = ViewImageMiddleware()
        update = mw._inject_image_message(state, runtime=None)
        assert update is not None
        texts = [block.get("text", "") for block in update["messages"][0].content if isinstance(block, dict)]
        joined = "\n".join(texts)
        assert "Here are the images you've viewed:" in joined
        assert "Latest screen captures:" in joined
        image_blocks = [b for b in update["messages"][0].content if isinstance(b, dict) and b.get("type") == "image_url"]
        assert len(image_blocks) == 2

    def test_auto_image_respects_inject_budget(self, tmp_path: Path, vision_enabled):
        import random

        rng = random.Random(11)
        img = Image.new("RGB", (2000, 1400))
        img.putdata([(rng.randrange(256), rng.randrange(256), rng.randrange(256)) for _ in range(2000 * 1400)])
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        img_path = tmp_path / "big.png"
        img_path.write_bytes(buf.getvalue())

        state = {
            "messages": _turn_messages(),
            "viewed_images": {str(img_path): {"path": str(img_path), "mime_type": "image/png", "auto": True}},
        }
        mw = ViewImageMiddleware()
        update = mw._inject_image_message(state, runtime=None)
        assert update is not None
        image_blocks = [b for b in update["messages"][0].content if isinstance(b, dict) and b.get("type") == "image_url"]
        assert len(image_blocks) == 1
        url = image_blocks[0]["image_url"]["url"]
        assert url.startswith("data:image/jpeg;base64,")
        assert len(url) - len("data:image/jpeg;base64,") <= MODEL_INJECT_MAX_BASE64_BYTES


def test_tool_result_payload_roundtrip_marker():
    """display 标记行保持网关可剥离（{_CUA_DISPLAY_MARKER_PREFIX ... }）。"""
    from evoflow.plugins.node_repl_tool import _DISPLAY_MARKER_PREFIX, _display_marker

    marker = _display_marker({"status": "success", "images": [{"url": "/api/x", "kb": 12}]})
    assert marker.startswith(_DISPLAY_MARKER_PREFIX) and marker.endswith("}")
    payload_text = marker[len(_DISPLAY_MARKER_PREFIX) : -1]
    payload = json.loads(payload_text)
    assert payload["status"] == "success"


class TestAgentBrowserScreenshotStaging:
    """bash 工具对 agent-browser screenshot 的自动 staging（生产浏览器路径）。"""

    def _bash_result(self) -> str:
        return "status: completed\nexitCode: 0\ninterrupted: false\nstdout:\nSaved screenshot to /tmp/shot.png\nstderr:\n"

    def test_screenshot_file_staged(self, tmp_path: Path, vision_enabled):
        from evoflow.tools.zcode_port.bash_tool import _maybe_stage_agent_browser_screenshot

        shot = tmp_path / "shot.png"
        shot.write_bytes(_png_bytes())
        command = f"agent-browser --session s1 screenshot {shot.as_posix()}"
        out = _maybe_stage_agent_browser_screenshot(
            runtime=None, command=command, cwd=str(tmp_path), tool_call_id="call-1", result=self._bash_result()
        )
        assert isinstance(out, Command)
        staged = out.update["viewed_images"]
        assert len(staged) == 1
        entry = next(iter(staged.values()))
        assert entry["auto"] is True and entry["mime_type"] == "image/png"
        assert Path(entry["path"]).is_file()
        content = out.update["messages"][0].content
        assert "you will see the pixels" in content
        assert "do not mention the file path" in content.lower()
        assert str(shot) not in content
        assert "@@...png@@" in content

    def test_missing_file_falls_back_to_text(self, tmp_path: Path, vision_enabled):
        from evoflow.tools.zcode_port.bash_tool import _maybe_stage_agent_browser_screenshot

        command = f"agent-browser --session s1 screenshot {tmp_path / 'nope.png'}"
        out = _maybe_stage_agent_browser_screenshot(
            runtime=None, command=command, cwd=str(tmp_path), tool_call_id="call-1", result=self._bash_result()
        )
        assert isinstance(out, str)

    def test_unrelated_command_untouched(self, tmp_path: Path, vision_enabled):
        from evoflow.tools.zcode_port.bash_tool import _maybe_stage_agent_browser_screenshot

        out = _maybe_stage_agent_browser_screenshot(
            runtime=None, command="agent-browser --session s1 snapshot -c", cwd=str(tmp_path),
            tool_call_id="call-1", result=self._bash_result(),
        )
        assert isinstance(out, str)

    def test_relative_path_resolved_against_cwd(self, tmp_path: Path, vision_enabled):
        from evoflow.tools.zcode_port.bash_tool import _maybe_stage_agent_browser_screenshot

        shot = tmp_path / "rel.png"
        shot.write_bytes(_png_bytes())
        out = _maybe_stage_agent_browser_screenshot(
            runtime=None, command="agent-browser screenshot rel.png", cwd=str(tmp_path),
            tool_call_id="call-1", result=self._bash_result(),
        )
        assert isinstance(out, Command)

    def test_no_tool_call_id_degrades_to_text(self, tmp_path: Path, vision_enabled):
        from evoflow.tools.zcode_port.bash_tool import _maybe_stage_agent_browser_screenshot

        shot = tmp_path / "shot.png"
        shot.write_bytes(_png_bytes())
        out = _maybe_stage_agent_browser_screenshot(
            runtime=None, command=f"agent-browser screenshot {shot.as_posix()}", cwd=str(tmp_path),
            tool_call_id="", result=self._bash_result(),
        )
        assert isinstance(out, str)
        assert "staged for your next context" in out
        assert "do not mention the file path" in out.lower()
        assert str(shot) not in out


class TestBrowserSnapshotRef:
    def test_api_path_resolves_to_saved_png(self, tmp_path: Path, monkeypatch):
        from evoflow.tools.builtins.browser_screenshot_store import (
            resolve_browser_snapshot_ref,
            save_screenshot_png,
        )

        class _Paths:
            base_dir = tmp_path

        monkeypatch.setattr(
            "evoflow.tools.builtins.browser_screenshot_store.get_paths",
            lambda: _Paths(),
        )
        meta = save_screenshot_png("evoflow", _png_bytes())
        resolved = resolve_browser_snapshot_ref(str(meta["image_url"]))
        assert resolved is not None and resolved.is_file()
        assert resolve_browser_snapshot_ref(
            f"http://127.0.0.1:38012{meta['image_url']}"
        ) == resolved
        assert resolve_browser_snapshot_ref("/api/threads/missing/browser-snapshots/abcdef1234567890") is None


class TestBrowserToolScreenshotFormat:
    def test_staged_flag_changes_summary_and_payload(self, tmp_path: Path):
        from evoflow.tools.builtins.browser_screenshot_store import format_screenshot_tool_result

        meta = {
            "screenshot_id": "abcdef1234567890",
            "image_url": "/api/threads/t/browser-snapshots/abcdef1234567890",
            "page_url": "https://example.com",
            "full_page": False,
            "width": 1280,
            "height": 800,
            "size_kb": 42,
        }
        old = json.loads(format_screenshot_tool_result("t", meta))
        new = json.loads(format_screenshot_tool_result("t", meta, staged_for_model=True))
        assert "not included in your context" in old["summary"]
        assert "you will see the pixels" in new["summary"]
        assert "do not mention the file path" in old["summary"].lower()
        assert "do not mention the file path" in new["summary"].lower()
        assert "@@...png@@" in old["summary"] and "@@...png@@" in new["summary"]
        assert new["staged_for_model"] is True and old["staged_for_model"] is False


class TestNodeReplToolCallIdInjection:
    def test_schema_and_signature_mark_tool_call_id_injected(self):
        from langchain_core.tools.base import _is_injected_arg_type
        from langchain_core.tools.base import InjectedToolCallId
        from pydantic import BaseModel

        from evoflow.plugins.node_repl_tool import NodeReplJsInput, build_node_repl_js_tool

        anns = NodeReplJsInput.__annotations__
        assert _is_injected_arg_type(anns["tool_call_id"], injected_type=InjectedToolCallId)
        tool = build_node_repl_js_tool()
        if tool is None:
            return
        assert "tool_call_id" in tool._injected_args_keys
        schema = tool.tool_call_schema
        if isinstance(schema, type) and issubclass(schema, BaseModel):
            assert "tool_call_id" not in schema.model_fields


class TestCuaRasterPng:
    def test_jpeg_becomes_real_png_with_pixel_size(self):
        import io

        from PIL import Image

        from evoflow.plugins.node_repl_tool import _raster_png_and_size

        buf = io.BytesIO()
        Image.new("RGB", (1280, 797), (10, 20, 30)).save(buf, format="JPEG")
        jpeg = buf.getvalue()
        assert not jpeg.startswith(b"\x89PNG")
        png, width, height = _raster_png_and_size(jpeg)
        assert png.startswith(b"\x89PNG")
        assert (width, height) == (1280, 797)
        # PNG IHDR width/height, the offsets the model was reading.
        assert int.from_bytes(png[16:20], "big") == 1280
        assert int.from_bytes(png[20:24], "big") == 797


class TestCompactBrowserDocsDump:
    def test_passthrough_small_or_non_docs(self):
        from evoflow.plugins.node_repl_tool import _maybe_compact_browser_docs_dump

        assert _maybe_compact_browser_docs_dump("hi") == "hi"
        big = "x" * 8000
        assert _maybe_compact_browser_docs_dump(big) == big

    def test_replaces_zcode_full_dump_keeps_tail(self):
        from evoflow.plugins.node_repl_tool import (
            _EVOFLOW_COMPACT_BROWSER_DOCS,
            _maybe_compact_browser_docs_dump,
        )

        fake = (
            "# Selected Browser\n"
            + ("x" * 7000)
            + "\n# Built-in Browser Automation API\n"
            + ("y" * 1000)
        )
        out = _maybe_compact_browser_docs_dump(fake)
        assert out == _EVOFLOW_COMPACT_BROWSER_DOCS
        assert "EvoFlow compact API guide" in out
        assert len(out) < len(fake)

        with_tail = fake + '\n==> {"ok": true, "title": "Shanghai"}'
        out2 = _maybe_compact_browser_docs_dump(with_tail)
        assert out2.startswith(_EVOFLOW_COMPACT_BROWSER_DOCS)
        assert '==> {"ok": true' in out2
