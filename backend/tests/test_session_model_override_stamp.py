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


def test_explicit_pinned_flag_is_authoritative_over_primary_heuristic():
    # 用户显式 pin 了「当前主模型本身」→ flag 是权威，不再被 ==primary 推断抹掉
    assert effective_session_model_override("glm-5.3-flash", "glm-5.3-flash", 1) == "glm-5.3-flash"
    assert effective_session_model_override("glm-5.3-flash", "glm-5.3-flash", True) == "glm-5.3-flash"
    assert effective_session_model_override("glm-5.3-flash", "glm-5.3-flash", "true") == "glm-5.3-flash"


def test_explicit_unpin_suppresses_legacy_inference():
    # 配置类写入（群聊岗位回填等）：pinned=0 → 一律不算 pin，即使名字 != primary 快照
    assert effective_session_model_override("role-model-x", "glm-5.3-flash", 0) is None
    assert effective_session_model_override("role-model-x", "glm-5.3-flash", False) is None


def test_missing_flag_keeps_legacy_inference():
    # 旧行（flag 缺省 NULL）保持原推断，行为与升级前一致
    assert effective_session_model_override("glm-5.3-flash", "glm-5.3-flash", None) is None
    assert effective_session_model_override("glm-5.3-flash", "decision-model-preview", None) == "glm-5.3-flash"


def test_context_from_flat_row_respects_pinned_flag():
    # pinned=1 且与 primary 同名 → 保留
    ctx = context_from_flat_row(
        {"model_name": "glm-5.3-flash", "model_pinned": 1, "primary_model_name": "glm-5.3-flash"}
    )
    assert ctx.get("model_name") == "glm-5.3-flash"
    assert ctx.get("model_pinned") is True
    # pinned=0（群聊回填）→ 不进 ctx，会话视为跟随中
    ctx2 = context_from_flat_row(
        {"model_name": "role-model-x", "model_pinned": 0, "primary_model_name": "glm-5.3-flash"}
    )
    assert "model_name" not in ctx2
    assert ctx2.get("model_pinned") is False
    # 旧行（flag 缺省）→ 不发 model_pinned 键，前端按 legacy 推断
    ctx3 = context_from_flat_row(
        {"model_name": "glm-5.3-flash", "primary_model_name": "glm-5.3-flash"}
    )
    assert "model_pinned" not in ctx3
