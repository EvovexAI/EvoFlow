"""Exercise the public ChatGPT plan path with local callbacks and mocked OpenAI responses."""

import json
import time
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import urlopen

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from evoflow.models import chatgpt_plan_auth as auth
from evoflow.models import codex_models
from evoflow.models.openai_codex_provider import runtimeChatModel
from langchain_core.messages import AIMessageChunk, HumanMessage


@pytest.fixture(autouse=True)
def isolated_profile(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    monkeypatch.setattr(auth, "_session", None)


def test_ignores_legacy_credentials(tmp_path):
    (tmp_path / "codex_auth.json").write_text('{"access_token":"old-cli-token"}', encoding="utf-8")
    assert auth.auth_status()["logged_in"] is False
    with pytest.raises(auth.CodexAuthError, match="Authorize ChatGPT plan usage"):
        auth.access_token()


@pytest.mark.parametrize("grant_plan", [True, False])
def test_loopback_login_validates_identity_and_consent(monkeypatch, grant_plan):
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public_jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(private.public_key()))
    public_jwk.update({"kid": "test-key", "alg": "RS256"})
    monkeypatch.setattr(auth, "LOGIN_TIMEOUT", 10)

    started = auth.start_login()
    params = parse_qs(urlsplit(started["verification_url"]).query)
    assert params["client_id"] == [auth.REGISTRATION_CLIENT]
    assert params["resource"] == [auth.API_BASE]
    assert auth.PLAN_SCOPE in params["scope"][0].split()
    assert params["ext_agent_host_id"][0].startswith("urn:uuid:")
    callback = params["redirect_uri"][0]
    assert callback.startswith("http://127.0.0.1:")
    assert auth.poll_login("unknown")["status"] == "failed"

    issued = "oaiapp_test_client"
    id_token = jwt.encode(
        {
            "iss": auth.ISSUER,
            "sub": "test-user",
            "aud": issued,
            "exp": int(time.time()) + 60,
            "nonce": params["nonce"][0],
        },
        private,
        algorithm="RS256",
        headers={"kid": "test-key"},
    )

    def post(url, *, data, timeout):
        assert url == auth.TOKEN_URL
        assert data["client_id"] == issued
        assert data["redirect_uri"] == callback
        assert data["resource"] == auth.API_BASE
        assert data["code"] == "sample"
        return httpx.Response(
            200,
            json={
                "scope": auth.SCOPES if grant_plan else "openid email",
                "id_token": id_token,
                "token_type": "Bearer",
                "access_token": "test-plan-access-token",
                "refresh_token": "test-plan-refresh-token",
                "expires_in": 3600,
            },
        )

    def get(url, *, timeout):
        if url == auth.DISCOVERY_URL:
            body = {"issuer": auth.ISSUER, "jwks_uri": f"{auth.ISSUER}/jwks"}
        else:
            assert url == f"{auth.ISSUER}/jwks"
            body = {"keys": [public_jwk]}
        return httpx.Response(200, request=httpx.Request("GET", url), json=body)

    monkeypatch.setattr(auth.httpx, "post", post)
    monkeypatch.setattr(auth.httpx, "get", get)
    with pytest.raises(HTTPError) as exc:
        urlopen(f"{callback}?state=incorrect&code=sample", timeout=2)
    assert exc.value.code == 400
    assert auth.poll_login(started["session_id"])["status"] == "pending"
    query = urlencode({"state": params["state"][0], "code": "sample", "client_id": issued})
    with urlopen(f"{callback}?{query}", timeout=3) as response:
        assert response.status == 200

    assert auth.auth_status()["logged_in"] is grant_plan
    if grant_plan:
        assert auth.poll_login(started["session_id"])["status"] == "success"
        assert auth.access_token() == "test-plan-access-token"
    else:
        assert auth.poll_login(started["session_id"])["status"] == "failed"
        with pytest.raises(auth.CodexAuthError):
            auth.access_token()


def test_public_catalog_lists_only_visible_models(monkeypatch):
    monkeypatch.setattr(auth, "access_token", lambda: "test-plan-access-token")

    def get(url, *, headers, timeout):
        assert url == "https://api.openai.com/v1/models"
        assert headers["Authorization"] == "Bearer test-plan-access-token"
        return httpx.Response(
            200,
            request=httpx.Request("GET", url),
            json={"models": [
                {"slug": "gpt-example", "display_name": "Example", "visibility": "list"},
                {"slug": "hidden", "visibility": "hide"},
                {"slug": "unknown"},
            ]},
        )

    monkeypatch.setattr(codex_models.httpx, "get", get)
    result = codex_models.list_chatgpt_plan_models()
    assert result["success"] is True
    assert [entry["slug"] for entry in result["models"]] == ["gpt-example"]


