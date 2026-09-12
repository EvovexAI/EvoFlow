"""Resolve whether Auto-mode sessions need extended thinking via a lightweight LLM call."""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass
from typing import Any

from evoflow.agents.lead_agent.intent_tool_profile import normalize_scenario_key
from evoflow.config.session_intent_config import get_session_intent_config

logger = logging.getLogger(__name__)

# Reuse the auto-thinking classification model across calls (it's stateless).
_auto_model_cache: dict[str, Any] = {}
# Per-session decision cache: skip LLM call on subsequent messages in same session.
_decision_cache: dict[str, AutoThinkingDecision] = {}


def _get_cached_auto_model(model_name: str) -> Any:
    from evoflow.models import create_chat_model

    cached = _auto_model_cache.get(model_name)
    if cached is not None:
        return cached
    model = create_chat_model(model_name, thinking_enabled=False, invocation_kind="session_intent")
    _auto_model_cache[model_name] = model
    return model


def _get_cached_decision(session_key: str) -> AutoThinkingDecision | None:
    return _decision_cache.get(session_key)


def _set_cached_decision(session_key: str, decision: AutoThinkingDecision) -> None:
    _decision_cache[session_key] = decision


@dataclass(frozen=True)
class AutoThinkingDecision:
    thinking_enabled: bool
    reasoning_effort: str | None = None


_THINKING_OFF = AutoThinkingDecision(thinking_enabled=False, reasoning_effort="minimum")


def _resolve_agent_scenario_thinking(model_name: str | None) -> AutoThinkingDecision:
    """Agent mode no longer auto-enables thinking — leave vendor policy alone (off/omit)."""
    del model_name
    return _THINKING_OFF


