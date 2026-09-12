"""Rebuild the lead system prompt when scenarios, model-visible tools, or on-disk role files change.

**Why**
- ``make_lead_agent`` binds ``apply_prompt_template(...)`` once; ``scenario()`` only patched policy via
  ``ScenarioRuntimeHintMiddleware``, so long sessions could drift from ``TASK_SCENARIO_PROFILES``.
- Tool list visible to the model is filtered per turn (``DeferredToolFilterMiddleware``); the tool catalog
  section in the system prompt should match ``request.tools``.
- ``evf_dynamic_prompt_meta["custom_system_prompt"]`` is a snapshot from graph compile time; without a
  disk fingerprint, edits to ``agents/<role>/config.yaml`` or ``SOUL.md`` would not refresh until scenario
  or tool lists changed.

**How**
- Runs in ``wrap_model_call`` **after** ``DeferredToolFilterMiddleware`` (outer-first chain) and **before**
  ``ScenarioRuntimeHintMiddleware``, so ``policy_excerpt`` still appends on the same turn after ``scenario`` succeeds.
- Skips work when a per-thread fingerprint is unchanged.
- **Intra-turn** (same user message, only scenario keys / scenario tool JSON changed): skip full
  ``apply_prompt_template``; ``scenario`` tool + ``ScenarioRuntimeHintMiddleware`` supply ``policy_excerpt``.
- **New user message alone**: keep last assembled system prompt (Runtime: stable
  ``base_instructions`` across turns; history carries the new user text).
- **Scenario / tools / role / collab / MCP change**: full rebuild via ``apply_prompt_template``.
**Inputs**
- ``configurable["evf_dynamic_prompt_meta"]`` set in ``make_lead_agent`` (all_tool_names, skills, workspace, …).
- Current scenarios: ``effective_activated_scenario_keys`` + ``ordered_scenario_keys_for_display``.
- ``collab_phase`` merged from disk like ``plan_guard`` / ``make_lead_agent``.
"""

from __future__ import annotations

import hashlib
import threading
import time
from pathlib import Path
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

import logging

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest
from langchain_core.messages import SystemMessage

logger = logging.getLogger(__name__)

# agent_code -> (monotonic_ts, signature)
_ROLE_DISK_SIG_CACHE: dict[str, tuple[float, str]] = {}
_ROLE_DISK_SIG_TTL_S = 2.0


def _tool_names_sorted(tools: list[Any] | None) -> list[str]:
    out: list[str] = []
    for t in tools or []:
        n = str(getattr(t, "name", "") or "").strip()
        if n:
            out.append(n)
    return sorted(set(out))


def _agent_role_disk_signature(agent_name: str | None) -> str:
    """Mtime signature for role config + SOUL so EvoPanel edits invalidate the prompt cache."""
    code = (str(agent_name or "").strip() or "main").lower()
    # Hot path: reuse for a short TTL — full stat every wrap was ~tens of ms on Windows.
    now = time.monotonic()
    cached = _ROLE_DISK_SIG_CACHE.get(code)
    if cached is not None and (now - cached[0]) < _ROLE_DISK_SIG_TTL_S:
        return cached[1]
    try:
        from evoflow.config.agents_config import SOUL_FILENAME
        from evoflow.config.paths import get_paths

        d = get_paths().agent_dir(code)

        def _mt(p: Path) -> str:
            try:
                return str(int(p.stat().st_mtime_ns)) if p.exists() else "0"
            except OSError:
                return "0"

        legacy = f"{_mt(d / 'config.yaml')}:{_mt(d / SOUL_FILENAME)}"
        try:
            from evoflow.assets.paths import EntityRef, profile_path

            asset_soul = profile_path(EntityRef("agent", code), "SOUL.md")
            asset_system = profile_path(EntityRef("agent", code), "system.md")
            assets_sig = f"{_mt(asset_soul)}:{_mt(asset_system)}"
        except Exception:
            assets_sig = "0:0"
        sig = f"{legacy}|{assets_sig}"
    except Exception:
        sig = "0:0|0:0"
    _ROLE_DISK_SIG_CACHE[code] = (now, sig)
    if len(_ROLE_DISK_SIG_CACHE) > 64:
        oldest = next(iter(_ROLE_DISK_SIG_CACHE))
        _ROLE_DISK_SIG_CACHE.pop(oldest, None)
    return sig


