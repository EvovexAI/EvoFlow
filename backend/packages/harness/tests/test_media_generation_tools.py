"""Media generation tool schemas and helpers."""

import json
from pathlib import Path

from langchain_core.utils.function_calling import convert_to_openai_tool

from evoflow.community.media_generation.schemas import MediaToolResponse, error_response, success_response
from evoflow.community.media_generation.subtitle_utils import build_srt_from_text, split_sentences
from evoflow.community.media_generation.tools import (
    media_image_generate_tool,
    media_subtitle_build_tool,
    media_task_wait_tool,
    media_video_generate_tool,
)

_MEDIA_TOOLS = [
    media_image_generate_tool,
    media_video_generate_tool,
    media_task_wait_tool,
    media_subtitle_build_tool,
]


def test_media_tools_openai_schema_no_runtime_in_properties():
    for tool in _MEDIA_TOOLS:
        schema = convert_to_openai_tool(tool)
        props = schema.get("function", {}).get("parameters", {}).get("properties", {})
        assert "runtime" not in props, f"{tool.name} must not expose runtime in schema"


def test_media_image_generate_has_provider_enum():
    schema = convert_to_openai_tool(media_image_generate_tool)
    props = schema["function"]["parameters"]["properties"]
    assert "provider" in props
    assert "prompt" in props


def test_success_response_json():
    raw = success_response(provider="wan", task_id="t-1", status="processing")
    data = json.loads(raw)
    assert data["ok"] is True
    assert data["task_id"] == "t-1"


def test_error_response_json():
    raw = error_response("missing key")
    data = json.loads(raw)
    assert data["ok"] is False
    assert "missing" in data["message"]
    assert data["_evoflow_tool"]["status"] == "error"


def test_media_error_response_logs_as_observability_error():
    from langchain_core.messages import ToolMessage

    from evoflow.agents.middlewares.tool_error_handling_middleware import _completed_tool_should_log_as_error
    from evoflow.agents.tool_response_envelope import envelope_status_kind, parse_tool_envelope

    raw = error_response("Jimeng/Ark 401: invalid key")
    meta = parse_tool_envelope(raw)
    assert envelope_status_kind(meta) == "error"
    msg = ToolMessage(content=raw, tool_call_id="tc-1")
    assert _completed_tool_should_log_as_error(msg, raw) is True


def test_build_srt_from_text():
    srt = build_srt_from_text("你好。世界。", total_duration=4.0)
    assert "00:00:00" in srt
    assert "你好" in srt


def test_split_sentences():
    parts = split_sentences("A. B! C?")
    assert len(parts) == 3


def test_jimeng_image_size_meets_seedream_minimum():
    from evoflow.community.media_generation.aspect_ratio import (
        MIN_JIMENG_PIXELS,
        ensure_jimeng_image_size,
        jimeng_image_size,
    )

    for ratio in ("16:9", "9:16", "1:1", "4:3", "3:4"):
        size = jimeng_image_size(ratio)
        w, h = map(int, size.lower().split("x"))
        assert w * h >= MIN_JIMENG_PIXELS
    bumped = ensure_jimeng_image_size("1280x720", aspect_ratio="16:9")
    bw, bh = map(int, bumped.lower().split("x"))
    assert bw * bh >= MIN_JIMENG_PIXELS


def test_submit_video_jimeng_ignores_audio_url(monkeypatch):
    import evoflow.community.media_generation.tools as mod

    captured: dict = {}

    def fake_submit(**kwargs):
        captured.update(kwargs)
        return "task-jimeng-1"

    monkeypatch.setattr(mod.jimeng_provider, "submit_video", fake_submit)
    mod._submit_video(
        "jimeng",
        prompt="zoom in",
        mode="text2video",
        first_frame_url=None,
        audio_url="https://example.com/voice.mp3",
        duration=10,
        aspect_ratio="16:9",
        generate_audio=True,
    )
    assert "audio_url" not in captured
    assert captured.get("generate_audio") is True


def test_media_tool_response_model():
    m = MediaToolResponse(ok=True, provider="kling", next_action="wait")
    assert "kling" in m.to_json()


def test_wan_submit_image_accepts_aspect_ratio_directly(monkeypatch):
    """Old tools.py passed aspect_ratio straight through; provider must accept it."""
    import evoflow.community.media_generation.providers.dashscope_wan as wan

    captured: dict = {}

    def fake_request(method, path, body=None):
        captured["body"] = body
        return {"output": {"task_id": "task-wan-1"}}

    monkeypatch.setattr(wan, "_request", fake_request)
    wan.submit_image(prompt="cat", mode="text2image", aspect_ratio="16:9")
    assert captured["body"]["parameters"]["size"] == "1280*720"


