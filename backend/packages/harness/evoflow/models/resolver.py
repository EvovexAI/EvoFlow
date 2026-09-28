"""Single source of truth for chat model resolution.

The previous design resolved ``model_name`` at ~7 different sites, each with
its own fallback chain. This module centralizes the order so every caller — the
Lead Agent entry point, ``factory.create_chat_model``, subagent delegation, and
the proactive engine — consults the same ladder.

Resolution order (highest → lowest):

1. **Runtime override** — ``cfg.model_name`` or ``cfg.model`` set by whoever
   started the run. This is the slot proactive employees and front-end session
   UI write into. Both live in the same field; whichever wrote last wins.
   The "employee overrides agent" rule lives here, not in the Agent layer.
2. **Agent configuration** — ``AgentConfig.model`` for the bound ``agent_code``.
3. **Global primary model** — ``AppConfig.primary_model``.
4. **First configured model** — ``AppConfig.models[0].name``.

When the runtime name does not match any configured model the resolver records
the miss and keeps falling back; it never raises on a bad runtime override so
a stale front-end cache cannot take down the chat pipeline.

Examples:
    >>> resolve_run_model(agent_code="main", cfg={})
    # falls through agent → primary → models[0]

    >>> resolve_run_model(agent_code="main", cfg={"model_name": "glm-5"})
    # returns "glm-5" if it exists in AppConfig, else falls back
"""

from __future__ import annotations

import logging
from typing import Any, Mapping

logger = logging.getLogger(__name__)


class NoChatModelConfiguredError(RuntimeError):
    """Raised when the resolver finds zero models anywhere in the ladder."""


def _runtime_override(cfg: Mapping[str, Any] | None) -> str:
    """Pull the highest-priority name written by whoever started the run.

    Accepts both ``model_name`` (EvoFlow canonical) and ``model`` (LangChain
    convention) for compatibility with library-side hooks. ``"default"`` is
    treated as a sentinel for "unset" so that the Agents panel can signal
    "follow defaults" without writing a real name.
    """
    if not cfg:
        return ""
    for key in ("model_name", "model"):
        raw = cfg.get(key)
        if raw is None:
            continue
        text = str(raw).strip()
        if not text or text.lower() == "default":
            continue
        return text
    return ""


def resolve_run_model(
    *,
    agent_code: str | None = None,
    cfg: Mapping[str, Any] | None = None,
    require_configured: bool = True,
) -> str:
    """Resolve the model name that the next chat turn should use.

    Args:
        agent_code: The ``agent_code`` of the agent hosting the run. Used to
            look up ``AgentConfig.model`` when no runtime override exists.
        cfg: The runtime ``configurable`` mapping (or any superset that
            includes it). The resolver reads ``cfg["model_name"]`` /
            ``cfg["model"]`` for the runtime-override tier.
        require_configured: When True (default), the resolver raises
            :class:`NoChatModelConfiguredError` if nothing in the ladder
            produced a real name. When False, the resolver returns an empty
            string instead — useful for read-only display paths that want
            to show "—" instead of a fabricated default.

    Returns:
        The resolved model name (never empty when ``require_configured``).

    Raises:
        NoChatModelConfiguredError: only when nothing in the ladder matches
            and ``require_configured`` is True.
    """
    runtime_name = _runtime_override(cfg)
    agent_name = _agent_model(agent_code)
    global_name = _global_default_model()

    chosen, source = _pick(runtime_name, agent_name, global_name)

    if chosen:
        if source > 0:
            logger.debug(
                "model resolved: source=%s name=%r (runtime=%r agent=%r global=%r)",
                _SOURCE_NAMES[source],
                chosen,
                runtime_name,
                agent_name,
                global_name,
            )
        return chosen

    if require_configured:
        raise NoChatModelConfiguredError(
            "No chat model could be resolved. Add at least one model in "
            "Settings → Models (configure AppConfig.primary_model or add a "
            "model to the list)."
        )
    return ""


# Source indices, kept as private constants so logs and tests can refer to them.
SOURCE_RUNTIME = 0
SOURCE_AGENT = 1
SOURCE_GLOBAL_PRIMARY = 2
SOURCE_GLOBAL_FIRST = 3

