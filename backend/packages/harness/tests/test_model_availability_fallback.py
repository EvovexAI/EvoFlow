"""Tests for model availability persistence and fallback session switch."""

from __future__ import annotations

import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from langchain_core.messages import AIMessage, HumanMessage

from evoflow.agents.middlewares.model_fallback_middleware import (
    ModelFallbackMiddleware,
    _should_mark_unavailable,
    _user_friendly_message_for_error,
)
from evoflow.error_classifier import FailoverReason
from evoflow.persistence.db import get_db, reset_db_for_tests


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_db_for_tests()
        get_db()  # ensure schema (incl. v122) applied
        yield Path(tmp)
        reset_db_for_tests()
        import gc

        gc.collect()


def _seed_model(name: str, *, fallbacks: list[str] | None = None) -> None:
    from evoflow.persistence import config_repositories as cfg_repo

    doc = {
        "name": name,
        "use": "langchain_openai:ChatOpenAI",
        "model": name,
        "vendor": "test",
        "base_url": "http://127.0.0.1:9",
        "api_key": "sk-test",
    }
    if fallbacks:
        doc["fallback_models"] = list(fallbacks)
    cfg_repo.upsert_model(doc)


def test_mark_clear_unavailable_persists(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    from evoflow.persistence import config_repositories as cfg_repo

    _seed_model("m1")
    assert cfg_repo.is_model_unavailable("m1") is False

    assert cfg_repo.mark_model_unavailable("m1", reason="认证失败", code="auth") is True
    row = cfg_repo.get_model("m1")
    assert row is not None
    assert row["availability_status"] == "unavailable"
    assert row["unavailable_reason"] == "认证失败"
    assert row["unavailable_code"] == "auth"
    assert row.get("unavailable_at")

    assert cfg_repo.is_model_unavailable("m1") is True
    assert cfg_repo.clear_model_unavailable("m1") is True
    row2 = cfg_repo.get_model("m1")
    assert row2 is not None
    assert row2["availability_status"] == "available"
    assert not row2.get("unavailable_reason")
    # Second clear is a no-op
    assert cfg_repo.clear_model_unavailable("m1") is False


def test_upsert_does_not_overwrite_availability(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    from evoflow.persistence import config_repositories as cfg_repo

    _seed_model("m1")
    cfg_repo.mark_model_unavailable("m1", reason="服务异常", code="server_error")

    cfg_repo.upsert_model(
        {
            "name": "m1",
            "use": "langchain_openai:ChatOpenAI",
            "model": "m1",
            "vendor": "test",
            "base_url": "http://127.0.0.1:9",
            "api_key": "sk-new",
            "display_name": "Updated",
            "availability_status": "available",
            "unavailable_reason": "should-not-apply",
        }
    )
    row = cfg_repo.get_model("m1")
    assert row is not None
    assert row["display_name"] == "Updated"
    assert row["availability_status"] == "unavailable"
    assert row["unavailable_reason"] == "服务异常"


def test_context_overflow_not_marked_unavailable() -> None:
    assert _should_mark_unavailable(FailoverReason.CONTEXT_OVERFLOW) is False
    assert _should_mark_unavailable(FailoverReason.PAYLOAD_TOO_LARGE) is False
    assert _should_mark_unavailable(FailoverReason.AUTH) is True
    assert _should_mark_unavailable(FailoverReason.SERVER_ERROR) is True


class _ModelApiError(Exception):
    __module__ = "openai"


class _Request:
    def __init__(self, messages: list | None = None) -> None:
        self.state = {"messages": messages or [HumanMessage(content="hi")]}
        self.runtime = SimpleNamespace(context={"thread_id": "tid-1", "model_name": "primary"})

    def override(self, **kwargs):
        new = _Request(list(kwargs.get("messages") or self.state["messages"]))
        new.runtime = self.runtime
        return new


def test_fallback_success_marks_primary_and_switches_session(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    from evoflow.persistence import config_repositories as cfg_repo
    from evoflow.persistence import session_repositories as sess_repo

    _seed_model("primary", fallbacks=["backup"])
    _seed_model("backup")
    sess_repo.upsert_session_row(
        "agent:main:main",
        thread_id="tid-1",
        context={"model_name": "primary"},
    )

    mw = ModelFallbackMiddleware()
    exc = _ModelApiError("401 unauthorized invalid api key")
    primary_model = SimpleNamespace(
        _evoflow_primary_model_name="primary",
        _evoflow_fallback_models=["backup"],
        _credential_pool=None,
    )
    exc._evoflow_model = primary_model  # type: ignore[attr-defined]

    fb_model = MagicMock()
    fb_model.invoke.return_value = AIMessage(content="from backup")

    handler = MagicMock(side_effect=exc)
    request = _Request()

    with patch(
        "evoflow.agents.middlewares.model_fallback_middleware._is_model_api_error",
        return_value=True,
    ), patch(
        "evoflow.agents.middlewares.model_fallback_middleware.classify",
        return_value=SimpleNamespace(
            should_compress=False,
            reason=FailoverReason.AUTH,
            should_rotate_credential=True,
            should_fallback_provider=True,
            retryable=False,
        ),
    ), patch(
        "evoflow.models.factory.create_chat_model",
        return_value=fb_model,
    ), patch(
        "evoflow.agents.middlewares.model_fallback_middleware._emit_user_notice_stream",
        return_value=True,
    ), patch(
        "evoflow.agents.middlewares.model_fallback_middleware._emit_model_retry_activity",
    ), patch(
        "evoflow.config.reload_models_from_db",
    ):
        result = mw.wrap_model_call(request, handler)

    assert isinstance(result, AIMessage)
    assert result.content == "from backup"
    assert cfg_repo.is_model_unavailable("primary") is True
    assert cfg_repo.get_model("primary")["unavailable_code"] == "auth"
    assert sess_repo.get_model_name_for_thread("tid-1") == "backup"


def test_handle_model_error_includes_reason_and_marks(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    from evoflow.persistence import config_repositories as cfg_repo

    _seed_model("primary")
    mw = ModelFallbackMiddleware()
    exc = _ModelApiError("upstream 500")
    primary_model = SimpleNamespace(_evoflow_primary_model_name="primary")
    exc._evoflow_model = primary_model  # type: ignore[attr-defined]
    runtime = SimpleNamespace(context={"model_name": "primary"})

    with patch(
        "evoflow.agents.middlewares.model_fallback_middleware._should_reraise_for_supervisor",
        return_value=False,
    ), patch(
        "evoflow.agents.middlewares.model_fallback_middleware.classify",
        return_value=SimpleNamespace(
            reason=FailoverReason.SERVER_ERROR,
            should_compress=False,
            should_rotate_credential=False,
            should_fallback_provider=True,
            retryable=True,
        ),
    ), patch(
        "evoflow.agents.middlewares.model_fallback_middleware._emit_user_notice_stream",
        return_value=True,
    ), patch(
        "evoflow.config.reload_models_from_db",
    ):
        msg = mw._handle_model_error(exc, runtime)

    assert "服务异常" in str(msg.content)
    assert cfg_repo.is_model_unavailable("primary") is True


def test_user_friendly_messages_still_cover_common_reasons() -> None:
    assert "限流" in _user_friendly_message_for_error(_ModelApiError("rate limit exceeded"))
    assert "额度" in _user_friendly_message_for_error(_ModelApiError("insufficient_quota billing"))


def test_availability_fields_stripped_from_provider_kwargs() -> None:
    from evoflow.models.factory import _strip_provider_internal_keys

    cleaned = _strip_provider_internal_keys(
        {
            "model": "x",
            "api_key": "k",
            "temperature": 0.2,
            "availability_status": "unavailable",
            "unavailable_reason": "认证失败",
            "unavailable_code": "auth",
            "unavailable_at": "2026-01-01T00:00:00Z",
            "fallback_models": ["b"],
        }
    )
    assert cleaned == {"model": "x", "api_key": "k", "temperature": 0.2}