def _latest_human_index(messages: list[Any]) -> int:
    for idx in range(len(messages or []) - 1, -1, -1):
        t = str(getattr(messages[idx], "type", None) or "").strip().lower()
        if t in {"human", "user"}:
            return idx
    return -1


def _human_turn_fingerprint(messages: list[Any]) -> str:
    """Stable id for the latest user turn (new user message => full system prompt rebuild)."""
    idx = _latest_human_index(messages)
    if idx < 0:
        return "0"
    m = messages[idx]
    preview = _latest_human_preview(messages)
    role = str(getattr(m, "id", "") or getattr(m, "name", "") or "")
    blob = f"{idx}:{role}:{preview}".encode("utf-8", errors="ignore")
    return hashlib.sha256(blob).hexdigest()[:20]


def _mission_state_fingerprint(thread_id: str) -> str:
    """Invalidate cached system prompt when async mission/intent analysis writes a new snapshot."""
    tid = str(thread_id or "").strip()
    if not tid:
        return "0"
    try:
        from evoflow.agents.mission_state.config import MISSION_STATE_ENABLED
        from evoflow.agents.mission_state.storage import load_mission_state

        if not MISSION_STATE_ENABLED:
            return "0"
        ms = load_mission_state(tid)
        if ms is None:
            return "none"
        primary = str(ms.primary_objective or "").strip()
        primary_fp = hashlib.sha256(primary.encode("utf-8", errors="ignore")).hexdigest()[:10] if primary else "empty"
        return f"v{int(ms.version or 0)}|t{str(ms.turn_id or '')[:12]}|ts{int(ms.ts_ms or 0)}|p{primary_fp}"
    except Exception:
        return "err"


def _sig_parts(sig: str) -> list[str]:
    return str(sig or "").split("::")


def _system_prompt_structure_key(sig: str) -> str:
    """Fingerprint parts that require ``apply_prompt_template`` (exclude turn-tail).

    Layout: 0 thread, 1 scenario, 2 tools, 3 role_disk, 4 collab_phase, 5 collab_rt,
    6 scenario_tool, 7 human_turn, 8 mission, 9 mcp.
    Human turn + mission are turn-tail only (runtime keeps base instructions stable).
    """
    parts = _sig_parts(sig)
    if len(parts) < 10:
        return sig
    return "::".join([*parts[0:7], parts[9]])


def _is_intra_turn_scenario_only_change(prev_sig: str | None, new_sig: str) -> bool:
    """Same user turn: scenario tool / keys changed — defer full prompt; use tool ``policy_excerpt``."""
    if not prev_sig or not new_sig:
        return False
    prev, new = _sig_parts(prev_sig), _sig_parts(new_sig)
    if len(prev) != len(new) or len(new) < 10:
        return False
    # Same human turn (7); structure otherwise equal except scenario (1) and/or scenario_tool (6).
    if prev[7] != new[7]:
        return False
    if _system_prompt_structure_key(prev_sig) == _system_prompt_structure_key(new_sig):
        return False
    for i in (0, 2, 3, 4, 5, 8, 9):
        if prev[i] != new[i]:
            return False
    return prev[1] != new[1] or prev[6] != new[6]


def _messages_have_scenario_tool(messages: list[Any] | None) -> bool:
    """True when transcript contains a ``scenario`` tool result (activation / update)."""
    from langchain_core.messages import ToolMessage

    for m in list(messages or [])[-48:]:
        if not (isinstance(m, ToolMessage) or str(getattr(m, "type", None) or "").strip().lower() == "tool"):
            continue
        if str(getattr(m, "name", "") or "").strip().lower() == "scenario":
            return True
    return False


def _keys_are_session_mode_defaults(keys: frozenset[str] | set[str], session_mode: str | None) -> bool:
    """Session-mode profiles (agent/plan/…) are stable; they alone must not force disk scans."""
    try:
        from evoflow.agents.lead_agent.intent_tool_profile import scenario_keys_from_session_mode

        mode_keys = {str(k).strip() for k in scenario_keys_from_session_mode(session_mode) if str(k).strip()}
    except Exception:
        mode_keys = set()
    if not mode_keys:
        return False
    return set(keys) <= mode_keys


