"""Orchestrate per-session tool bindings from ``SESSION_MODE_*`` enums."""

from __future__ import annotations

import logging
from collections.abc import Iterable
from typing import Any

from evoflow.agents.lead_agent.intent_tool_profile import (
    DEFAULT_SESSION_MODE,
    SESSION_MODE_CATALOG,
    bound_tools_for_session_mode,
    deferred_catalog_for_session_mode,
    normalize_scenario_key,
    normalize_session_mode,
)
from evoflow.persistence import session_tool_binding_repositories as repo
from evoflow.session_tool_binding.agent_tools import (
    bound_tools_for_session_agent,
    deferred_catalog_for_session_agent,
    effective_bound_tools_for_session_agent,
    filter_loaded_for_agent_mode,
    pending_activation_for_session_agent,
    resolve_agent_tool_names_for_session,
    resolve_session_agent_id,
)

logger = logging.getLogger(__name__)

CATALOG_SESSION_MODES = SESSION_MODE_CATALOG


def resolve_chat_session_key() -> str | None:
    try:
        from evoflow.tools.builtins.scenario_activation import _resolve_chat_session_key

        return _resolve_chat_session_key()
    except Exception:
        return None


def resolve_thread_id_from_runtime() -> str:
    try:
        from langgraph.config import get_config

        cfg = get_config() or {}
        conf = cfg.get("configurable") if isinstance(cfg, dict) else {}
        if isinstance(conf, dict):
            return str(conf.get("thread_id") or conf.get("threadId") or "").strip()
    except Exception:
        pass
    return ""


def _normalized_active_scenarios(scenarios: Iterable[str] | None) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for raw in scenarios or []:
        key = normalize_scenario_key(str(raw or "").strip())
        if not key or key == "ask" or key in seen:
            continue
        seen.add(key)
        out.append(key)
    return out


def get_persisted_session_mode(session_key: str) -> str:
    """Effective binding mode from chat_sessions (derived from ``session_mode`` after v75)."""
    return resolve_persisted_binding_mode(session_key)


def resolve_persisted_binding_mode(session_key: str) -> str:
    sk = str(session_key or "").strip()
    if not sk:
        return DEFAULT_SESSION_MODE
    try:
        from evoflow.persistence.session_repositories import (
            derive_session_mode,
            get_session_activated_scenarios,
            get_session_mode,
        )

        active = get_session_activated_scenarios(sk)
        if active:
            return normalize_session_mode(derive_session_mode(active))
        stored = get_session_mode(sk)
        if stored:
            return normalize_session_mode(stored)
    except Exception:
        pass
    return DEFAULT_SESSION_MODE


def resolve_current_binding_mode(
    session_key: str,
    active_scenarios: Iterable[str] | None,
) -> str:
    active = _normalized_active_scenarios(active_scenarios)
    if active:
        from evoflow.persistence.session_repositories import derive_session_mode

        return normalize_session_mode(derive_session_mode(active))
    return resolve_persisted_binding_mode(session_key)


def resolve_runtime_tool_mode(
    session_key: str | None,
    active_scenarios: Iterable[str] | None,
) -> str:
    """Mode for this model turn: runtime scenarios win; else persisted session_mode / activated_scenarios."""
    active = _normalized_active_scenarios(active_scenarios)
    if active:
        from evoflow.persistence.session_repositories import derive_session_mode

        return normalize_session_mode(derive_session_mode(active))
    sk = str(session_key or "").strip()
    if sk:
        return resolve_persisted_binding_mode(sk)
    return DEFAULT_SESSION_MODE


def sync_runtime_tool_snapshot(
    *,
    session_key: str | None,
    active_scenarios: Iterable[str] | None,
    model_bound_tools: list[str] | None,
    loaded_deferred: list[str] | None = None,
) -> dict[str, Any] | None:
    """Write ``evoflow_chat_sessions`` tool columns from the actual model-bound tool list."""
    sk = str(session_key or "").strip()
    if not sk:
        return None
    try:
        mode = resolve_runtime_tool_mode(sk, active_scenarios)
        loaded = filter_loaded_for_agent_mode(sk, mode, loaded_deferred) if mode != "ask" else []
        pending = (
            pending_activation_for_session_agent(sk, mode, loaded_deferred=loaded)
            if mode != "ask"
            else []
        )
        # Intersect model-bound tools with the mode's allowed catalog to
        # prevent cross-mode tool residue (e.g. plan-only tools surviving a
        # plan→agent switch) from leaking into active_tools_json.
        allowed = set(bound_tools_for_session_agent(sk, mode)) | set(loaded)
        bound = sorted(
            {str(n or "").strip().lower() for n in (model_bound_tools or []) if str(n or "").strip()}
            & allowed
        )
        return repo.sync_chat_session_tool_snapshot(
            sk,
            current_mode=mode,
            active_tools=bound,
            pending_tools=pending,
        )
    except Exception as exc:
        logger.debug("[SessionToolBinding] runtime snapshot sync skipped: %s", exc, exc_info=True)
        return None


