from evoflow.models.credential_sanitize import (
    bind_chat_model_http_clients,
    patch_chat_model_instance_credentials,
    rebuild_chat_model_http_clients,
    reset_chat_model_http_clients,
    resolve_and_sanitize_api_key,
    resolve_credential_reference,
    sanitize_api_key,
    sanitize_base_url,
    sanitize_default_headers,
    sanitize_http_header_value,
    sanitize_model_connection_settings,
    sanitize_model_document,
)


def test_sanitize_api_key_strips_outer_whitespace():
    assert sanitize_api_key("  sk-test  ") == "sk-test"


def test_sanitize_api_key_removes_internal_whitespace():
    assert sanitize_api_key("sk-\ntest key") == "sk-testkey"


def test_sanitize_api_key_removes_non_ascii():
    assert sanitize_api_key("sk-test中文备注") == "sk-test"


def test_sanitize_api_key_empty_after_strip():
    assert sanitize_api_key("   ") is None


def test_resolve_credential_reference_env(monkeypatch):
    monkeypatch.setenv("TEST_MODEL_KEY", " sk-abc \n")
    assert resolve_credential_reference("$TEST_MODEL_KEY") == "sk-abc"


def test_resolve_and_sanitize_api_key_env(monkeypatch):
    monkeypatch.setenv("TEST_MODEL_KEY", " sk-abc 中文")
    assert resolve_and_sanitize_api_key("$TEST_MODEL_KEY") == "sk-abc"


def test_sanitize_base_url():
    assert sanitize_base_url(" https://api.example.com/v1 \n") == "https://api.example.com/v1"


def test_sanitize_http_header_value():
    assert sanitize_http_header_value(" Bearer token ") == "Bearer token"
    assert sanitize_http_header_value("Bearer 中文") == "Bearer"


def test_sanitize_default_headers():
    assert sanitize_default_headers({"X-Org": " demo ", "X-Note": "测试"}) == {
        "X-Org": "demo",
        "X-Note": "",
    }


def test_sanitize_model_connection_settings_in_place():
    settings = {
        "api_key": " sk-abc 123 ",
        "base_url": " https://x.com ",
        "default_headers": {"Authorization": "Bearer sk-中文"},
        "temperature": 0.2,
    }
    sanitize_model_connection_settings(settings)
    assert settings["api_key"] == "sk-abc123"
    assert settings["base_url"] == "https://x.com"
    assert settings["default_headers"] == {"Authorization": "Bearer sk-"}
    assert settings["temperature"] == 0.2


def test_sanitize_model_document_keeps_env_ref():
    doc = sanitize_model_document({"name": "m1", "api_key": " $MY_KEY ", "base_url": " https://x.com "})
    assert doc["api_key"] == "$MY_KEY"
    assert doc["base_url"] == "https://x.com"


def test_sanitize_model_document_cleans_literal_key():
    doc = sanitize_model_document({"name": "m1", "api_key": " sk-1 2 中文 "})
    assert doc["api_key"] == "sk-12"


def test_sanitize_model_document_defaults_max_tokens_to_64k():
    doc = sanitize_model_document({"name": "m1", "api_key": "sk-x"})
    assert doc["max_tokens"] == 65536


def test_sanitize_api_key_rejects_masked_gateway_value():
    assert sanitize_api_key("****abcd") is None


def test_sanitize_model_document_drops_masked_api_key():
    doc = sanitize_model_document({"name": "m1", "api_key": "****abcd"})
    assert "api_key" not in doc or doc.get("api_key") is None


def test_sanitize_model_document_upgrades_legacy_8192_max_tokens():
    doc = sanitize_model_document({"name": "m1", "api_key": "sk-x", "max_tokens": 8192})
    assert doc["max_tokens"] == 65536


def test_sanitize_model_document_strips_reserved_model_config_key():
    doc = sanitize_model_document(
        {"name": "m1", "api_key": "sk-x", "model_config": {"extra": "allow"}}
    )
    assert "model_config" not in doc


class _FakeChatModel:
    def __init__(self, api_key: str):
        self.api_key = api_key
        self.client = object()


def test_patch_chat_model_instance_credentials():
    model = _FakeChatModel(" sk-bad 中文 ")
    patch_chat_model_instance_credentials(model)
    assert model.api_key.get_secret_value() == "sk-bad"
    assert model.client is None


class _BoundModel:
    def __init__(self, inner: _FakeChatModel):
        self.bound = inner
        self.async_client = object()
        self.http_async_client = None
        self.http_client = None


class _OpenAICompatModel:
    def __init__(self) -> None:
        self.async_client = object()
        self.http_async_client = None
        self.http_client = None

    def validate_environment(self) -> None:
        if self.http_async_client is not None and self.async_client is None:
            self.async_client = object()


def test_reset_chat_model_http_clients_walks_bound_wrappers():
    inner = _FakeChatModel("sk-x")
    wrapper = _BoundModel(inner)
    wrapper.async_client = object()
    inner.client = object()
    reset_chat_model_http_clients(wrapper)
    assert wrapper.async_client is None
    assert inner.client is None


def test_bind_chat_model_http_clients_after_reset():
    inner = _FakeChatModel("sk-x")
    wrapper = _BoundModel(inner)
    wrapper.http_async_client = None
    wrapper.http_client = None
    reset_chat_model_http_clients(wrapper)
    async_client = object()
    sync_client = object()
    bind_chat_model_http_clients(
        wrapper,
        http_async_client=async_client,
        http_client=sync_client,
    )
    assert wrapper.http_async_client is async_client
    assert wrapper.http_client is sync_client
    assert wrapper.async_client is None


def test_bind_chat_model_http_clients_rebuilds_async_client():
    model = _OpenAICompatModel()
    reset_chat_model_http_clients(model)
    assert model.async_client is None
    async_client = object()
    bind_chat_model_http_clients(model, http_async_client=async_client)
    assert model.http_async_client is async_client
    assert model.async_client is not None


def test_rebuild_chat_model_http_clients():
    model = _OpenAICompatModel()
    reset_chat_model_http_clients(model)
    model.http_async_client = object()
    rebuild_chat_model_http_clients(model)
    assert model.async_client is not None