@pytest.mark.parametrize("event_type", ["response.completed", "response.failed", "response.incomplete", "none"])
def test_public_responses_request_and_terminal_events(monkeypatch, event_type):
    from evoflow.models import openai_codex_provider as provider

    monkeypatch.setattr(provider, "access_token", lambda: "test-plan-access-token")
    monkeypatch.setattr(provider, "log_model_request_payload", lambda **_: None)
    real_client = httpx.Client

    def upstream(request):
        assert str(request.url) == "https://api.openai.com/v1/responses"
        assert request.headers["Authorization"] == "Bearer test-plan-access-token"
        assert "originator" not in request.headers
        assert "ChatGPT-Account-ID" not in request.headers
        payload = json.loads(request.content)
        assert payload["model"] == "gpt-example"
        assert payload["input"] == [{"role": "user", "content": "test"}]
        assert payload["store"] is False and payload["stream"] is True
        data = json.dumps({"type": event_type, "response": {"id": "test-response"}})
        return httpx.Response(200, text=f"data: {data}\n\n")

    monkeypatch.setattr(provider.httpx, "Client", lambda **_: real_client(transport=httpx.MockTransport(upstream)))
    model = runtimeChatModel(model="gpt-example", reasoning_effort="none")
    if event_type == "response.completed":
        assert model._call_codex_api([HumanMessage(content="test")]) == {"id": "test-response"}
    else:
        with pytest.raises(RuntimeError):
            model._call_codex_api([HumanMessage(content="test")])


def test_refresh_rotates_access_and_refresh_tokens(monkeypatch):
    with auth._store_lock():
        auth._save_profile(
            {
                "host_id": "urn:uuid:test",
                "client_id": "oaiapp_test",
                "subject": "test-user",
                "access_token": "expired",
                "refresh_token": "refresh-before",
                "scopes": [auth.PLAN_SCOPE],
                "expires_at": time.time() - 10,
            }
        )

    def refresh(request):
        assert request == {
            "grant_type": "refresh_token",
            "client_id": "oaiapp_test",
            "refresh_token": "refresh-before",
        }
        return {
            "scope": auth.SCOPES,
            "token_type": "Bearer",
            "access_token": "access-after",
            "refresh_token": "refresh-after",
            "expires_in": 3600,
        }

    monkeypatch.setattr(auth, "_exchange", refresh)
    assert auth.access_token() == "access-after"
    assert auth._load_profile()["refresh_token"] == "refresh-after"
    assert auth.access_token() == "access-after"


@pytest.mark.asyncio
async def test_instrumented_provider_preserves_sync_and_async_chat(monkeypatch):
    from evoflow.models.factory import _instrument_vendor_call_timing

    def complete(self, messages, tools=None):
        assert messages[0].content == "hello"
        return {
            "output": [
                {"type": "message", "content": [{"type": "output_text", "text": "ok"}]},
            ],
        }

    monkeypatch.setattr(runtimeChatModel, "_call_codex_api", complete)
    model = runtimeChatModel(model="gpt-example", reasoning_effort="none")
    _instrument_vendor_call_timing(model)

    assert model.invoke("hello").content == "ok"
    assert (await model.ainvoke("hello")).content == "ok"
    sync_chunks = list(model.stream("hello"))
    async_chunks = [chunk async for chunk in model.astream("hello")]
    for chunks in (sync_chunks, async_chunks):
        assert all(isinstance(chunk, AIMessageChunk) for chunk in chunks)
        assert "".join(chunk.content for chunk in chunks) == "ok"


def test_stream_chunk_keeps_completed_tool_call(monkeypatch):
    def complete(self, messages, tools=None):
        return {
            "output": [
                {"type": "function_call", "call_id": "call_test", "name": "lookup", "arguments": '{"value":7}'},
            ],
        }

    monkeypatch.setattr(runtimeChatModel, "_call_codex_api", complete)
    model = runtimeChatModel(model="gpt-example", reasoning_effort="none")
    chunk = next(model.stream("hello"))
    assert isinstance(chunk, AIMessageChunk)
    assert chunk.tool_calls[0]["id"] == "call_test"
    assert chunk.tool_calls[0]["args"] == {"value": 7}
