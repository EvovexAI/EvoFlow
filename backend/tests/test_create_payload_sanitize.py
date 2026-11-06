"""Runtime / control-plane keys must never reach OpenAI AsyncCompletions.create().

Regression cover for the「员工派活必崩」incident:
``TypeError: AsyncCompletions.create() got an unexpected keyword argument 'confirm'``.

Leak path: platform gate flag ``confirm`` → model config extra (``extra="allow"``)
→ ``extra_json`` → model doc → ``ChatOpenAI(**kwargs)`` → ``model_kwargs`` →
``_default_params`` → ``AsyncCompletions.create()``.
"""

from __future__ import annotations

import json

from evoflow.models.create_payload_sanitize import (
    ALL_NON_VENDOR_CREATE_KEYS,
    PLATFORM_CONTROL_KEYS,
    scrub_chat_model_runtime_kwargs,
    strip_non_vendor_create_keys,
    strip_platform_control_keys,
)
from evoflow.models.patched_openai import PatchedChatOpenAI
from evoflow.models.vendor_roundtrip import VendorRoundtripChatMixin
from evoflow.persistence.row_mappers import model_doc_to_row, model_row_to_doc


def test_strip_session_key_from_create_payload():
    payload = {"model": "m", "messages": [], "session_key": "agent:xiaomi:x", "temperature": 0.2}
    strip_non_vendor_create_keys(payload, warn=False)
    assert "session_key" not in payload
    assert payload["temperature"] == 0.2


def test_patched_openai_payload_drops_bound_session_key():
    model = PatchedChatOpenAI(api_key="x", model="gpt-4o-mini", base_url="http://127.0.0.1:9/v1")
    bound = model.bind(session_key="agent:xiaomi:new-eef1354a")
    # RunnableBinding stores kwargs; resolve payload via the bound model's path.
    underlying = getattr(bound, "bound", bound)
    payload = underlying._get_request_payload(
        [{"role": "user", "content": "hi"}],
        session_key="agent:xiaomi:new-eef1354a",
    )
    assert "session_key" not in payload


def test_scrub_model_kwargs_session_key():
    model = PatchedChatOpenAI(
        api_key="x",
        model="gpt-4o-mini",
        base_url="http://127.0.0.1:9/v1",
        session_key="agent:xiaomi:leak",
    )
    assert "session_key" in (model.model_kwargs or {})
    removed = scrub_chat_model_runtime_kwargs(model)
    assert "session_key" in removed
    assert "session_key" not in (model.model_kwargs or {})


def test_model_row_mappers_drop_session_key_from_extra():
    doc = {
        "name": "deepseek-v4-flash",
        "use": "langchain_openai:ChatOpenAI",
        "model": "deepseek-v4.1-flash",
        "session_key": "agent:xiaomi:new-eef1354a",
        "fallback_models": ["glm-5.3"],
    }
    row = model_doc_to_row(doc)
    assert "session_key" not in row["extra_json"]
    poisoned = dict(row)
    # Simulate legacy DB row that still has session_key in extra_json.
    extra = json.loads(poisoned["extra_json"])
    extra["session_key"] = "agent:xiaomi:new-eef1354a"
    poisoned["extra_json"] = json.dumps(extra)
    out = model_row_to_doc(poisoned)
    assert "session_key" not in out


# --- confirm / platform control-plane regression -----------------------------


def test_confirm_is_a_non_vendor_create_key():
    assert "confirm" in PLATFORM_CONTROL_KEYS
    assert "confirm" in ALL_NON_VENDOR_CREATE_KEYS


def test_strip_confirm_from_create_payload():
    payload = {"model": "m", "messages": [], "confirm": True, "temperature": 0.2}
    strip_non_vendor_create_keys(payload, warn=False)
    assert "confirm" not in payload
    assert payload["temperature"] == 0.2


def test_strip_platform_control_keys_from_args():
    args = {"confirm": True, "confirmed": True, "dry_run": True, "name": "x"}
    strip_platform_control_keys(args)
    assert args == {"name": "x"}


