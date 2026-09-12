"""Configuration for pre-tool-call authorization."""

import copy
import os

from pydantic import BaseModel, Field


class GuardrailProviderConfig(BaseModel):
    """Configuration for a guardrail provider."""

    use: str = Field(description="Class path (e.g. 'evoflow.guardrails.builtin:AllowlistProvider')")
    config: dict = Field(default_factory=dict, description="Provider-specific settings passed as kwargs")


class GuardrailsConfig(BaseModel):
    """Configuration for pre-tool-call authorization.

    When enabled, every tool call passes through the configured provider
    before execution. The provider receives tool name, arguments, and the
    agent's passport reference, and returns an allow/deny decision.
    """

    enabled: bool = Field(default=False, description="Enable guardrail middleware")
    fail_closed: bool = Field(default=True, description="Block tool calls if provider errors")
    passport: str | None = Field(default=None, description="OAP passport path or hosted agent ID")
    provider: GuardrailProviderConfig | None = Field(default=None, description="Guardrail provider configuration")


_guardrails_config: GuardrailsConfig | None = None


def get_guardrails_config() -> GuardrailsConfig:
    """Get the guardrails config, returning defaults if not loaded."""
    global _guardrails_config
    if _guardrails_config is None:
        _guardrails_config = GuardrailsConfig()
    return _guardrails_config


def _env_flag_truthy(name: str) -> bool:
    v = str(os.environ.get(name, "") or "").strip().lower()
    return v in ("1", "true", "yes", "on")


def _maybe_allow_execute_command_for_dev(payload: dict) -> dict:
    """Strip ``execute_command``/``terminal`` from builtin AllowlistProvider ``denied_tools`` unless locked down.

    Local / dev configs often deny shell for safety, which breaks ``mkdir``/npm 等子任务。
    生产或强安全环境：设置 ``EVOFLOW_GUARDRAILS_DENY_EXECUTE_COMMAND=1`` 保留 YAML 中的拒绝项。
    ``terminal`` replaces ``execute_command`` as the unified terminal tool.
    """
    if _env_flag_truthy("EVOFLOW_GUARDRAILS_DENY_EXECUTE_COMMAND"):
        return payload
    prov = payload.get("provider")
    if not isinstance(prov, dict):
        return payload
    use = str(prov.get("use") or "")
    if "AllowlistProvider" not in use:
        return payload
    cfg = prov.get("config")
    if not isinstance(cfg, dict):
        return payload
    denied = cfg.get("denied_tools")
    if not isinstance(denied, list):
        return payload
    names = [str(x) for x in denied]
    if "execute_command" not in names and "terminal" not in names:
        return payload
    new_denied = [x for x in denied if str(x) not in ("execute_command", "terminal")]
    new_prov = copy.deepcopy(prov)
    new_prov.setdefault("config", {})["denied_tools"] = new_denied
    out = copy.deepcopy(payload)
    out["provider"] = new_prov
    return out


def load_guardrails_config_from_dict(data: dict) -> GuardrailsConfig:
    """Load guardrails config from a dict (called during AppConfig loading)."""
    global _guardrails_config
    merged = _maybe_allow_execute_command_for_dev(copy.deepcopy(data))
    _guardrails_config = GuardrailsConfig.model_validate(merged)
    return _guardrails_config


def reset_guardrails_config() -> None:
    """Reset the cached config instance. Used in tests to prevent singleton leaks."""
    global _guardrails_config
    _guardrails_config = None