def _latest_human_preview(messages: list[Any]) -> str:
    for m in reversed(messages or []):
        t = str(getattr(m, "type", None) or "").strip().lower()
        if t not in {"human", "user"}:
            continue
        c = getattr(m, "content", "")
        if isinstance(c, str):
            return c.strip()[:2000]
        if isinstance(c, list):
            parts: list[str] = []
            for x in c:
                if isinstance(x, str):
                    parts.append(x)
                elif isinstance(x, dict) and isinstance(x.get("text"), str):
                    parts.append(x["text"])
            return "".join(parts).strip()[:2000]
        return str(c or "").strip()[:2000]
    return ""


def _merged_runtime_context(request: ModelRequest) -> dict[str, Any]:
    """Merge LangGraph ``runtime.context`` with per-run ``configurable`` (``make_lead_agent`` writes meta there)."""
    from evoflow.agents.lead_agent.runtime_context import merge_model_request_runtime_context

    return merge_model_request_runtime_context(request)


def _resolve_prompt_meta(ctx: dict[str, Any]) -> dict[str, Any]:
    """``evf_dynamic_prompt_meta`` from context, per-run bind, or LangGraph configurable."""
    raw = ctx.get("evf_dynamic_prompt_meta")
    if isinstance(raw, dict) and raw:
        return raw
    try:
        from evoflow.agents.lead_agent.dynamic_prompt_run import get_bound_dynamic_prompt_meta

        bound = get_bound_dynamic_prompt_meta()
        if bound:
            return bound
    except Exception:
        pass
    try:
        from langgraph.config import get_config

        conf = get_config()
        cfg = conf.get("configurable") if isinstance(conf, dict) else None
        if isinstance(cfg, dict):
            meta = cfg.get("evf_dynamic_prompt_meta")
            if isinstance(meta, dict) and meta:
                return meta
    except Exception:
        pass
    return {}


def _scenario_tool_results_fingerprint(messages: list[Any]) -> str:
    """Short hash of recent ``scenario`` tool JSON bodies.

    After ``scenario(activate=…)``, scenario keys / ContextVar / disk can lag the first model step
    that consumes the ToolMessage; this hash still changes so ``apply_prompt_template`` runs and
    the system prompt matches the activated scenario profile.
    """
    from langchain_core.messages import ToolMessage

    parts: list[str] = []
    for m in list(messages or [])[-48:]:
        if not (isinstance(m, ToolMessage) or str(getattr(m, "type", None) or "").strip().lower() == "tool"):
            continue
        if str(getattr(m, "name", "") or "").strip().lower() != "scenario":
            continue
        parts.append(str(getattr(m, "content", "") or ""))
    if not parts:
        return ""
    blob = "\n<<<\n".join(parts).encode("utf-8", errors="ignore")
    return hashlib.sha256(blob).hexdigest()[:24]


