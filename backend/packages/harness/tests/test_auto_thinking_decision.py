from unittest.mock import MagicMock, patch

from evoflow.agents.auto_thinking_decision import (
    _parse_decision_json,
    apply_auto_thinking_decision,
    resolve_auto_thinking_decision,
)
from evoflow.config.session_intent_config import SessionIntentConfig, load_session_intent_config_from_dict


def _patch_model_config(*, supports_thinking=True, default_mode="auto", default_level="low"):
    mc = MagicMock()
    mc.supports_thinking = supports_thinking
    mc.thinking = {"default_mode": default_mode, "default_level": default_level}
    app_cfg = MagicMock()
    app_cfg.get_model_config.return_value = mc
    return patch("evoflow.config.get_app_config", return_value=app_cfg)


def test_parse_decision_json_true():
    d = _parse_decision_json('{"need_thinking": true, "reasoning_effort": "low"}')
    assert d is not None
    assert d.thinking_enabled is True
    assert d.reasoning_effort == "low"


def test_parse_decision_json_false():
    d = _parse_decision_json('{"need_thinking": false}')
    assert d is not None
    assert d.thinking_enabled is False
    assert d.reasoning_effort == "minimum"


def test_resolve_runs_when_yaml_auto_thinking_disabled():
    load_session_intent_config_from_dict(SessionIntentConfig(auto_thinking_decision_enabled=False, llm_rollup_model_name="mini").model_dump())
    mock_resp = MagicMock()
    mock_resp.content = '{"need_thinking": false}'
    mock_model = MagicMock()
    mock_model.invoke.return_value = mock_resp
    with patch("evoflow.models.create_chat_model", return_value=mock_model):
        d = resolve_auto_thinking_decision("hello")
    assert d is not None
    assert d.thinking_enabled is False


def test_resolve_calls_model():
    load_session_intent_config_from_dict(SessionIntentConfig(auto_thinking_decision_enabled=True, llm_rollup_model_name="mini").model_dump())
    mock_resp = MagicMock()
    mock_resp.content = '{"need_thinking": false}'
    mock_model = MagicMock()
    mock_model.invoke.return_value = mock_resp
    with patch("evoflow.models.create_chat_model", return_value=mock_model):
        d = resolve_auto_thinking_decision("hello")
    assert d is not None
    assert d.thinking_enabled is False


def test_apply_defaults_off_when_resolve_returns_none():
    load_session_intent_config_from_dict(SessionIntentConfig(auto_thinking_decision_enabled=True).model_dump())
    with (
        patch("evoflow.agents.auto_thinking_decision.resolve_auto_thinking_decision", return_value=None),
        patch("evoflow.persistence.session_repositories.upsert_session_row") as upsert,
    ):
        cfg: dict = {}
        d = apply_auto_thinking_decision(session_key="agent:main:abc", user_message="hello", cfg=cfg)
    assert d is not None
    assert d.thinking_enabled is False
    assert d.reasoning_effort == "minimum"
    assert cfg["thinking_enabled"] is False
    upsert.assert_called_once()
    assert upsert.call_args.kwargs["context"]["thinking_enabled"] is False


def test_apply_agent_scenario_skips_classifier():
    load_session_intent_config_from_dict(SessionIntentConfig(auto_thinking_decision_enabled=True).model_dump())
    with (
        patch("evoflow.agents.auto_thinking_decision.resolve_auto_thinking_decision") as resolve,
        _patch_model_config(),
    ):
        cfg: dict = {"activated_scenarios": ["agent"]}
        d = apply_auto_thinking_decision(
            session_key="agent:main:ag",
            user_message="fix bug",
            cfg=cfg,
            model_name="test-model",
        )
    assert d is not None
    assert d.thinking_enabled is False
    assert d.reasoning_effort == "minimum"
    assert cfg["thinking_enabled"] is False
    resolve.assert_not_called()


def test_apply_workspace_scenario_skips_classifier():
    load_session_intent_config_from_dict(SessionIntentConfig(auto_thinking_decision_enabled=True).model_dump())
    with (
        patch("evoflow.agents.auto_thinking_decision.resolve_auto_thinking_decision") as resolve,
        _patch_model_config(),
    ):
        cfg: dict = {"activated_scenarios": ["workspace"]}
        d = apply_auto_thinking_decision(
            session_key="agent:main:ws",
            user_message="fix bug",
            cfg=cfg,
            model_name="test-model",
        )
    assert d is not None
    assert d.thinking_enabled is False
    assert d.reasoning_effort == "minimum"
    assert cfg["thinking_enabled"] is False
    resolve.assert_not_called()


