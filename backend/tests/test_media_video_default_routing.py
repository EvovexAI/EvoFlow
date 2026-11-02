"""Default video provider should respect Plan entitlements + MiniMax fallback."""

from __future__ import annotations

from unittest.mock import patch

from evoflow.community.media_generation import config_helpers as ch


def test_jimeng_video_not_configured_when_plan_lacks_video():
    with (
        patch.object(ch, "is_jimeng_configured", return_value=True),
        patch.object(ch, "jimeng_plan_video_entitled", return_value=False),
    ):
        assert ch.is_jimeng_video_configured() is False
        assert ch.is_video_provider_configured("jimeng") is False


def test_jimeng_video_configured_when_plan_has_video():
    with (
        patch.object(ch, "is_jimeng_configured", return_value=True),
        patch.object(ch, "jimeng_plan_video_entitled", return_value=True),
        patch.object(ch, "is_vendor_enabled", return_value=True),
    ):
        assert ch.is_jimeng_video_configured() is True
        assert ch.is_video_provider_configured("jimeng") is True


def test_resolve_video_falls_through_to_minimax_when_plan_small():
    with (
        patch.object(ch, "ensure_media_credentials"),
        patch.object(ch, "default_video_provider", return_value="jimeng"),
        patch.object(ch, "is_video_provider_configured", side_effect=lambda p: p == "minimax"),
        patch.object(ch, "configured_video_providers", return_value=["minimax"]),
    ):
        prov, err = ch.resolve_video_provider(None)
        assert err is None
        assert prov == "minimax"


def test_default_video_model_minimax_gateway():
    class _Fake:
        DEFAULT_GATEWAY_VIDEO_MODEL = "minimax-h3"
        DEFAULT_MINIMAX_VIDEO_MODEL = "MiniMax-H3"

        @staticmethod
        def uses_openai_videos_api(model=None):
            return True

    with patch.dict(
        "sys.modules",
        {"evoflow.community.media_generation.providers.minimax_video": _Fake()},
    ):
        # Import path uses `from ... import minimax_video as mv`
        with patch(
            "evoflow.community.media_generation.providers.minimax_video.uses_openai_videos_api",
            return_value=True,
        ), patch(
            "evoflow.community.media_generation.providers.minimax_video.DEFAULT_GATEWAY_VIDEO_MODEL",
            "minimax-h3",
        ), patch(
            "evoflow.community.media_generation.providers.minimax_video.DEFAULT_MINIMAX_VIDEO_MODEL",
            "MiniMax-H3",
        ):
            assert ch.default_video_model_for_provider("minimax") == "minimax-h3"


def test_preferred_video_provider_from_settings():
    with patch(
        "evoflow.persistence.media_settings.get_media_credentials",
        return_value={"preferredVideoProvider": "minimax"},
    ):
        assert ch.default_video_provider() == "minimax"


def test_media_catalog_defaults_follow_resolved_minimax():
    from evoflow.admin import platform_media as pm

    fake_plan = {
        "bound": True,
        "tier_id": "small",
        "capabilities": ["image", "chat"],
        "image_entitled": True,
        "video_entitled": False,
        "notes": "Small 不含视频",
        "docs_url": "",
        "catalog_id": "volcengine.agent_plan",
        "default_models": {},
    }

    with (
        patch(
            "evoflow.community.media_generation.config_helpers.available_media_providers",
            return_value={"image": ["jimeng"], "video": ["minimax"], "voice": []},
        ),
        patch(
            "evoflow.community.media_generation.config_helpers.resolve_image_provider",
            return_value=("jimeng", None),
        ),
        patch(
            "evoflow.community.media_generation.config_helpers.resolve_video_provider",
            return_value=("minimax", None),
        ),
        patch(
            "evoflow.community.media_generation.config_helpers.default_image_model_for_provider",
            return_value="doubao-seedream-5-0-pro",
        ),
        patch(
            "evoflow.community.media_generation.config_helpers.default_video_model_for_provider",
            return_value="minimax-h3",
        ),
        patch.object(pm, "_image_model_guide", return_value=[]),
        patch.object(
            pm,
            "_video_model_guide",
            return_value=[{"id": "doubao-seedance-2.5", "label": "Seedance 2.5"}],
        ),
    ):
        # Bypass live plan lookup by forcing the try-block path via bindings mock
        with patch("evoflow.plans.bindings.find_active_binding", return_value={
            "status": "active",
            "tier_id": "small",
            "bound_capabilities": ["image", "chat"],
            "catalog_id": "volcengine.agent_plan",
        }):
            with patch(
                "evoflow.plans.volc_agent_plan_models.default_media_models_for_tier",
                return_value={},
            ), patch(
                "evoflow.plans.volc_agent_plan_models.media_capability_items",
                side_effect=lambda cap: (
                    [{"id": "doubao-seedream-5-0-pro", "label": "Pro", "min_tier": "small"}]
                    if cap == "image"
                    else [{"id": "doubao-seedance-2.5", "label": "S", "min_tier": "large"}]
                ),
            ):
                cat = pm.media_catalog()

    assert cat["defaults"]["video_provider"] == "minimax"
    assert cat["defaults"]["video_model"] == "minimax-h3"
    seedance = next(m for m in cat["models"]["video"] if m.get("id") == "doubao-seedance-2.5")
    assert seedance.get("available") is False
    assert "MiniMax" in cat["assistant_guide"]["say_to_user"] or "minimax" in cat["assistant_guide"]["say_to_user"].lower()
    # silence unused
    _ = fake_plan