def binding_scenario_key(
    scenarios: Iterable[str] | None,
    *,
    session_key: str | None = None,
) -> str:
    if session_key:
        return resolve_current_binding_mode(session_key, scenarios)
    active = _normalized_active_scenarios(scenarios)
    if active:
        from evoflow.persistence.session_repositories import derive_session_mode

        return normalize_session_mode(derive_session_mode(active))
    return DEFAULT_SESSION_MODE


def primary_scenario_key(scenarios: Iterable[str] | None) -> str:
    return binding_scenario_key(scenarios)


def filter_loaded_for_mode(
    mode: str,
    names: list[str] | None,
    *,
    session_key: str | None = None,
) -> list[str]:
    sk = str(session_key or "").strip()
    if sk:
        return filter_loaded_for_agent_mode(sk, mode, names)
    try:
        from evoflow.session_tool_binding.agent_tools import _tool_search_enabled

        if not _tool_search_enabled():
            return []
    except Exception:
        pass
    allowed = {str(t).strip().lower() for t in deferred_catalog_for_session_mode(mode)}
    if not allowed:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for raw in names or []:
        n = str(raw or "").strip().lower()
        if not n or n in seen or n not in allowed:
            continue
        seen.add(n)
        out.append(n)
    return out


def effective_bound_tools_for_mode(
    mode: str,
    *,
    loaded_deferred: Iterable[str] | None,
    session_key: str | None = None,
) -> list[str]:
    sk = str(session_key or "").strip()
    loaded = [str(x).strip().lower() for x in (loaded_deferred or []) if str(x or "").strip()]
    if sk:
        return effective_bound_tools_for_session_agent(sk, mode, loaded_deferred=loaded)
    try:
        from evoflow.session_tool_binding.agent_tools import _tool_search_enabled
        from evoflow.agents.lead_agent.intent_tool_profile import flat_bound_tool_names_for_session_mode

        if not _tool_search_enabled():
            return sorted(flat_bound_tool_names_for_session_mode(mode))
    except Exception:
        pass
    bound = [str(t).strip().lower() for t in bound_tools_for_session_mode(mode)]
    return sorted({*bound, *loaded})


def pending_activation_for_mode(
    mode: str,
    *,
    loaded_deferred: Iterable[str] | None,
    session_key: str | None = None,
) -> list[str]:
    sk = str(session_key or "").strip()
    loaded = [str(x).strip().lower() for x in (loaded_deferred or []) if str(x or "").strip()]
    if sk:
        return pending_activation_for_session_agent(sk, mode, loaded_deferred=loaded)
    try:
        from evoflow.session_tool_binding.agent_tools import _tool_search_enabled

        if not _tool_search_enabled():
            return []
    except Exception:
        pass
    catalog = {str(t).strip().lower() for t in deferred_catalog_for_session_mode(mode)}
    return sorted(catalog - set(loaded))


def _default_eager_for_session(session_key: str, mode: str) -> list[str]:
    return bound_tools_for_session_agent(session_key, mode)


def _refresh_session_tool_state(session_key: str, mode: str) -> dict[str, Any]:
    sk = str(session_key or "").strip()
    m = normalize_session_mode(mode)
    if not sk:
        return {}
    return repo.sync_chat_session_tool_snapshot(sk, current_mode=m)


def load_loaded_deferred_for_mode(session_key: str, mode: str) -> list[str]:
    sk = str(session_key or "").strip()
    m = normalize_session_mode(mode)
    if not sk:
        return []
    return filter_loaded_for_agent_mode(sk, m, repo.get_loaded_deferred_for_scenario(sk, m))


def load_active_loaded_deferred(
    session_key: str,
    active_scenarios: Iterable[str] | None,
) -> list[str]:
    sk = str(session_key or "").strip()
    mode = resolve_current_binding_mode(sk, active_scenarios)
    return load_loaded_deferred_for_mode(sk, mode)