def test_submit_image_jimeng_maps_aspect_ratio_to_size(monkeypatch):
    import evoflow.community.media_generation.tools as mod

    captured: dict = {}

    def fake_submit(**kwargs):
        captured.update(kwargs)
        return "immediate:http://example/img.png"

    monkeypatch.setattr(mod.jimeng_provider, "submit_image", fake_submit)
    mod._submit_image("jimeng", prompt="cat", mode="text2image", aspect_ratio="16:9")
    assert "aspect_ratio" not in captured
    assert captured.get("size") == "2560x1440"


def test_submit_image_wan_maps_aspect_ratio_to_size(monkeypatch):
    import evoflow.community.media_generation.tools as mod

    captured: dict = {}

    def fake_submit(**kwargs):
        captured.update(kwargs)
        return "task-abc"

    monkeypatch.setattr(mod.dashscope_wan, "submit_image", fake_submit)
    monkeypatch.setattr(mod, "_guard_media_provider", lambda *a, **k: None)
    mod._submit_image("wan", prompt="cat", mode="text2image", aspect_ratio="9:16")
    assert "aspect_ratio" not in captured
    assert captured.get("size") == "720*1280"


def test_media_image_generate_polls_and_returns_absolute_path(tmp_path, monkeypatch):
    """Image generate submits, waits, downloads — single tool call."""
    from unittest.mock import MagicMock

    import evoflow.community.media_generation.tools as mod

    outputs = tmp_path / "outputs"
    outputs.mkdir()
    runtime = MagicMock()
    runtime.context = {}
    runtime.config = {}
    runtime.state = {"thread_data": {"outputs_path": str(outputs)}}

    monkeypatch.setattr(mod, "_submit_image", lambda *a, **k: "task-img-1")
    monkeypatch.setattr(mod, "_poll_image", lambda *a, **k: ("succeeded", "http://cdn/x.png", ["http://cdn/x.png"]))
    monkeypatch.setattr(mod, "resolve_image_provider", lambda explicit, **k: ("jimeng", None))
    monkeypatch.setattr(
        mod,
        "save_media_from_urls",
        lambda urls, out_dir, **kw: [str((out_dir / "media_image_task.png").resolve())],
    )

    raw = mod.media_image_generate_tool.func(
        runtime,
        prompt="cat",
        provider=None,
        mode="text2image",
        aspect_ratio="16:9",
        reference_image_urls=None,
        max_wait_seconds=30,
    )
    data = json.loads(raw)
    assert data["ok"] is True
    assert data["status"] == "succeeded"
    ap = data.get("absolute_path") or data.get("local_path")
    assert ap
    assert Path(ap).is_absolute()
    assert "outputs" in ap.replace("\\", "/")


def test_media_image_generate_saves_under_bound_workspace_not_sandbox(tmp_path, monkeypatch):
    """Regression: must not save to thread sandbox when session binds local_workspace_root."""
    from unittest.mock import MagicMock

    import evoflow.community.media_generation.tools as mod

    ws = tmp_path / "myproj"
    ws.mkdir()
    sandbox_out = tmp_path / "sandbox" / "outputs"
    sandbox_out.mkdir(parents=True)

    class _Ctx:
        def get(self, k, d=None):
            data = {
                "local_workspace_root": str(ws),
                "use_virtual_paths": False,
                "thread_id": "t-bound",
            }
            return data.get(k, d)

    runtime = MagicMock()
    runtime.context = _Ctx()
    runtime.config = {"configurable": {"local_workspace_root": str(ws), "use_virtual_paths": False}}
    runtime.state = {"thread_data": {"outputs_path": str(sandbox_out)}}

    monkeypatch.setattr(mod, "_submit_image", lambda *a, **k: "task-img-2")
    monkeypatch.setattr(mod, "_poll_image", lambda *a, **k: ("succeeded", "http://cdn/y.png", ["http://cdn/y.png"]))
    monkeypatch.setattr(mod, "resolve_image_provider", lambda explicit, **k: ("jimeng", None))
    monkeypatch.setattr(
        mod,
        "save_media_from_urls",
        lambda urls, out_dir, **kw: [str((out_dir / "media_image_task.png").resolve())],
    )

    raw = mod.media_image_generate_tool.func(
        runtime,
        prompt="cat",
        provider=None,
        mode="text2image",
        aspect_ratio="16:9",
        reference_image_urls=None,
        max_wait_seconds=30,
    )
    data = json.loads(raw)
    ap = str(data.get("absolute_path") or data.get("local_path") or "")
    assert ap
    norm = ap.replace("\\", "/")
    assert f"{ws.name}/outputs" in norm or str(ws / "outputs").replace("\\", "/") in norm
    assert str(sandbox_out).replace("\\", "/") not in norm


