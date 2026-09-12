import json
from pathlib import Path
from unittest.mock import MagicMock, patch

from langgraph.types import Command

from evoflow.agents.image_routing import decide_view_image_route, get_image_input_mode
from evoflow.agents.middlewares.view_image_middleware import ViewImageMiddleware
from evoflow.tools.builtins.view_image_tool import view_image_tool
from evoflow.tools.builtins.vision_analysis_core import (
    format_native_tool_result,
    format_vision_tool_result,
    main_model_supports_vision,
    prepare_image_bytes_for_native,
    resolve_vision_model_name,
)
from evoflow.tools.host_direct.workspace_path_guard import runtime_with_workspace


def test_resolve_vision_model_name_prefers_default_vision_model():
    class _Model:
        def __init__(self, name: str, supports_vision: bool):
            self.name = name
            self.supports_vision = supports_vision

    fake_config = MagicMock()
    fake_config.primary_model = "text-only"
    fake_config.models = [
        _Model("text-only", False),
        _Model("vision-pro", True),
    ]
    fake_config.get_model_config.side_effect = lambda name: next(
        (m for m in fake_config.models if m.name == name),
        None,
    )

    with (
        patch("evoflow.config.get_app_config", return_value=fake_config),
        patch(
            "evoflow.persistence.panel_settings.get_panel_settings",
            return_value={"defaultVisionModel": "vision-pro"},
        ),
        patch(
            "evoflow.tools.builtins.vision_analysis_core.model_supports_vision",
            side_effect=lambda name: name == "vision-pro",
        ),
    ):
        assert resolve_vision_model_name() == "vision-pro"


def test_decide_view_image_route_auto_native_when_main_supports_vision():
    runtime = MagicMock()
    runtime.context = {"model_name": "vision-pro"}
    with (
        patch(
            "evoflow.agents.image_routing.get_image_input_mode",
            return_value="auto",
        ),
        patch(
            "evoflow.agents.image_routing.main_model_supports_vision",
            return_value=True,
        ),
    ):
        assert decide_view_image_route(runtime=runtime) == "native"


def test_decide_view_image_route_text_mode_always_text():
    with (
        patch("evoflow.agents.image_routing.get_image_input_mode", return_value="text"),
        patch("evoflow.agents.image_routing.main_model_supports_vision", return_value=True),
    ):
        assert decide_view_image_route(runtime=MagicMock()) == "text"


def test_view_image_native_stages_path_without_base64(tmp_path: Path):
    img = tmp_path / "shot.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\n")

    rt = runtime_with_workspace(str(tmp_path), "t-view-image")
    rt.context = {"model_name": "vision-pro"}
    rt.state = {"native_viewed_image_refs": []}

    with (
        patch(
            "evoflow.tools.builtins.view_image_tool.decide_view_image_route",
            return_value="native",
        ),
        patch(
            "evoflow.tools.builtins.view_image_tool._already_native_viewed",
            return_value=False,
        ),
    ):
        out = view_image_tool.func(runtime=rt, image_path=str(img), tool_call_id="call-1")

    assert isinstance(out, Command)
    staged = out.update["viewed_images"][str(img)]
    assert staged["path"] == str(img.resolve())
    assert staged["mime_type"] == "image/png"
    assert "base64" not in staged
    payload = json.loads(out.update["messages"][0].content)
    assert payload["mode"] == "native"
    assert payload["image_ref"] == str(img)


def test_view_image_text_mode_delegates_to_vision_model(tmp_path: Path):
    img = tmp_path / "shot.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\n")

    rt = runtime_with_workspace(str(tmp_path), "t-view-image")

    with (
        patch(
            "evoflow.tools.builtins.view_image_tool.decide_view_image_route",
            return_value="text",
        ),
        patch(
            "evoflow.tools.builtins.view_image_tool.analyze_image_bytes",
            return_value={"analysis": "A login button is visible.", "vision_model": "vision-pro", "image_size_bytes": 8},
        ),
    ):
        out = view_image_tool.func(runtime=rt, image_path=str(img), tool_call_id="call-2")

    assert isinstance(out, str)
    payload = json.loads(out)
    assert payload["mode"] == "text"
    assert payload["analysis"] == "A login button is visible."
    assert payload["vision_model"] == "vision-pro"