def _upsert_binding_snapshot(
    session_key: str,
    mode_key: str,
    *,
    eager_tools: list[str] | None,
    loaded_deferred: list[str] | None,
    event_type: str,
    thread_id: str | None = None,
    detail: dict[str, Any] | None = None,
    update_current_state: bool = True,
) -> dict[str, list[str]]:
    sk = str(session_key or "").strip()
    mode = normalize_session_mode(mode_key)
    if not sk or not mode:
        return {"eager_tools": [], "loaded_deferred": []}
    eager = list(
        eager_tools if eager_tools is not None else _default_eager_for_session(sk, mode)
    )
    deferred = filter_loaded_for_agent_mode(sk, mode, loaded_deferred)
    # Single INSERT into the trajectory table merges the snapshot write and the
    # binding event (previously a two-step upsert + append_binding_event flow).
    merged_detail = {
        **(detail or {}),
        "session_mode": mode,
        "agent_id": resolve_session_agent_id(sk),
        "eager_tools": eager,
        "loaded_deferred": deferred,
        "effective_tools": effective_bound_tools_for_mode(
            mode, loaded_deferred=deferred, session_key=sk
        ),
        "pending_activation": pending_activation_for_mode(
            mode, loaded_deferred=deferred, session_key=sk
        ),
    }
    saved = repo.upsert_scenario_binding(
        sk,
        mode,
        eager_tools=eager,
        loaded_deferred=deferred,
        thread_id=thread_id,
        event_type=event_type,
        detail=merged_detail,
    )
    if update_current_state:
        current = resolve_persisted_binding_mode(sk)
        if mode == current:
            _refresh_session_tool_state(sk, mode)
    return saved


def repair_session_tool_state(session_key: str) -> dict[str, Any]:
    """Align ``evoflow_chat_sessions`` active/pending tool columns with mode cache."""
    sk = str(session_key or "").strip()
    if not sk:
        return {}
    mode = resolve_persisted_binding_mode(sk)
    return _refresh_session_tool_state(sk, mode)


def ensure_session_binding_catalog(
    session_key: str,
    *,
    thread_id: str | None = None,
) -> dict[str, dict[str, list[str]]]:
    """Record one ``session_init`` trajectory row for the current scenario.

    Replaces the legacy three-mode pre-seed loop. Only the currently active
    scenario gets a row; the returned dict keeps the ``{mode: {...}}`` shape for
    backward compatibility (a single entry for the current mode).
    """
    sk = str(session_key or "").strip()
    if not sk:
        return {}
    mode = resolve_persisted_binding_mode(sk)
    eager = _default_eager_for_session(sk, mode)
    existing = repo.get_scenario_binding(sk, mode)
    deferred = (
        filter_loaded_for_agent_mode(sk, mode, list(existing.get("loaded_deferred") or []))
        if existing
        else []
    )
    saved = repo.upsert_scenario_binding(
        sk,
        mode,
        eager_tools=eager,
        loaded_deferred=deferred,
        thread_id=thread_id,
        event_type="session_init",
        detail={"catalog_mode": mode},
    )
    repair_session_tool_state(sk)
    return {mode: saved}


def seed_session_tool_bindings(session_key: str, *, thread_id: str | None = None) -> None:
    """Bind default ask/agent/plan tool rows when a chat session is created."""
    ensure_session_binding_catalog(session_key, thread_id=thread_id)
    logger.info("[SessionToolBinding] seeded catalog for session=%s", session_key)


def ensure_session_binding_record(
    *,
    session_key: str | None,
    active_scenarios: Iterable[str] | None,
    state_loaded: list[str] | None = None,
    thread_id: str | None = None,
    force: bool = False,
) -> dict[str, list[str]] | None:
    sk = str(session_key or "").strip()
    if not sk:
        return None
    ensure_session_binding_catalog(sk, thread_id=thread_id)
    mode = resolve_current_binding_mode(sk, active_scenarios)
    eager = _default_eager_for_session(sk, mode)
    deferred = filter_loaded_for_agent_mode(sk, mode, state_loaded)
    existing = repo.get_scenario_binding(sk, mode)
    if existing and not deferred and mode != "ask" and not force:
        deferred = filter_loaded_for_agent_mode(sk, mode, list(existing.get("loaded_deferred") or []))
    if (
        not force
        and existing
        and list(existing.get("eager_tools") or []) == eager
        and list(existing.get("loaded_deferred") or []) == deferred
    ):
        return {
            "eager_tools": list(existing.get("eager_tools") or []),
            "loaded_deferred": list(existing.get("loaded_deferred") or []),
        }
    event_type = "session_init" if not existing else "session_sync"
    return _upsert_binding_snapshot(
        sk,
        mode,
        eager_tools=eager,
        loaded_deferred=deferred,
        event_type=event_type,
        thread_id=thread_id,
        detail={
            "active_scenarios": list(active_scenarios or []),
            "session_mode": mode,
        },
    )


