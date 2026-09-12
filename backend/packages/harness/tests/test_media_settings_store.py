"""Media credentials persistence and masking."""

from evoflow.persistence.media_settings import (
    DEFAULT_MEDIA_CREDENTIALS,
    get_media_credentials,
    get_media_credentials_masked,
    patch_media_credentials,
)


def test_patch_and_mask_secrets(monkeypatch):
    store: dict = {}

    def fake_get(key):
        return store.get(key)

    def fake_set(key, value):
        store[key] = value

    monkeypatch.setattr(
        "evoflow.persistence.media_settings.cfg_repo.get_app_setting",
        fake_get,
    )
    monkeypatch.setattr(
        "evoflow.persistence.media_settings.cfg_repo.set_app_setting",
        fake_set,
    )

    patch_media_credentials({"dashscopeApiKey": "sk-test-dashscope-1234"})
    masked = get_media_credentials_masked()
    assert masked["dashscopeApiKey"].endswith("1234")
    assert "*" in masked["dashscopeApiKey"]
    assert masked["_configured"]["dashscopeApiKey"] is True

    raw = get_media_credentials()
    assert raw["dashscopeApiKey"] == "sk-test-dashscope-1234"


def test_patch_empty_secret_keeps_previous(monkeypatch):
    store: dict = {"media.credentials": {"klingAccessKeySecret": "secret-old"}}

    monkeypatch.setattr(
        "evoflow.persistence.media_settings.cfg_repo.get_app_setting",
        lambda key: store.get(key),
    )

    def fake_set(key, value):
        store[key] = value

    monkeypatch.setattr(
        "evoflow.persistence.media_settings.cfg_repo.set_app_setting",
        fake_set,
    )

    patch_media_credentials({"klingAccessKeySecret": ""})
    assert get_media_credentials()["klingAccessKeySecret"] == "secret-old"


def test_defaults_shape():
    assert "dashscopeApiKey" in DEFAULT_MEDIA_CREDENTIALS
    assert "volcengineTtsAppId" in DEFAULT_MEDIA_CREDENTIALS
    assert DEFAULT_MEDIA_CREDENTIALS["jimengImageModel"] == "doubao-seedream-5.0-lite"
    assert DEFAULT_MEDIA_CREDENTIALS["jimengVideoModel"] == "doubao-seedance-2.0"


def test_get_vendor_credentials_by_alias(monkeypatch):
    store: dict = {}

    monkeypatch.setattr(
        "evoflow.persistence.media_settings.cfg_repo.get_app_setting",
        lambda key: store.get(key),
    )
    monkeypatch.setattr(
        "evoflow.persistence.media_settings.cfg_repo.set_app_setting",
        lambda key, value: store.update({key: value}),
    )

    from evoflow.persistence.media_settings import (
        get_vendor_credentials,
        normalize_vendor_id,
        vendor_has_usable_credentials,
    )

    patch_media_credentials(
        {
            "agnesApiKey": "agnes-secret",
            "enabledVendors": {"agnes": True, "volcengine": False},
        }
    )
    assert normalize_vendor_id("jimeng") == "volcengine"
    bundle = get_vendor_credentials("agnes")
    assert bundle["apiKey"] == "agnes-secret"
    assert vendor_has_usable_credentials("agnes") is True
    assert get_vendor_credentials("volcengine") == {}


def test_jimeng_models_from_credentials(monkeypatch):
    store: dict = {}

    monkeypatch.setattr(
        "evoflow.persistence.media_settings.cfg_repo.get_app_setting",
        lambda key: store.get(key),
    )
    monkeypatch.setattr(
        "evoflow.persistence.media_settings.cfg_repo.set_app_setting",
        lambda key, value: store.update({key: value}),
    )

    from evoflow.community.media_generation import config_helpers as ch

    monkeypatch.setattr(ch, "_plan_media_route", lambda capability: None)

    patch_media_credentials(
        {
            "jimengImageModel": "ep-image-test",
            "jimengVideoModel": "ep-video-test",
            "enabledVendors": {"volcengine": True},
        }
    )
    assert ch.jimeng_image_model() == "ep-image-test"
    assert ch.jimeng_video_model() == "ep-video-test"
