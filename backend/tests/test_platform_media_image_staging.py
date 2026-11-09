"""platform 生图成片自动进下一轮上下文（viewed_images auto staging）：

- ``_stage_media_result_images``：media.generate_image / media.task_wait 的
  本地图片 → ``stage_image_entry`` auto 条目；视频 / 失败结果 / 非本地路径 /
  无视觉主模型自动退化（返回 None，工具回退纯文本 payload）。
- ``command_with_staged_images``：带真实 tool_call_id 时以 Command 回填
  ``viewed_images``；直连无 id 时退化为纯文本。
- ``ViewImageMiddleware``：注入文案按 stage label 区分「生图成片」与
  「屏幕截图」，避免把生图叫成 computer control 截图。
"""

from __future__ import annotations

import io
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.types import Command
from PIL import Image

from evoflow.agents.image_staging import command_with_staged_images
from evoflow.agents.middlewares.view_image_middleware import ViewImageMiddleware
from evoflow.tools.builtins.platform_tool import _stage_media_result_images


def _png_file(tmp_path: Path, name: str = "gen.png") -> str:
    buf = io.BytesIO()
    Image.new("RGB", (64, 48), (90, 20, 160)).save(buf, format="PNG")
    p = tmp_path / name
    p.write_bytes(buf.getvalue())
    return str(p)


def _gen_blob(path: str, **overrides):
    blob = {
        "ok": True,
        "provider": "jimeng",
        "status": "succeeded",
        "media_kind": "image",
        "absolute_path": path,
        "local_path": path,
        "url": "https://example.com/gen.png",
        "message": "Saved",
    }
    blob.update(overrides)
    return blob


@pytest.fixture()
def vision_enabled():
    # 路由判定（image_routing）与中间件门控各自导入 main_model_supports_vision，
    # 两处都要 patch 才代表「主模型支持视觉」（对齐 test_node_repl_screenshot_staging）。
    with patch(
        "evoflow.agents.middlewares.view_image_middleware.main_model_supports_vision",
        return_value=True,
    ), patch("evoflow.agents.image_routing.main_model_supports_vision", return_value=True):
        yield


class TestStageMediaResultImages:
    def test_generate_image_stages_local_png(self, tmp_path: Path, vision_enabled):
        path = _png_file(tmp_path)
        staged = _stage_media_result_images("media.generate_image", _gen_blob(path), None)
        assert staged is not None and list(staged.keys()) == [path]
        entry = staged[path]
        assert entry["auto"] is True
        assert entry["mime_type"] == "image/png"
        assert entry["label"] == "generated image"

        # 带 tool_call_id → Command 回填；无 id → 退化为纯文本
        payload = json.dumps(_gen_blob(path), ensure_ascii=False)
        out = command_with_staged_images(payload, "call-1", staged)
        assert isinstance(out, Command)
        assert out.update["viewed_images"] == staged
        assert command_with_staged_images(payload, "", staged) == payload

    def test_jpeg_extension_maps_mime(self, tmp_path: Path, vision_enabled):
        path = _png_file(tmp_path, "gen.jpg")
        staged = _stage_media_result_images("media.generate_image", _gen_blob(path), None)
        assert staged is not None
        assert staged[path]["mime_type"] == "image/jpeg"

    def test_video_task_wait_not_staged(self, tmp_path: Path, vision_enabled):
        mp4 = tmp_path / "clip.mp4"
        mp4.write_bytes(b"\x00\x00\x00\x18ftypmp42")
        blob = _gen_blob(str(mp4), media_kind="video")
        assert _stage_media_result_images("media.task_wait", blob, None) is None

    def test_failure_blob_not_staged(self, tmp_path: Path, vision_enabled):
        blob = _gen_blob(str(tmp_path / "nope.png"), ok=False, error="timeout")
        assert _stage_media_result_images("media.generate_image", blob, None) is None

    def test_unrelated_action_not_staged(self, tmp_path: Path, vision_enabled):
        path = _png_file(tmp_path)
        assert _stage_media_result_images("assets.record", _gen_blob(path), None) is None

    def test_missing_local_file_not_staged(self, tmp_path: Path, vision_enabled):
        blob = _gen_blob(str(tmp_path / "ghost.png"))
        assert _stage_media_result_images("media.generate_image", blob, None) is None

    def test_remote_only_result_not_staged(self, vision_enabled):
        blob = _gen_blob("", url="https://cdn.example.com/remote.png")
        blob.pop("absolute_path")
        blob.pop("local_path")
        assert _stage_media_result_images("media.generate_image", blob, None) is None

    def test_extra_local_paths_dedupe_and_cap(self, tmp_path: Path, vision_enabled):
        primary = _png_file(tmp_path, "p.png")
        paths = [primary] + [_png_file(tmp_path, f"m{i}.png") for i in range(6)]
        blob = _gen_blob(primary, extra={"local_paths": paths})
        staged = _stage_media_result_images("media.generate_image", blob, None)
        assert staged is not None
        assert len(staged) == 4  # 去重后 primary 优先，封顶 4
        assert primary in staged

    def test_no_vision_model_degrades_to_none(self, tmp_path: Path):
        path = _png_file(tmp_path)
        blob = _gen_blob(path)
        with patch(
            "evoflow.tools.builtins.vision_analysis_core.main_model_supports_vision",
            return_value=False,
        ), patch(
            "evoflow.agents.image_routing.main_model_supports_vision",
            return_value=False,
        ), patch(
            "evoflow.config.get_app_config",
            return_value=SimpleNamespace(primary_model=""),
        ):
            assert _stage_media_result_images("media.generate_image", blob, None) is None