def _mode_from_scenario_payload(
    payload: dict[str, Any],
    session_key: str,
    active_scenarios: Iterable[str] | None,
) -> str:
    action = str(payload.get("action") or "").strip().lower()
    key = normalize_scenario_key(str(payload.get("scenario_key") or ""))
    if action == "activate" and key in SESSION_MODE_CATALOG:
        return key
    return resolve_current_binding_mode(session_key, active_scenarios)


def on_scenario_tool_success(
    *,
    session_key: str | None,
    current_loaded: list[str] | None,
    payload: dict[str, Any],
    thread_id: str | None = None,
) -> list[str]:
    sk = str(session_key or "").strip()
    tid = str(thread_id or resolve_thread_id_from_runtime() or "").strip()
    action = str(payload.get("action") or "").strip().lower()
    new_active = _normalized_active_scenarios(payload.get("all_active_scenarios") or [])
    loaded_now = [str(x).strip().lower() for x in (current_loaded or []) if str(x or "").strip()]

    if sk:
        if action == "activate":
            prev_raw = payload.get("previous_scenarios") or []
            prev_active = _normalized_active_scenarios(
                [s for s in prev_raw if str(s or "").strip() and str(s).strip().lower() != "none"]
            )
            old_mode = resolve_current_binding_mode(sk, prev_active)
            new_mode = _mode_from_scenario_payload(payload, sk, new_active)
            if loaded_now or old_mode != new_mode:
                _upsert_binding_snapshot(
                    sk,
                    old_mode,
                    eager_tools=_default_eager_for_session(sk, old_mode),
                    loaded_deferred=loaded_now,
                    event_type="scenario_switch_out",
                    thread_id=tid,
                    detail={"action": action, "new_active": new_active, "new_mode": new_mode},
                    update_current_state=False,
                )
        elif action == "deactivate":
            deactivated = normalize_scenario_key(str(payload.get("scenario_key") or ""))
            if deactivated in SESSION_MODE_CATALOG and deactivated != "ask":
                _upsert_binding_snapshot(
                    sk,
                    deactivated,
                    eager_tools=_default_eager_for_session(sk, deactivated),
                    loaded_deferred=loaded_now,
                    event_type="scenario_deactivate",
                    thread_id=tid,
                    detail={"remaining": new_active},
                    update_current_state=False,
                )

    restored = (
        load_loaded_deferred_for_mode(sk, _mode_from_scenario_payload(payload, sk, new_active))
        if sk
        else []
    )
    if sk:
        new_mode = _mode_from_scenario_payload(payload, sk, new_active)
        # Append a single switch-in row for the new scenario (restored from the
        # latest trajectory row of that scenario). No catalog pre-seed here —
        # the trajectory is append-only and the switch_in row supersedes it.
        _upsert_binding_snapshot(
            sk,
            new_mode,
            eager_tools=_default_eager_for_session(sk, new_mode),
            loaded_deferred=restored,
            event_type="scenario_switch_in",
            thread_id=tid,
            detail={"action": action, "active_scenarios": new_active},
        )
        logger.info(
            "[SessionToolBinding] scenario %s -> mode=%s restored_deferred=%s session=%s",
            action,
            new_mode,
            restored,
            sk,
        )
    return restored


def persist_tool_search_loaded(
    *,
    session_key: str | None,
    active_scenarios: Iterable[str] | None,
    loaded_names: list[str] | None,
    thread_id: str | None = None,
) -> list[str]:
    sk = str(session_key or "").strip()
    if not sk:
        return [str(x).strip().lower() for x in (loaded_names or []) if str(x or "").strip()]
    mode = resolve_current_binding_mode(sk, active_scenarios)
    filtered = filter_loaded_for_agent_mode(sk, mode, loaded_names)
    if mode == "ask":
        return []
    # Append a single tool_search_load trajectory row (no catalog pre-seed).
    saved = _upsert_binding_snapshot(
        sk,
        mode,
        eager_tools=_default_eager_for_session(sk, mode),
        loaded_deferred=filtered,
        event_type="tool_search_load",
        thread_id=thread_id,
        detail={"active_scenarios": list(active_scenarios or []), "session_mode": mode},
    )
    return list(saved.get("loaded_deferred") or [])


