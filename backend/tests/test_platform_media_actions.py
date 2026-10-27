"""Platform media.* catalog / preview wiring (no live Ark calls)."""

from __future__ import annotations

from evoflow.admin.platform_actions import PLATFORM_DOMAINS, get_registry
from evoflow.admin.platform_media import media_catalog
from evoflow.admin.platform_ui_feedback import _media_preview_items, build_platform_ui_feedback
from evoflow.admin.platform_actions import PlatformAction


def test_media_domain_registered():
    assert "media" in PLATFORM_DOMAINS
    reg = get_registry()
    for name in (
        "media.catalog",
        "media.status",
        "media.generate_image",
        "media.generate_video",
        "media.task_wait",
    ):
        assert name in reg
        assert reg[name].domain == "media"


def test_media_catalog_shape():
    cat = media_catalog()
    assert cat.get("ok") is True
    assert "image" in (cat.get("interfaces") or {})
    assert "video" in (cat.get("interfaces") or {})
    assert (cat.get("interfaces") or {})["image"]["pattern"] == "sync_poll"
    assert (cat.get("interfaces") or {})["video"]["pattern"] == "async_task"
    assert (cat.get("defaults") or {}).get("image_provider") == "jimeng"
    models = cat.get("models") or {}
    assert any(m.get("id") == "doubao-seedream-5-0-pro" for m in (models.get("image") or []))
    assert any(str(m.get("id") or "").startswith("doubao-seedance-") for m in (models.get("video") or []))
    assert any(m.get("id") == "gpt-image-2.5-sunburst" for m in (models.get("image") or []))
    assert any(m.get("id") == "MiniMax-H3" for m in (models.get("video") or []))
    assert cat.get("credentials")
    assert cat.get("input_image_formats")
    assert "openai" in str(cat.get("key_routing") or "")
    video_params = ((cat.get("interfaces") or {}).get("video") or {}).get("params") or {}
    assert "model" in video_params
    assert "first_frame_url" in video_params
    assert "resolution" in video_params
    assert cat.get("how_to_discover")
    assert (cat.get("interfaces") or {})["video"].get("examples")


def test_provider_for_model_routing():
    from evoflow.community.media_generation.provider_registry import provider_for_model, vendor_for_provider

    assert provider_for_model("gpt-image-2.5-sunburst", capability="image") == "openai"
    assert provider_for_model("gpt-image-2.5-flare", capability="image") == "openai"
    assert provider_for_model("MiniMax-H3", capability="video") == "minimax"
    assert provider_for_model("MiniMax-H3-Max", capability="video") == "minimax"
    assert provider_for_model("wan2.7-i2v", capability="video") == "wan"
    assert provider_for_model("doubao-seedream-5-0-pro", capability="image") == "jimeng"
    assert vendor_for_provider("openai") == "openai-image"
    assert vendor_for_provider("minimax") == "minimax"


def test_media_url_resolver_rejects_raw_base64():
    from evoflow.community.media_generation.media_url_resolver import resolve_media_reference_url

    # Must be long enough to match the naked-base64 heuristic (≥64 chars).
    naked = "A" * 80
    try:
        resolve_media_reference_url(
            naked,
            runtime=None,
            provider="jimeng",
            purpose="first_frame",
            media_kind="image",
            outputs_dir=None,
        )
        raised = False
    except ValueError as exc:
        raised = True
        assert "base64" in str(exc).lower() or "data:" in str(exc).lower()
    assert raised


def test_media_preview_items_from_result():
    items = _media_preview_items(
        {
            "ok": True,
            "media_kind": "image",
            "absolute_path": r"D:\ws\outputs\media_image_1.png",
            "url": "https://example.com/a.png",
        }
    )
    assert len(items) == 1
    assert items[0]["kind"] == "image"
    assert items[0]["artifactUri"].endswith("media_image_1.png")


def test_build_ui_feedback_attaches_media():
    entry = PlatformAction(
        name="media.generate_image",
        domain="media",
        summary="生成图片",
        risk="write",
        params="prompt",
        handler=lambda _a: {},
    )
    ui = build_platform_ui_feedback(
        entry,
        {"prompt": "a cat"},
        {
            "ok": True,
            "action": "media.generate_image",
            "status": "succeeded",
            "absolute_path": "/tmp/out/cat.png",
            "media_kind": "image",
        },
    )
    assert ui is not None
    assert ui.get("action") == "media.generate_image"
    assert isinstance(ui.get("media"), list) and ui["media"]
    assert ui["media"][0]["kind"] == "image"