class DynamicSystemPromptOnScenarioMiddleware(AgentMiddleware[AgentState]):
    """Replace ``ModelRequest.system_message`` when scenario, tools, or on-disk role files change."""

    state_schema = AgentState
    _lock = threading.Lock()
    _last_sig_by_thread: dict[str, str] = {}
    # Last fully assembled system text (includes memory/profile). Reuse on human-only
    # turns — must NOT fall back to compile-time system_message (that drops memory).
    _last_system_by_thread: dict[str, str] = {}

    def _fingerprint(
        self,
        *,
        thread_id: str,
        scenario_csv: str,
        tools_sorted: list[str],
        role_disk: str,
        collab_rt: str,
        collab_phase_fp: str,
        scenario_tool_fp: str,
        human_turn_fp: str,
        mission_state_fp: str,
        mcp_fp: str,
    ) -> str:
        cp = str(collab_phase_fp or "")
        crt = str(collab_rt or "")
        st = str(scenario_tool_fp or "")
        ht = str(human_turn_fp or "")
        msf = str(mission_state_fp or "")
        mcp = str(mcp_fp or "")
        return (
            f"{thread_id}::{scenario_csv}::{'|'.join(tools_sorted)}::{role_disk}::{cp}::{crt}::{st}::{ht}::{msf}::{mcp}"
        )

    def _apply_proactive_duty_system(self, request: ModelRequest, ctx: dict[str, Any]) -> ModelRequest:
        """Skip chat prompt templates; set self-contained duty brief + live status footer."""
        from langchain_core.messages import SystemMessage

        from evoflow.agents.middlewares.proactive_tool_middleware import (
            _DUTY_FOOTER_TAG,
            _proactive_duty_prompt,
            analyze_proactive_duty_state,
            format_proactive_duty_status_footer,
        )
        from evoflow.proactive.prompt import compose_proactive_system_message

        duty = str(ctx.get("proactive_system_prompt") or "").strip()
        if not duty:
            try:
                duty = _proactive_duty_prompt(request.runtime)
            except Exception:
                duty = ""
        brief = compose_proactive_system_message(duty)
        messages = list((request.state or {}).get("messages") or []) if isinstance(request.state, dict) else []
        if not messages:
            messages = list(getattr(request, "messages", None) or [])
        footer = format_proactive_duty_status_footer(analyze_proactive_duty_state(messages))
        text = brief.rstrip()
        if footer and _DUTY_FOOTER_TAG not in text:
            text = f"{text}\n\n{footer}"
        agent_name_str = str(
            ctx.get("proactive_agent_code")
            or ctx.get("agent_name")
            or (_resolve_prompt_meta(ctx) or {}).get("agent_name")
            or "proactive"
        )
        logger.info(
            "DynamicSystemPromptOnScenario: duty-only system agent=%s bytes=%d",
            agent_name_str,
            len(text.encode("utf-8", errors="ignore")),
        )
        return request.override(system_message=SystemMessage(content=text))

    def _maybe_rebuild_system_message(self, request: ModelRequest) -> ModelRequest:
        ctx = _merged_runtime_context(request)

        # Duty shift only: engine/cron patrol — never treat user chat in proactive:{code}
        # as a duty handbook run (users may talk to the employee anytime).
        try:
            from evoflow.agents.middlewares.proactive_tool_middleware import is_proactive_duty_run

            if is_proactive_duty_run(request.runtime):
                return self._apply_proactive_duty_system(request, ctx)
        except Exception:
            logger.debug("proactive duty-only system path failed; falling through", exc_info=True)

        meta = _resolve_prompt_meta(ctx)
        if not meta:
            logger.warning("DynamicSystemPromptOnScenario: no prompt meta; keeping compile-time system prompt")
            return request

        messages = list((request.state or {}).get("messages") or []) if isinstance(request.state, dict) else []
        from evoflow.agents.lead_agent.intent_tool_profile import ordered_scenario_keys_for_display
        from evoflow.agents.middlewares.plan_guard_middleware import effective_activated_scenario_keys

        keys = effective_activated_scenario_keys(request.runtime, messages)
        scen_list = ordered_scenario_keys_for_display(keys)
        scenario_csv = ",".join(scen_list) if scen_list else ""
        session_mode = str(ctx.get("session_mode") or "").strip().lower() or None
        tools_sorted = _tool_names_sorted(list(request.tools or []))
        tid = str(ctx.get("thread_id") or "").strip() or "_none_"
        agent_name_str = str(meta.get("agent_name") or "main").strip() or "main"
        role_disk = _agent_role_disk_signature(agent_name_str)
        tid_m = str(ctx.get("thread_id") or "").strip()
        collab_phase_fp = str(ctx.get("collab_phase") or "").strip().lower()
        # session_mode=agent always yields scenario keys; that alone must not force
        # disk-backed collab / scenario-tool fingerprints every wrap (~100–300ms).
        collab_active = bool(collab_phase_fp and collab_phase_fp not in {"", "idle", "none"})
        if not keys:
            dynamic_scenarios = False
        elif collab_active or not _keys_are_session_mode_defaults(keys, session_mode):
            dynamic_scenarios = True
        else:
            dynamic_scenarios = _messages_have_scenario_tool(messages)
        # Pure chat / idle: skip disk-backed collab merge (was ~100ms+ per wrap on Windows).
        if tid_m and (dynamic_scenarios or collab_active):
            try:
                from evoflow.collab.thread_collab import load_merged_collab_phase
                from evoflow.config.paths import get_paths

                collab_phase_fp = load_merged_collab_phase(get_paths(), tid_m, ctx.get("collab_phase"))
            except Exception:
                pass
        # Pure chat: skip disk-backed collab snapshot in fingerprint (was forcing rebuild every turn).
        collab_rt = ""
        if tid_m and dynamic_scenarios:
            try:
                from evoflow.agents.lead_agent.prompt import collab_runtime_state_fingerprint

                collab_rt = collab_runtime_state_fingerprint(tid_m)
            except Exception:
                collab_rt = ""
        scenario_tool_fp = (
            _scenario_tool_results_fingerprint(messages) if dynamic_scenarios else ""
        )
        human_turn_fp = _human_turn_fingerprint(messages)
        if tid_m and dynamic_scenarios:
            try:
                from evoflow.exploration.exploration_budget import maybe_reset_exploration_budget_on_turn

                maybe_reset_exploration_budget_on_turn(tid_m, human_turn_fp)
            except Exception:
                pass
        # Mission is turn-tail only; do not rebuild system when mission snapshot changes.
        mission_state_fp = "0"
        mcp_fp = ""
        if meta.get("mcp_native") or meta.get("mcp_servers") is not None:
            from evoflow.mcp.native_prompt import mcp_native_prompt_fingerprint

            mcp_binding = meta.get("mcp_servers")
            mcp_fp = mcp_native_prompt_fingerprint(
                mcp_binding if isinstance(mcp_binding, list) or mcp_binding is None else None
            )
        sig = self._fingerprint(
            thread_id=tid,
            scenario_csv=scenario_csv,
            tools_sorted=tools_sorted,
            role_disk=role_disk,
            collab_rt=collab_rt,
            collab_phase_fp=collab_phase_fp,
            scenario_tool_fp=scenario_tool_fp,
            human_turn_fp=human_turn_fp,
            mission_state_fp=mission_state_fp,
            mcp_fp=mcp_fp,
        )
        with self._lock:
            prev_sig = self._last_sig_by_thread.get(tid)
            cached_system = self._last_system_by_thread.get(tid) or ""
            if prev_sig == sig:
                if cached_system:
                    return request.override(system_message=SystemMessage(content=cached_system))
                return request
            # Runtime: new user turn does not rebuild base instructions — only structural
            # changes (tools/scenario/role/collab/MCP) force apply_prompt_template.
            # Re-apply the *cached assembled* system (memory/profile included), not the
            # graph compile-time prompt.
            if prev_sig and _system_prompt_structure_key(prev_sig) == _system_prompt_structure_key(
                sig
            ):
                self._last_sig_by_thread[tid] = sig
                if cached_system:
                    logger.info(
                        "DynamicSystemPromptOnScenario: reuse cached system (human/mission-only) "
                        "thread=%s bytes=%d",
                        tid,
                        len(cached_system.encode("utf-8", errors="ignore")),
                    )
                    return request.override(system_message=SystemMessage(content=cached_system))
                # No cache yet — fall through to full rebuild once.
            if prev_sig and _is_intra_turn_scenario_only_change(prev_sig, sig):
                self._last_sig_by_thread[tid] = sig
                if cached_system:
                    logger.info(
                        "DynamicSystemPromptOnScenario: skip full rebuild (intra-turn scenario) "
                        "thread=%s",
                        tid,
                    )
                    return request.override(system_message=SystemMessage(content=cached_system))
            self._last_sig_by_thread[tid] = sig

        intent_hint = scenario_csv if scenario_csv else None
        collab_phase = ctx.get("collab_phase")
        if tid_m and (keys or (str(collab_phase or "").strip().lower() not in {"", "idle", "none"})):
            try:
                from evoflow.collab.thread_collab import load_merged_collab_phase
                from evoflow.config.paths import get_paths

                collab_phase = load_merged_collab_phase(get_paths(), tid_m, collab_phase)
            except Exception:
                pass

        mission_state: dict[str, Any] | None = None
        # Mission is injected as turn-tail HumanMessage; do not load into system assemble.
        _ = tid_m

        user_question = str(ctx.get("evf_user_question") or "").strip()
        if not user_question:
            user_question = _latest_human_preview(messages)

        prompt_source = str(ctx.get("evf_prompt_source") or "thread_restore").strip() or "thread_restore"

        raw_skills = meta.get("available_skills")
        available_skills: set[str] | None
        if isinstance(raw_skills, list):
            available_skills = {str(x).strip() for x in raw_skills if str(x).strip()}
        else:
            available_skills = None

        from evoflow.agents.lead_agent.runtime_context import resolve_preferred_skills_for_turn
        from evoflow.config.agents_config import merge_skill_allowlist_with_preferred

        preferred_skills = resolve_preferred_skills_for_turn(ctx)
        if preferred_skills:
            base = available_skills if available_skills is not None else set()
            available_skills = merge_skill_allowlist_with_preferred(base, preferred_skills)

        all_tool_names = list(meta.get("all_tool_names") or [])
        if not all_tool_names:
            all_tool_names = list(tools_sorted)

        state = request.state if isinstance(request.state, dict) else {}
        loaded_deferred_raw = state.get("loaded_deferred_tools")
        loaded_deferred = (
            [str(x).strip() for x in loaded_deferred_raw if str(x or "").strip()]
            if isinstance(loaded_deferred_raw, list)
            else None
        )
        session_key = str(ctx.get("session_key") or "").strip() or None

        try:
            import time

            from evoflow.agents.lead_agent.prompt import apply_prompt_template
            from evoflow.agents.memory.runtime_overrides import effective_memory_injection_enabled
            from evoflow.config.agents_config import load_agent_config
            from evoflow.observability.run_latency_trace import record_phase

            try:
                _cfg = load_agent_config(agent_name_str)
                custom_prompt = (str(_cfg.system_prompt).strip() if _cfg and _cfg.system_prompt else "") or None
            except (FileNotFoundError, ValueError):
                custom_prompt = str(meta.get("custom_system_prompt") or "").strip() or None

            inject_mem = effective_memory_injection_enabled(request.runtime)
            mcp_skill_section = str(meta.get("mcp_system_section") or meta.get("mcp_skill_section") or "").strip()
            if not mcp_skill_section and (meta.get("mcp_native") or meta.get("mcp_servers") is not None):
                from evoflow.mcp.native_prompt import build_mcp_native_prompt_section_safe

                mcp_binding = meta.get("mcp_servers")
                if mcp_binding is None or isinstance(mcp_binding, list):
                    mcp_skill_section = build_mcp_native_prompt_section_safe(
                        mcp_binding,
                        bound_tool_names=list(tools_sorted),
                        prompt_language=str(ctx.get("prompt_language") or "").strip() or None,
                    )
            _t_prompt = time.perf_counter()
            text = apply_prompt_template(
                bool(meta.get("subagent_enabled", False)),
                int(meta.get("max_concurrent_subagents", 5)),
                include_subagent_system_prompt=bool(meta.get("include_subagent_system_prompt", False)),
                agent_name=agent_name_str,
                custom_system_prompt=custom_prompt,
                available_skills=available_skills,
                loaded_tool_names=list(tools_sorted),
                all_tool_names=all_tool_names,
                use_virtual_paths=bool(meta.get("use_virtual_paths", False)),
                local_workspace_root=meta.get("local_workspace_root"),
                intent_hint=intent_hint,
                mission_state=mission_state,
                collab_phase=str(collab_phase or "") or None,
                prompt_source=prompt_source,
                user_question=user_question,
                include_memory=inject_mem,
                thread_id=tid_m or None,
                prompt_language=meta.get("prompt_language") or ctx.get("prompt_language"),
                session_mode=session_mode,
                session_key=session_key,
                loaded_deferred=loaded_deferred,
                mcp_skill_section=mcp_skill_section,
                thinking_enabled=bool(ctx.get("thinking_enabled")),
            )
            record_phase(
                "apply_prompt_template_ms",
                (time.perf_counter() - _t_prompt) * 1000.0,
                agent_name=agent_name_str,
                scenario_csv=scenario_csv,
            )
        except Exception:
            logger.exception("DynamicSystemPromptOnScenario: apply_prompt_template failed")
            return request

        new_sys = SystemMessage(content=text)
        with self._lock:
            self._last_system_by_thread[tid] = text
            # Cap map growth (thread churn).
            if len(self._last_system_by_thread) > 256:
                drop = next(iter(self._last_system_by_thread))
                self._last_system_by_thread.pop(drop, None)
                self._last_sig_by_thread.pop(drop, None)
        return request.override(system_message=new_sys)

    @override
    def wrap_model_call(
        self,
        request: ModelRequest,
        handler,
    ) -> ModelCallResult:
        req2 = self._maybe_rebuild_system_message(request)
        return handler(req2)

    @override
    async def awrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        req2 = self._maybe_rebuild_system_message(request)
        return await handler(req2)