def _turn_messages(tool_name: str = "platform") -> list:
    ai = AIMessage(
        content="",
        tool_calls=[{"name": tool_name, "args": {"action": "media.generate_image"}, "id": "call-1"}],
    )
    return [
        HumanMessage(content="画一只猫"),
        ai,
        ToolMessage(content="ok", tool_call_id="call-1"),
    ]


class TestGeneratedImageInjectHeader:
    def test_generated_label_uses_generation_wording(self, tmp_path: Path, vision_enabled):
        img_path = _png_file(tmp_path, "gen.png")
        state = {
            "messages": _turn_messages(),
            "viewed_images": {
                img_path: {"path": img_path, "mime_type": "image/png", "auto": True, "label": "generated image"}
            },
        }
        mw = ViewImageMiddleware()
        update = mw._inject_image_message(state, runtime=None)
        assert update is not None
        texts = [b.get("text", "") for b in update["messages"][0].content if isinstance(b, dict)]
        joined = "\n".join(texts)
        assert "images you just generated" in joined
        assert "screen captures" not in joined

    def test_screenshot_label_keeps_capture_wording(self, tmp_path: Path, vision_enabled):
        img_path = _png_file(tmp_path, "shot.png")
        state = {
            "messages": _turn_messages(),
            "viewed_images": {
                img_path: {"path": img_path, "mime_type": "image/png", "auto": True, "label": "browser screenshot"}
            },
        }
        mw = ViewImageMiddleware()
        update = mw._inject_image_message(state, runtime=None)
        assert update is not None
        texts = [b.get("text", "") for b in update["messages"][0].content if isinstance(b, dict)]
        joined = "\n".join(texts)
        assert "screen captures" in joined

    def test_mixed_labels_fall_back_to_capture_wording(self, tmp_path: Path, vision_enabled):
        a = _png_file(tmp_path, "a.png")
        b = _png_file(tmp_path, "b.png")
        state = {
            "messages": _turn_messages(),
            "viewed_images": {
                a: {"path": a, "mime_type": "image/png", "auto": True, "label": "generated image"},
                b: {"path": b, "mime_type": "image/png", "auto": True, "label": "browser screenshot"},
            },
        }
        mw = ViewImageMiddleware()
        update = mw._inject_image_message(state, runtime=None)
        assert update is not None
        texts = [t.get("text", "") for t in update["messages"][0].content if isinstance(t, dict)]
        assert "screen captures" in "\n".join(texts)