def _scenario_keys_from_raw(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    for item in raw:
        key = normalize_scenario_key(str(item or ""))
        if key and key not in out:
            out.append(key)
    return out


def _agent_scenario_keys(keys: list[str]) -> bool:
    """True when agent/workspace scenario is active (workspace is a legacy alias)."""
    return "agent" in keys or "workspace" in keys


def _is_agent_scenario_active(
    *,
    cfg: dict[str, Any] | None,
    session_key: str | None,
    thread_id: str | None,
) -> bool:
    """True when agent scenario is active (run context or persisted session)."""
    if cfg:
        if _agent_scenario_keys(_scenario_keys_from_raw(cfg.get("activated_scenarios"))):
            return True
        hint = normalize_scenario_key(str(cfg.get("intent_hint") or ""))
        if hint in ("agent", "workspace"):
            return True
        sm = str(cfg.get("session_mode") or "").strip().lower()
        if sm == "agent":
            return True
        if str(cfg.get("local_workspace_root") or "").strip():
            return True
    sk = str(session_key or "").strip()
    if sk:
        try:
            from evoflow.persistence.session_repositories import get_session_mode

            # session_mode is the single source of truth after the v75 migration
            # (the legacy scenario JSON column was dropped). "agent" mode <=> agent scenario.
            if str(get_session_mode(sk) or "").strip().lower() == "agent":
                return True
        except Exception:
            pass
    tid = str(thread_id or "").strip()
    if tid:
        try:
            from evoflow.persistence.session_repositories import (
                find_session_key_by_thread_id,
                get_session_mode,
            )

            tsk = find_session_key_by_thread_id(tid)
            if tsk and str(get_session_mode(tsk) or "").strip().lower() == "agent":
                return True
        except Exception:
            pass
    return False


def _sync_decision_to_cfg(decision: AutoThinkingDecision, cfg: dict[str, Any] | None) -> None:
    if cfg is None:
        return
    sm = str(cfg.get("session_mode") or "").strip().lower()
    if sm != "agent":
        cfg["session_mode"] = "auto"
    cfg["thinking_type"] = "auto"
    cfg["thinking_enabled"] = decision.thinking_enabled
    cfg["reasoning_effort"] = decision.reasoning_effort


def _persist_session_decision(
    session_key: str,
    decision: AutoThinkingDecision,
    *,
    session_mode: str | None = None,
) -> None:
    sk = str(session_key or "").strip()
    if not sk:
        return
    _set_cached_decision(sk, decision)
    try:
        from evoflow.persistence.session_repositories import upsert_session_row

        upsert_session_row(
            sk,
            context={
                "thinking_type": "auto",
                "thinking_enabled": decision.thinking_enabled,
                "reasoning_effort": decision.reasoning_effort,
                **({"session_mode": str(session_mode).strip()} if str(session_mode or "").strip() else {}),
            },
        )
    except Exception as e:
        logger.debug("auto thinking persist failed: %s", e)


def _parse_decision_json(text: str) -> AutoThinkingDecision | None:
    raw = str(text or "").strip()
    if not raw:
        return None
    match = re.search(r"\{[^{}]*\}", raw, re.DOTALL)
    if not match:
        return None
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    need = data.get("need_thinking")
    if isinstance(need, str):
        need_thinking = need.strip().lower() in ("true", "yes", "1")
    elif need is None:
        return None
    else:
        need_thinking = bool(need)
    effort_raw = data.get("reasoning_effort")
    effort: str | None = None
    if effort_raw is not None:
        effort = str(effort_raw).strip().lower() or None
        if effort in ("null", "none"):
            effort = None
    # Model only decides whether to think; intensity is determined by user selection / auto default
    if need_thinking:
        return AutoThinkingDecision(thinking_enabled=True, reasoning_effort=None)
    return AutoThinkingDecision(thinking_enabled=False, reasoning_effort="minimum")


def _resolve_model_name() -> str | None:
    cfg = get_session_intent_config()
    name = getattr(cfg, "auto_thinking_model_name", None) or cfg.llm_rollup_model_name
    return str(name).strip() if name else None


def resolve_auto_thinking_decision(user_message: str, *, model_name: str | None = None) -> AutoThinkingDecision | None:
    """Call a lightweight model to classify thinking need for one user turn (Auto session mode only).

    Gated by EvoPanel ``session_mode=auto`` in ``make_lead_agent`` — not by ``config.yaml`` flags.
    """
    msg = str(user_message or "").strip()
    if not msg:
        return None
    config_model = _resolve_model_name()
    try:
        from evoflow.config import get_app_config
        from evoflow.models.factory import _default_resolved_model_name

        resolved = config_model or model_name or _default_resolved_model_name(get_app_config())
        model = _get_cached_auto_model(resolved)
        prompt = (
            "You classify whether the assistant should use extended thinking/reasoning for the user's message.\n"
            'Return ONLY JSON: {"need_thinking": true|false}\n'
            "need_thinking=true for: multi-step reasoning, debugging, architecture, math, ambiguous specs, large code changes.\n"
            "need_thinking=false for: greetings, thanks, simple Q&A, formatting, short confirmations, trivial edits.\n\n"
            f"User message:\n{msg[:4000]}"
        )
        _t0_call = time.perf_counter()
        resp = model.invoke(prompt)
        _call_ms = (time.perf_counter() - _t0_call) * 1000.0
        text = str(getattr(resp, "content", "") or resp).strip()
        print(f"[AGENT-TIMING] auto_thinking_llm_call={_call_ms:.0f}ms model={resolved}", flush=True)
        decision = _parse_decision_json(text)
        if decision is None:
            logger.debug("auto thinking decision: unparseable model output: %s", text[:200])
        return decision
    except Exception as e:
        logger.warning("auto thinking decision failed: %s", e)
        return None


def apply_auto_thinking_decision(
    *,
    session_key: str | None,
    user_message: str,
    cfg: dict[str, Any] | None = None,
    thread_id: str | None = None,
    model_name: str | None = None,
) -> AutoThinkingDecision | None:
    """Classify, persist, update runtime cfg — non-blocking on first call per session.

    **Agent scenario + Auto:** do not force thinking on (vendor default / omit).

    **First message in session:** returns a default (thinking off) immediately,
    spawns a daemon thread to run the LLM classification in background.
    The real decision is cached for the *next* message.

    **Subsequent messages:** returns cached decision (microsecond, no LLM call).
    """
    msg = str(user_message or "").strip()
    if not msg:
        return None
    sk = str(session_key or "").strip()

    if _is_agent_scenario_active(cfg=cfg, session_key=sk, thread_id=thread_id):
        decision = _resolve_agent_scenario_thinking(model_name)
        _sync_decision_to_cfg(decision, cfg)
        _persist_session_decision(
            sk,
            decision,
            session_mode=str(cfg.get("session_mode") or "").strip() or None if cfg else None,
        )
        return decision

    # Fast path: cached decision from a previous message in this session.
    if sk:
        cached = _get_cached_decision(sk)
        if cached is not None:
            _sync_decision_to_cfg(cached, cfg)
            return cached

    # First message: default to no-thinking, classify in background.
    default = AutoThinkingDecision(thinking_enabled=False, reasoning_effort="minimum")

    if sk and msg:
        # Cache default immediately to prevent duplicate background threads.
        _set_cached_decision(sk, default)

        def _bg_classify() -> None:
            _t0 = time.perf_counter()
            try:
                decision = resolve_auto_thinking_decision(msg, model_name=model_name)
                if decision is None:
                    decision = AutoThinkingDecision(thinking_enabled=False, reasoning_effort="minimum")
                _persist_session_decision(sk, decision)
                _elapsed = (time.perf_counter() - _t0) * 1000.0
                print(
                    f"[AGENT-TIMING] auto_thinking_bg_classify={_elapsed:.0f}ms "
                    f"thinking={decision.thinking_enabled} effort={decision.reasoning_effort}",
                    flush=True,
                )
            except Exception as e:
                logger.warning("auto thinking bg classify failed: %s", e)

        import threading

        t = threading.Thread(target=_bg_classify, daemon=True)
        t.start()

    if cfg is not None:
        _sync_decision_to_cfg(default, cfg)
    return default