def hydrate_loaded_deferred_for_active_scenarios(
    *,
    session_key: str | None,
    active_scenarios: Iterable[str] | None,
    thread_id: str | None = None,
) -> list[str]:
    sk = str(session_key or "").strip()
    if not sk:
        return []
    ensure_session_binding_record(
        session_key=sk,
        active_scenarios=active_scenarios,
        thread_id=thread_id,
    )
    return load_active_loaded_deferred(sk, active_scenarios)


def sync_loaded_deferred_state(
    *,
    session_key: str | None,
    active_scenarios: Iterable[str] | None,
    state_loaded: list[str] | None,
    thread_id: str | None = None,
) -> list[str] | None:
    sk = str(session_key or "").strip()
    if not sk:
        return None
    ensure_session_binding_record(
        session_key=sk,
        active_scenarios=active_scenarios,
        state_loaded=state_loaded,
        thread_id=thread_id,
    )
    expected = load_active_loaded_deferred(sk, active_scenarios)
    current = [str(x).strip().lower() for x in (state_loaded or []) if str(x or "").strip()]
    if current == expected:
        return None
    mode = resolve_current_binding_mode(sk, active_scenarios)
    if mode != "ask" and current and set(expected).issubset(set(current)):
        persisted = persist_tool_search_loaded(
            session_key=sk,
            active_scenarios=active_scenarios,
            loaded_names=current,
            thread_id=thread_id,
        )
        # Return the mode-filtered list when it differs from the current
        # thread state, so ToolBindingSyncMiddleware updates the state and
        # purges cross-mode tool residue (e.g. plan-only tools left over
        # after a plan→agent switch). Otherwise the stale tools persist in
        # state forever, leaking into active_tools_json every turn.
        if persisted != current:
            return persisted
        return None
    if current != expected:
        return expected
    return None


def build_session_tool_binding_view(
    *,
    session_key: str,
    active_scenarios: Iterable[str] | None,
) -> dict[str, Any]:
    sk = str(session_key or "").strip()
    active = _normalized_active_scenarios(active_scenarios)
    mode = resolve_current_binding_mode(sk, active_scenarios)
    persisted_mode = get_persisted_session_mode(sk)
    per_mode = repo.list_full_scenario_bindings_for_session(sk) if sk else {}
    row = per_mode.get(mode) or {}
    loaded = filter_loaded_for_agent_mode(sk, mode, list(row.get("loaded_deferred") or []))
    eager = _default_eager_for_session(sk, mode) if sk else list(bound_tools_for_session_mode(mode))
    deferred_catalog = deferred_catalog_for_session_agent(sk, mode) if sk else list(
        deferred_catalog_for_session_mode(mode)
    )
    effective = effective_bound_tools_for_mode(mode, loaded_deferred=loaded, session_key=sk or None)
    pending = pending_activation_for_mode(mode, loaded_deferred=loaded, session_key=sk or None)
    agent_tools = sorted(resolve_agent_tool_names_for_session(sk)) if sk else []
    agent_id = resolve_session_agent_id(sk) if sk else ""
    return {
        "session_key": sk,
        "agent_id": agent_id,
        "agent_tools": agent_tools,
        "session_mode": persisted_mode,
        "current_mode": mode,
        "active_scenarios": active,
        "primary_scenario": mode,
        "core_tools": list(bound_tools_for_session_mode("ask")),
        "bound_tools": eager,
        "eager_tools": eager,
        "loaded_deferred": loaded,
        "deferred_catalog": deferred_catalog,
        "pending_activation": pending,
        "deferred_not_yet_loaded": pending,
        "unbound_tools": pending,
        "effective_bound_tools": effective,
        "effective_tools": effective,
        "active_tools": effective,
        "pending_tools": pending,
        "mode_cache_by_mode": {k: dict(v) for k, v in per_mode.items()},
        "bindings_by_mode": {k: dict(v) for k, v in per_mode.items()},
        "loaded_deferred_by_scenario": {k: dict(v) for k, v in per_mode.items()},
    }