def test_view_image_native_dedup_returns_cached(tmp_path: Path):
    img = tmp_path / "shot.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\n")
    rt = runtime_with_workspace(str(tmp_path), "t-view-image")
    rt.state = {"native_viewed_image_refs": [str(img)]}

    with patch(
        "evoflow.tools.builtins.view_image_tool.decide_view_image_route",
        return_value="native",
    ):
        out = view_image_tool.func(runtime=rt, image_path=str(img), tool_call_id="call-3")

    payload = json.loads(out.update["messages"][0].content)
    assert payload["cached"] is True


def test_view_image_middleware_injects_from_path_not_checkpoint_base64(tmp_path: Path):
    img = tmp_path / "a.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\n")

    middleware = ViewImageMiddleware()
    runtime = MagicMock()
    runtime.context = {"model_name": "vision-pro"}

    with (
        patch(
            "evoflow.agents.middlewares.view_image_middleware.main_model_supports_vision",
            return_value=True,
        ),
        patch.object(middleware, "_should_inject_image_message", return_value=True),
    ):
        update = middleware._inject_image_message(
            {
                "viewed_images": {
                    str(img): {"path": str(img), "mime_type": "image/png", "is_remote": False},
                }
            },
            runtime,
        )

    assert update is not None
    assert update["viewed_images"] == {}
    blocks = update["messages"][0].content
    assert any(
        isinstance(b, dict) and b.get("type") == "image_url" and "data:image" in str(b.get("image_url", {}).get("url", ""))
        for b in blocks
    )
    assert any("[Image attached at:" in str(b.get("text", "")) for b in blocks if isinstance(b, dict))


def test_view_image_middleware_skips_injection_for_non_vision_model():
    middleware = ViewImageMiddleware()
    runtime = MagicMock()
    runtime.context = {"model_name": "text-only"}

    with patch(
        "evoflow.agents.middlewares.view_image_middleware.main_model_supports_vision",
        return_value=False,
    ):
        update = middleware._inject_image_message(
            {
                "viewed_images": {
                    "a.png": {"path": "a.png", "mime_type": "image/png", "is_remote": False},
                }
            },
            runtime,
        )

    assert update == {"viewed_images": {}}


def test_format_native_tool_result_has_no_base64():
    out = format_native_tool_result(
        image_ref="/tmp/a.png",
        mime_type="image/png",
        image_size_bytes=123,
    )
    payload = json.loads(out)
    assert payload["mode"] == "native"
    assert "base64" not in out.lower()


def test_format_vision_tool_result_includes_error():
    out = format_vision_tool_result({"error": "no model"}, image_ref="/tmp/a.png")
    payload = json.loads(out)
    assert payload["mode"] == "text"
    assert payload["error"] == "no model"
    assert payload["image_ref"] == "/tmp/a.png"


def test_prepare_image_bytes_for_native_returns_bytes():
    raw = b"\x89PNG\r\n\x1a\n" + b"\0" * 32
    out, mime = prepare_image_bytes_for_native(raw, "image/png")
    assert isinstance(out, bytes)
    assert mime


def test_main_model_supports_vision_reads_runtime_context():
    runtime = MagicMock()
    runtime.context = {"model_name": "vision-pro"}
    with patch(
        "evoflow.tools.builtins.vision_analysis_core.model_supports_vision",
        return_value=True,
    ) as mocked:
        assert main_model_supports_vision(runtime) is True
        mocked.assert_called_once_with("vision-pro")


def test_get_image_input_mode_defaults_auto():
    with patch(
        "evoflow.persistence.panel_settings.get_panel_settings",
        return_value={},
    ):
        assert get_image_input_mode() == "auto"