def test_patched_openai_payload_drops_confirm():
    """The exact crash: confirm must not survive into the SDK create() payload."""
    model = PatchedChatOpenAI(api_key="x", model="gpt-4o-mini", base_url="http://127.0.0.1:9/v1")
    payload = model._get_request_payload([{"role": "user", "content": "hi"}], confirm=True)
    assert "confirm" not in payload


def test_vendor_mixin_strips_confirm_before_sdk():
    kwargs = {"confirm": True, "session_key": "agent:x", "temperature": 0.3}
    VendorRoundtripChatMixin._strip_control_kwargs(kwargs)
    assert "confirm" not in kwargs
    assert "session_key" not in kwargs
    # Vendor-valid params must survive.
    assert kwargs["temperature"] == 0.3


def test_model_row_mappers_drop_confirm_from_extra():
    doc = {
        "name": "claude-sonnet-5-5",
        "use": "langchain_openai:ChatOpenAI",
        "model": "claude-sonnet-5-5",
        "confirm": True,
    }
    row = model_doc_to_row(doc)
    assert "confirm" not in row["extra_json"]


def test_model_row_to_doc_heals_legacy_confirm_extra():
    """A row already poisoned with `confirm` must self-heal on read."""
    doc = {
        "name": "claude-sonnet-5-5",
        "use": "langchain_openai:ChatOpenAI",
        "model": "claude-sonnet-5-5",
    }
    row = model_doc_to_row(doc)
    poisoned = dict(row)
    extra = json.loads(poisoned["extra_json"])
    extra["confirm"] = True
    poisoned["extra_json"] = json.dumps(extra)
    out = model_row_to_doc(poisoned)
    assert "confirm" not in out


def test_factory_strips_confirm_from_constructor_kwargs():
    """The factory must not forward a stray `confirm` into ChatOpenAI(**kwargs)."""
    from evoflow.config.model_config import ModelConfig
    from evoflow.models.factory import _strip_provider_internal_keys

    cfg = ModelConfig.model_validate(
        {
            "name": "claude-sonnet-5-5",
            "use": "langchain_openai:ChatOpenAI",
            "model": "claude-sonnet-5-5",
            "confirm": True,
        }
    )
    dumped = cfg.model_dump(exclude_none=True, exclude={"name", "use", "model"})
    assert dumped.get("confirm") is True  # it is a Pydantic extra
    stripped = _strip_provider_internal_keys(dumped)
    assert "confirm" not in stripped


def test_admin_model_write_drops_confirm():
    """``settings.create_model`` must not persist the platform gate flag."""
    from evoflow.admin import models as models_admin

    captured: dict = {}

    def _fake_add(payload):
        captured.update(payload)
        from evoflow.config.model_config import ModelConfig

        return ModelConfig.model_validate(payload)

    import evoflow.admin.models as models_mod

    orig_add = models_mod.add_model_to_config
    orig_reload = models_mod.reload_models_from_db
    models_mod.add_model_to_config = _fake_add
    models_mod.reload_models_from_db = lambda: None
    try:
        models_admin.create_model(
            {
                "name": "claude-sonnet-5-5",
                "use": "langchain_openai:ChatOpenAI",
                "model": "claude-sonnet-5-5",
                "base_url": "https://vip.ai-api.cc/v1",
                "confirm": True,
            }
        )
    finally:
        models_mod.add_model_to_config = orig_add
        models_mod.reload_models_from_db = orig_reload

    assert "confirm" not in captured
    assert captured["name"] == "claude-sonnet-5-5"


def test_platform_settings_create_model_drops_confirm():
    """The platform action handler must strip ``confirm`` before persisting."""
    from evoflow.admin import platform_handlers as H

    captured: dict = {}

    def _fake_create(payload):
        captured.update(payload)
        return {"name": payload.get("name")}

    import evoflow.admin.models as models_mod

    orig = models_mod.create_model
    models_mod.create_model = _fake_create
    try:
        H.settings_create_model(
            {
                "name": "claude-sonnet-5-5",
                "use": "langchain_openai:ChatOpenAI",
                "model": "claude-sonnet-5-5",
                "confirm": True,
            }
        )
    finally:
        models_mod.create_model = orig

    assert "confirm" not in captured