_SOURCE_NAMES = {
    SOURCE_RUNTIME: "runtime",
    SOURCE_AGENT: "agent",
    SOURCE_GLOBAL_PRIMARY: "primary",
    SOURCE_GLOBAL_FIRST: "first",
}


def resolve_run_model_with_source(
    *,
    agent_code: str | None = None,
    cfg: Mapping[str, Any] | None = None,
) -> tuple[str, int]:
    """Like :func:`resolve_run_model` but also returns which tier won.

    Useful for observability and UI surfaces that want to show the user
    "model came from your Agent config" vs "from the global default". Raises
    :class:`NoChatModelConfiguredError` on empty configuration.
    """
    name = resolve_run_model(agent_code=agent_code, cfg=cfg, require_configured=True)
    runtime_name = _runtime_override(cfg)
    if name == runtime_name:
        return name, SOURCE_RUNTIME
    if name == _agent_model(agent_code):
        return name, SOURCE_AGENT
    g = get_app_config_safe()
    if g is not None:
        primary = (g.primary_model or "").strip()
        if primary and name == primary:
            return name, SOURCE_GLOBAL_PRIMARY
        if g.models and name == g.models[0].name:
            return name, SOURCE_GLOBAL_FIRST
    # Fallback: a name that didn't match any tier should not happen, but if it
    # does, label it as global-first so callers can still categorize.
    return name, SOURCE_GLOBAL_FIRST


# ---------------------------------------------------------------------------
# Tier helpers — small and lazy to avoid pulling in heavy imports at import
# time of this module (which is imported widely, including by the model
# factory itself).
# ---------------------------------------------------------------------------


def _agent_model(agent_code: str | None) -> str:
    """Agent layer (tier 2). Returns ``""`` on miss so the next tier fires."""
    code = (agent_code or "").strip()
    if not code:
        return ""
    try:
        from evoflow.config.agents_config import load_agent_config

        agent = load_agent_config(code)
    except Exception:  # noqa: BLE001 — any load failure must not block chat
        logger.debug("resolve_run_model: agent config load failed code=%s", code, exc_info=True)
        return ""
    if agent is None:
        return ""
    raw = getattr(agent, "model", None)
    return str(raw).strip() if raw else ""


def get_app_config_safe() -> Any:
    """Best-effort :func:`get_app_config` access; returns ``None`` if unbuilt."""
    try:
        from evoflow.config.app_config import get_app_config

        return get_app_config()
    except Exception:  # noqa: BLE001
        return None


def _global_default_model() -> str:
    """Global tier (3: primary_model, 4: models[0]). Empty string on miss."""
    cfg = get_app_config_safe()
    if cfg is None:
        return ""
    primary = (getattr(cfg, "primary_model", None) or "").strip()
    if primary:
        return primary
    models = getattr(cfg, "models", None) or []
    if models:
        first = getattr(models[0], "name", None)
        if first:
            return str(first).strip()
    return ""


def _pick(runtime: str, agent: str, global_name: str) -> tuple[str, int]:
    """Pick the highest tier with a real, configured model.

    A tier's value is only accepted when the current AppConfig has it — this
    is what makes stale front-end overrides fall through to the next tier
    instead of raising.
    """
    cfg = get_app_config_safe()
    known = _known_names(cfg)

    if runtime and (not known or runtime in known):
        return runtime, SOURCE_RUNTIME
    if runtime and known and runtime not in known:
        logger.info(
            "model resolved: runtime override %r is not in AppConfig (%d models); falling through",
            runtime,
            len(known),
        )

    if agent and (not known or agent in known):
        return agent, SOURCE_AGENT
    if agent and known and agent not in known:
        logger.info(
            "model resolved: agent model %r not in AppConfig (%d models); falling through",
            agent,
            len(known),
        )

    if global_name and (not known or global_name in known):
        if cfg is not None:
            primary = (getattr(cfg, "primary_model", None) or "").strip()
            if primary and global_name == primary:
                return global_name, SOURCE_GLOBAL_PRIMARY
        return global_name, SOURCE_GLOBAL_FIRST

    return "", -1


def _known_names(cfg: Any) -> set[str]:
    if cfg is None:
        return set()
    out: set[str] = set()
    for m in getattr(cfg, "models", None) or []:
        n = getattr(m, "name", None)
        if n:
            out.add(str(n).strip())
    return out