def test_media_image_generate_exception_returns_error_json(monkeypatch):
    """Except path must call error_response (regression: NameError when import missing)."""
    from unittest.mock import MagicMock

    import evoflow.community.media_generation.tools as mod

    def _boom(*_a, **_k):
        raise ValueError("Set KLING_ACCESS_KEY_ID + KLING_ACCESS_KEY_SECRET or KLING_API_KEY")

    monkeypatch.setenv("KLING_ACCESS_KEY_ID", "ak-test")
    monkeypatch.setenv("KLING_ACCESS_KEY_SECRET", "sk-test")
    monkeypatch.setattr(
        "evoflow.persistence.media_settings.cfg_repo.get_app_setting",
        lambda key: {
            "media.credentials": {
                "klingAccessKeyId": "ak-test",
                "klingAccessKeySecret": "sk-test",
                "enabledVendors": {"kling": True, "volcengine": False, "dashscope": False},
            }
        }.get(key),
    )
    monkeypatch.setattr(mod, "_submit_image", _boom)
    raw = mod.media_image_generate_tool.func(
        MagicMock(),
        prompt="test banner",
        provider="kling",
        mode="text2image",
        aspect_ratio="16:9",
        reference_image_urls=None,
    )
    data = json.loads(raw)
    assert data["ok"] is False
    assert "KLING" in data["message"]


def test_prepare_image_prompt_trims_at_sentence_boundary():
    import evoflow.community.media_generation.tools as mod

    long_prompt = "First sentence. " + ("More detail. " * 60) + "Tail must drop."
    assert len(long_prompt) > mod._MAX_IMAGE_PROMPT_CHARS
    fitted, note = mod._prepare_image_prompt(long_prompt)
    assert len(fitted) <= mod._MAX_IMAGE_PROMPT_CHARS
    assert note is not None
    assert "Tail must drop" not in fitted


def test_media_image_generate_trims_long_prompt(monkeypatch):
    from unittest.mock import MagicMock

    import evoflow.community.media_generation.tools as mod

    monkeypatch.setattr(mod, "resolve_image_provider", lambda explicit, **k: ("jimeng", None))
    captured: dict = {}

    def _fake_run(_rt, **kwargs):
        captured["prompt"] = kwargs.get("prompt")
        return mod.success_response(provider="jimeng", status="succeeded", url="https://x/img.jpg")

    monkeypatch.setattr(mod, "_run_image_generate_and_wait", _fake_run)
    long_prompt = "暗色房间。" + ("细节描述。" * 120)
    raw = mod.media_image_generate_tool.func(
        MagicMock(),
        prompt=long_prompt,
        provider=None,
        mode="text2image",
        aspect_ratio="16:9",
        reference_image_urls=None,
    )
    data = json.loads(raw)
    assert data["ok"] is not False
    assert len(captured["prompt"]) <= 500
    assert data.get("prompt_trimmed") is True
    assert "prompt_trim_note" in data


def test_media_video_generate_jimeng_rejects_text2video(monkeypatch):
    from unittest.mock import MagicMock

    import evoflow.community.media_generation.tools as mod

    monkeypatch.setattr(mod, "resolve_video_provider", lambda explicit, **k: ("jimeng", None))
    raw = mod.media_video_generate_tool.func(
        MagicMock(),
        prompt="zoom in slowly",
        mode="text2video",
        provider="jimeng",
        first_frame_url=None,
        audio_url=None,
        duration=5,
        aspect_ratio="16:9",
        generate_audio=True,
    )
    data = json.loads(raw)
    assert data["ok"] is False
    assert "text2video" in data["message"] or "image2video" in data["message"]


def test_media_voiceover_jimeng_pipeline_hint_when_tts_disabled(monkeypatch):
    from unittest.mock import MagicMock

    import evoflow.community.media_generation.tools as mod

    monkeypatch.setattr(
        mod,
        "resolve_voice_provider",
        lambda explicit, **k: ("volcengine", "媒体 provider 'volcengine' 已停用"),
    )
    monkeypatch.setattr("evoflow.community.media_generation.config_helpers.is_jimeng_configured", lambda: True)
    monkeypatch.setattr("evoflow.community.media_generation.config_helpers.configured_voice_providers", lambda: [])
    raw = mod.media_voiceover_synthesize_tool.func(
        MagicMock(),
        text="hello",
        provider=None,
        output_filename="voiceover.mp3",
    )
    data = json.loads(raw)
    assert data["ok"] is False
    assert "media_video_generate" in data["message"]
