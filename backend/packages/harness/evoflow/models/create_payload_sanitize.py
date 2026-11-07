"""Strip LangGraph / EvoFlow runtime keys that must never reach vendor ``create()``.

LangChain ``ChatOpenAI`` folds unknown constructor kwargs into ``model_kwargs``, then
merges them into the OpenAI chat-completions payload. OpenAI SDK 2.x rejects unknown
kwargs (``TypeError: … unexpected keyword argument 'session_key'``).

The same keys can also arrive via ``model.bind(session_key=…)`` / ``model_settings``.

Two leak paths are covered here:

1. **Runtime keys** (``session_key``, ``thread_id``, …) — LangGraph session plumbing.
2. **Platform control-plane keys** (``confirm``, ``confirmed``, ``yes``, …) — the
   capability gate's confirmation flag. The platform dispatcher accepts ``confirm``
   inside ``args_json`` and, for model-mutating actions such as
   ``settings.create_model`` / ``settings.update_model``, the flag was not stripped
   before the payload was persisted as a model config extra (``ModelConfig`` is
   ``extra="allow"``). That extra was then replayed as a constructor kwarg on every
   ``create_chat_model()`` call and finally reached ``AsyncCompletions.create()``,
   raising ``TypeError: … unexpected keyword argument 'confirm'`` — which broke
   every LLM call on that model (including the employee wrap-up / reflection path).
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

# Runtime / LangGraph keys — never OpenAI/Anthropic chat create parameters.
NON_VENDOR_CREATE_KEYS = frozenset(
    {
        "session_key",
        "sessionKey",
        "thread_id",
        "threadId",
        "run_id",
        "runId",
        "checkpoint_id",
        "checkpoint_ns",
        "configurable",
        "local_workspace_root",
        "agent_name",
        "agent_code",
        "principal_id",
        "owner_scope_id",
        "tool_approval_replay_ids",
    }
)

# Platform control-plane keys — the capability gate's confirmation flag and friends.
# These are consumed by the platform dispatcher (``dispatch_platform_action``) and
# must never survive into a model config extra / vendor create() payload.
# NOTE: none of these are valid OpenAI / Anthropic chat-completions parameters, so
# stripping them can never drop a legitimate vendor request field.
PLATFORM_CONTROL_KEYS = frozenset(
    {
        "confirm",
        "confirmed",
        "confirm_cascade",
        "confirm_inherit_all",
        "confirm_wide_tools",
        "dry_run",
        "preview",
    }
)

# Everything that must never reach a vendor ``create()`` call.
ALL_NON_VENDOR_CREATE_KEYS = frozenset(NON_VENDOR_CREATE_KEYS | PLATFORM_CONTROL_KEYS)


def strip_non_vendor_create_keys(payload: dict[str, Any] | None, *, warn: bool = True) -> dict[str, Any]:
    """Remove runtime keys from an outgoing vendor create payload (in place)."""
    if not isinstance(payload, dict):
        return {} if payload is None else payload  # type: ignore[return-value]
    leaked = [k for k in list(payload.keys()) if k in ALL_NON_VENDOR_CREATE_KEYS]
    for key in leaked:
        payload.pop(key, None)
    if leaked and warn:
        logger.warning(
            "Stripped non-vendor create keys from chat payload: %s",
            ", ".join(sorted(leaked)),
        )
    return payload


def strip_platform_control_keys(args: dict[str, Any] | None) -> dict[str, Any]:
    """Remove platform gate flags (``confirm`` …) from an action args dict (in place).

    Used before a handler persists its args into a config row, so the gate flag is
    never stored as a model / tool / agent config extra.
    """
    if not isinstance(args, dict):
        return {}
    for key in list(args.keys()):
        if key in PLATFORM_CONTROL_KEYS:
            args.pop(key, None)
    return args


def scrub_chat_model_runtime_kwargs(model: Any) -> list[str]:
    """Drop runtime keys from ``model_kwargs`` / ``_default_params`` on a chat model."""
    removed: list[str] = []
    mk = getattr(model, "model_kwargs", None)
    if isinstance(mk, dict):
        for key in list(mk.keys()):
            if key in ALL_NON_VENDOR_CREATE_KEYS:
                mk.pop(key, None)
                removed.append(key)
    # Some LangChain versions mirror model_kwargs into _default_params eagerly.
    try:
        params = getattr(model, "_default_params", None)
        if isinstance(params, dict):
            for key in list(params.keys()):
                if key in ALL_NON_VENDOR_CREATE_KEYS:
                    params.pop(key, None)
                    if key not in removed:
                        removed.append(key)
    except Exception:
        pass
    if removed:
        logger.warning(
            "Scrubbed non-vendor keys from chat model kwargs: %s",
            ", ".join(sorted(removed)),
        )
    return removed
