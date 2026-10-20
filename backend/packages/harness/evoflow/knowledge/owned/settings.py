"""Owned knowledge preference settings (primary + default embedding)."""

from __future__ import annotations

from typing import Any, Literal

from evoflow.persistence import config_repositories as cfg_repo

PRIMARY_KEY = "knowledge.primary"
DEFAULT_EMBEDDING_KEY = "knowledge.owned.default_embedding_model"
# Chat model used by owned-KB features (Ask AI + document summaries). Empty
# means "follow the global default chat model".
CHAT_MODEL_KEY = "knowledge.owned.chat_model"
# Per-base kill switch for automatic document summaries. Off by default: an
# LLM summary is a billed side effect, so it must be opted into explicitly.
DEFAULT_SUMMARY_KEY = "knowledge.owned.summary_default_enabled"
PrimaryMode = Literal["owned", "vault", "auto"]


def get_primary() -> PrimaryMode:
    raw = cfg_repo.get_app_setting(PRIMARY_KEY)
    val = str(raw or "owned").strip().lower()
    if val in ("owned", "vault", "auto"):
        return val  # type: ignore[return-value]
    return "owned"


def set_primary(mode: str) -> PrimaryMode:
    val = str(mode or "owned").strip().lower()
    if val not in ("owned", "vault", "auto"):
        raise ValueError("primary must be owned|vault|auto")
    cfg_repo.set_app_setting(PRIMARY_KEY, val)
    return val  # type: ignore[return-value]


def get_default_embedding_model() -> str:
    raw = cfg_repo.get_app_setting(DEFAULT_EMBEDDING_KEY)
    return str(raw or "").strip()


def set_default_embedding_model(ref: str | None) -> str:
    """Store registry model ``name`` as the owned-KB default. Empty clears."""
    val = str(ref or "").strip()
    if val:
        from evoflow.knowledge.owned.embedding_bind import resolve_model_config

        if resolve_model_config(val) is None:
            raise ValueError(f"embedding model not found in registry: {val}")
    cfg_repo.set_app_setting(DEFAULT_EMBEDDING_KEY, val)
    return val


def _resolve_registry_chat_model(ref: str) -> str:
    """Validate a registry chat model name; return "" while models are unloaded.

    Lets ``knowledge.owned.chat_model`` be written before the model registry is
    built (e.g. first-run seeding) without silently dropping the setting.
    """
    val = str(ref or "").strip()
    if not val:
        return ""
    try:
        from evoflow.config.app_config import get_app_config

        cfg = get_app_config()
        if not getattr(cfg, "models", None):
            return val
        if cfg.get_model_config(val) is None:
            raise ValueError(f"chat model not found in registry: {val}")
    except ValueError:
        raise
    except Exception:
        return val
    return val


def get_chat_model() -> str:
    """Configured knowledge chat model, or "" to follow the global default."""
    raw = cfg_repo.get_app_setting(CHAT_MODEL_KEY)
    return str(raw or "").strip()


def set_chat_model(ref: str | None) -> str:
    val = _resolve_registry_chat_model(ref or "")
    cfg_repo.set_app_setting(CHAT_MODEL_KEY, val)
    return val


def resolve_chat_model_name() -> str:
    """Registry name of the chat model KB features will actually use ("" if none).

    Single source of truth for Ask AI + summary jobs, so the settings panel can
    show exactly what runs instead of a UI-local dropdown default.
    """
    configured = get_chat_model()
    if configured:
        try:
            from evoflow.config.app_config import get_app_config

            if get_app_config().get_model_config(configured) is not None:
                return configured
        except Exception:
            return configured
    try:
        from evoflow.config.app_config import get_app_config
        from evoflow.models.factory import _default_resolved_model_name

        return _default_resolved_model_name(get_app_config())
    except Exception:
        return ""


def get_default_summary_enabled() -> bool:
    """Whether newly created KBs start with automatic summaries on (default: off)."""
    raw = cfg_repo.get_app_setting(DEFAULT_SUMMARY_KEY)
    if raw is None:
        return False
    return str(raw).strip().lower() in ("1", "true", "yes", "on")


def set_default_summary_enabled(enabled: bool) -> bool:
    val = bool(enabled)
    cfg_repo.set_app_setting(DEFAULT_SUMMARY_KEY, "1" if val else "0")
    return val


def prefer_owned(*, vault_id: str | None = None, has_owned_bases: bool = False) -> bool:
    """Decide whether Agent knowledge tools should hit owned KB first."""
    mode = get_primary()
    if mode == "vault":
        return False
    if mode == "owned":
        return bool(has_owned_bases)
    # auto: owned if any bases exist (legacy behavior)
    return bool(has_owned_bases)


def settings_payload() -> dict[str, Any]:
    from evoflow.knowledge.owned.embedding_bind import default_embedding_ref

    stored = get_default_embedding_model()
    effective = default_embedding_ref()
    return {
        "primary": get_primary(),
        "defaultEmbeddingModel": stored,
        "effectiveEmbeddingModel": effective,
        "chatModel": get_chat_model(),
        "effectiveChatModel": resolve_chat_model_name(),
        "summaryDefaultEnabled": get_default_summary_enabled(),
    }