def test_apply_agent_scenario_by_session_mode_skips_classifier():
    load_session_intent_config_from_dict(SessionIntentConfig(auto_thinking_decision_enabled=True).model_dump())
    with (
        patch("evoflow.agents.auto_thinking_decision.resolve_auto_thinking_decision") as resolve,
        _patch_model_config(),
    ):
        cfg: dict = {"session_mode": "agent"}
        d = apply_auto_thinking_decision(
            session_key="agent:main:sm",
            user_message="refactor",
            cfg=cfg,
            model_name="test-model",
        )
    assert d is not None
    assert d.thinking_enabled is False
    resolve.assert_not_called()


def test_apply_agent_scenario_respects_model_thinking_disabled():
    load_session_intent_config_from_dict(SessionIntentConfig(auto_thinking_decision_enabled=True).model_dump())
    with (
        patch("evoflow.agents.auto_thinking_decision.resolve_auto_thinking_decision") as resolve,
        _patch_model_config(supports_thinking=False),
        patch("evoflow.persistence.session_repositories.upsert_session_row") as upsert,
    ):
        cfg: dict = {"session_mode": "agent"}
        d = apply_auto_thinking_decision(
            session_key="agent:main:no-think",
            user_message="refactor",
            cfg=cfg,
            model_name="test-model",
        )
    assert d is not None
    assert d.thinking_enabled is False
    assert d.reasoning_effort == "minimum"
    assert cfg["thinking_enabled"] is False
    resolve.assert_not_called()
    upsert.assert_called_once()
    assert upsert.call_args.kwargs["context"]["thinking_enabled"] is False
    assert upsert.call_args.kwargs["context"]["session_mode"] == "agent"


def test_apply_agent_scenario_respects_model_default_mode_disabled():
    load_session_intent_config_from_dict(SessionIntentConfig(auto_thinking_decision_enabled=True).model_dump())
    with (
        patch("evoflow.agents.auto_thinking_decision.resolve_auto_thinking_decision") as resolve,
        _patch_model_config(default_mode="disabled"),
        patch("evoflow.persistence.session_repositories.upsert_session_row") as upsert,
    ):
        cfg: dict = {"session_mode": "agent"}
        d = apply_auto_thinking_decision(
            session_key="agent:main:model-off",
            user_message="refactor",
            cfg=cfg,
            model_name="test-model",
        )
    assert d is not None
    assert d.thinking_enabled is False
    assert cfg["thinking_enabled"] is False
    resolve.assert_not_called()
    upsert.assert_called_once()
    assert upsert.call_args.kwargs["context"]["thinking_enabled"] is False


def test_apply_workspace_scenario_overrides_cached_off():
    from evoflow.agents.auto_thinking_decision import AutoThinkingDecision, _set_cached_decision

    load_session_intent_config_from_dict(SessionIntentConfig(auto_thinking_decision_enabled=True).model_dump())
    sk = "agent:main:ws-override"
    _set_cached_decision(sk, AutoThinkingDecision(thinking_enabled=False, reasoning_effort="minimum"))
    with (
        patch("evoflow.agents.auto_thinking_decision.resolve_auto_thinking_decision") as resolve,
        _patch_model_config(),
    ):
        cfg: dict = {"activated_scenarios": ["workspace"]}
        d = apply_auto_thinking_decision(
            session_key=sk,
            user_message="refactor module",
            cfg=cfg,
            model_name="test-model",
        )
    assert d is not None
    # Agent/workspace no longer force thinking on
    assert d.thinking_enabled is False
    resolve.assert_not_called()


def test_apply_persists_to_session():
    from evoflow.agents.auto_thinking_decision import AutoThinkingDecision

    load_session_intent_config_from_dict(SessionIntentConfig(auto_thinking_decision_enabled=True).model_dump())
    with (
        patch(
            "evoflow.agents.auto_thinking_decision.resolve_auto_thinking_decision",
            return_value=AutoThinkingDecision(thinking_enabled=True, reasoning_effort="low"),
        ),
        patch("evoflow.persistence.session_repositories.upsert_session_row") as upsert,
    ):
        cfg: dict = {}
        d = apply_auto_thinking_decision(session_key="agent:main:persist", user_message="design system", cfg=cfg)
    assert d is not None
    assert d.thinking_enabled is False
    assert cfg["thinking_enabled"] is False
    upsert.assert_called_once()
    ctx = upsert.call_args.kwargs["context"]
    assert ctx["thinking_enabled"] is True
    assert ctx["reasoning_effort"] == "low"
