"""Session model_name must not freeze create-time defaults forever."""

from __future__ import annotations

from evoflow.persistence.chat_session_service import _default_session_context
from evoflow.persistence.session_context_fields import (
    context_from_flat_row,
    effective_session_model_override,
)


def test_effective_override_ignores_equal_primary_stamp():
    assert effective_session_model_override("glm-5.3-flash", "glm-5.3-flash") is None
    assert effective_session_model_override("glm-5.3-flash", "decision-model-preview") == "glm-5.3-flash"
    assert effective_session_model_override("", "decision-model-preview") is None
    assert effective_session_model_override("default", "default") is None


def test_context_from_flat_row_omits_stamped_default_model():
    ctx = context_from_flat_row(
        {
            "model_name": "glm-5.3-flash",
            "primary_model_name": "glm-5.3-flash",
            "agent_id": "xiaomi",
            "session_mode": "agent",
        }
    )
    assert "model_name" not in ctx
    assert ctx.get("primary_model_name") == "glm-5.3-flash"
    assert ctx.get("agent_id") == "xiaomi"


def test_context_from_flat_row_keeps_real_user_pin():
    ctx = context_from_flat_row(
        {
            "model_name": "glm-5.3-flash",
            "primary_model_name": "decision-model-preview",
            "session_mode": "agent",
        }
    )
    assert ctx.get("model_name") == "glm-5.3-flash"


def test_default_session_context_does_not_stamp_model_name(monkeypatch):
    monkeypatch.setattr(
        "evoflow.persistence.chat_session_service.resolve_primary_model_name",
        lambda: "decision-model-preview",
    )
    ctx = _default_session_context("xiaomi")
    assert "model_name" not in ctx
    assert ctx.get("primary_model_name") == "decision-model-preview"
