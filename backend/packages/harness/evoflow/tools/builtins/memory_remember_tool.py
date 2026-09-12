"""Explicit write into unified mem_* (user/agent preference facts)."""

from __future__ import annotations

import json
import logging
from typing import Annotated, Any

from langchain.tools import InjectedToolCallId, ToolRuntime, tool
from langgraph.typing import ContextT

logger = logging.getLogger(__name__)

memory_remember_tool_ui_metadata = {
    "label": "记住用户偏好",
    "icon": "📌",
    "group": "memory",
    "description": "（兼容）写入实体资产 inbox；资产库记忆模式下优先直接用 assets(action=note)。",
}

_KIND_ALIASES = {
    "pref": "preference",
    "preference": "preference",
    "habit": "behavior",
    "behavior": "behavior",
    "context": "context",
    "fact": "context",
    "goal": "goal",
}


def _agent_from_runtime(runtime: ToolRuntime[ContextT, dict] | None) -> str:
    if runtime is None:
        return ""
    ctx = getattr(runtime, "context", None) or {}
    if isinstance(ctx, dict):
        for key in ("agent_name", "proactive_agent_code", "agent_code"):
            v = str(ctx.get(key) or "").strip()
            if v:
                return v
    cfg = getattr(runtime, "config", None) or {}
    if isinstance(cfg, dict):
        conf = cfg.get("configurable") if isinstance(cfg.get("configurable"), dict) else {}
        for key in ("agent_name", "proactive_agent_code"):
            v = str(conf.get(key) or "").strip()
            if v:
                return v
    return ""


def _principal_from_runtime(runtime: ToolRuntime[ContextT, dict] | None) -> str:
    """Current principal id — anchors memory writes to the caller's personal
    asset bucket (``assets/users/<pid>/``) so the Asset Center shows them."""
    try:
        from evoflow.authz.runtime_identity import principal_id_from_runtime

        return str(principal_id_from_runtime(runtime) or "").strip()
    except Exception:
        return ""


@tool("memory_remember", parse_docstring=True)
def memory_remember_tool(
    content: str,
    runtime: ToolRuntime[ContextT, dict],
    tool_call_id: Annotated[str, InjectedToolCallId],
    kind: str = "preference",
    pin: bool = False,
    subject_key: str = "",
) -> str:
    """Save a user preference / habit / short fact into memory.

    asset-hub memory mode: writes an ad-hoc note via Asset Hub (``assets(note)`` path).
    Legacy mode: writes into unified SQLite memory (mem_*).

    Use when the user says "记住…", states a lasting preference (how to address them,
    reply style, tools they prefer), or corrects a prior preference.
    Do **not** use knowledge.write / Agent Notes for user preferences.

    Args:
        content: Short fact in the user's language (one preference or habit).
        kind: preference | behavior | context | goal (legacy mode only).
        pin: If true, mark for standing Core injection (legacy mode only).
        subject_key: Optional stable key e.g. pref.call_name for supersede (legacy).
    """
    _ = tool_call_id
    text = str(content or "").strip()
    if not text:
        return json.dumps({"ok": False, "error": "empty_content"}, ensure_ascii=False)
    if len(text) > 800:
        text = text[:799].rstrip() + "…"

    agent = _agent_from_runtime(runtime) or "main"

    try:
        from evoflow.assets.memory_injection import asset_hub_memory_injection

        if asset_hub_memory_injection():
            from evoflow.assets.ad_hoc_note import write_ad_hoc_note
            from evoflow.assets.guidance import resolve_session_entity

            entity = resolve_session_entity(
                agent_name=agent,
                principal_id=_principal_from_runtime(runtime),
            )
            prefix = ""
            if pin:
                prefix = "[pin for standing]\n"
            data = write_ad_hoc_note(
                entity,
                f"{prefix}{text}",
                slug_hint=str(kind or "preference"),
                source="memory_remember",
            )
            payload: dict[str, Any] = {
                "ok": True,
                "path": data.get("path"),
                "mode": "asset_ad_hoc",
                "hint": "Ad-hoc note in _inbox; Phase2 consolidates into standing/MEMORY.",
            }
            return json.dumps(payload, ensure_ascii=False)
    except Exception as exc:
        logger.exception("memory_remember asset note failed")
        return json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)

    raw_kind = str(kind or "preference").strip().lower() or "preference"
    mem_kind = _KIND_ALIASES.get(raw_kind, "preference")
    try:
        from evoflow.memory.document_codec import namespace_for_agent_key
        from evoflow.memory.facade import remember

        ns = namespace_for_agent_key(agent)
        sk = str(subject_key or "").strip()
        if not sk and mem_kind == "preference":
            sk = f"pref.manual:{hash(text) % 10_000_000}"
        aid = remember(
            ns,
            text,
            layer="semantic",
            kind=mem_kind,
            confidence=0.92,
            importance=0.88 if pin else 0.8,
            pin=bool(pin),
            subject_key=sk,
            source="tool",
            evidence={"agent": agent, "via": "memory_remember"},
        )
        if not aid:
            return json.dumps({"ok": False, "error": "write_rejected"}, ensure_ascii=False)
        payload: dict[str, Any] = {
            "ok": True,
            "atom_id": aid,
            "namespace": ns,
            "kind": mem_kind,
            "pin": bool(pin),
            "hint": "Saved to unified memory (mem_*). Visible in #/memory; injectable next turns.",
        }
        return json.dumps(payload, ensure_ascii=False)
    except Exception as exc:
        logger.exception("memory_remember failed")
        return json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)
