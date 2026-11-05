"""Runtime keys must never reach OpenAI AsyncCompletions.create()."""

from __future__ import annotations

from evoflow.models.create_payload_sanitize import (
    scrub_chat_model_runtime_kwargs,
    strip_non_vendor_create_keys,
)
from evoflow.models.patched_openai import PatchedChatOpenAI
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
    import json

    extra = json.loads(poisoned["extra_json"])
    extra["session_key"] = "agent:xiaomi:new-eef1354a"
    poisoned["extra_json"] = json.dumps(extra)
    out = model_row_to_doc(poisoned)
    assert "session_key" not in out
