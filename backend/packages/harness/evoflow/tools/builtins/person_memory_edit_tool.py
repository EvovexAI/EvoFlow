"""Person Kernel Phase F — bounded self-edit of autobiographical / craft memory."""

from __future__ import annotations

import json
import logging
from typing import Annotated

from langchain.tools import InjectedToolCallId, ToolRuntime, tool
from langgraph.typing import ContextT

logger = logging.getLogger(__name__)

person_memory_edit_tool_ui_metadata = {
    "label": "自我记忆编辑",
    "icon": "🧠",
    "group": "memory",
    "description": "班中有界编辑自己的自传/本事记忆（不能改 L0 身份）。",
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


@tool("person_memory_edit", parse_docstring=True)
def person_memory_edit_tool(
    action: str,
    runtime: ToolRuntime[ContextT, dict],
    tool_call_id: Annotated[str, InjectedToolCallId],
    content: str = "",
    entry_id: str = "",
    layer: str = "journal",
    title: str = "",
    agent_code: str = "",
) -> str:
    """Edit persona assets — prefer ``assets(note)`` in asset-hub memory mode.

    Legacy: bounded self-edit via person_kernel DB (employee agents).
    Runtime: ``append`` → ``assets(note)`` inbox; ``replace``/``rethink`` → use assets search/read + note.

    Args:
        action: append | replace | rethink
        content: Body (≤500 chars). Required for append/replace.
        entry_id: Required for replace/rethink (legacy).
        layer: append tag hint: journal | episodic | procedural → [reflection]/[process]/[experience]
        title: Optional short title.
        agent_code: Fallback when runtime has no agent context.
    """
    from evoflow.assets.memory_injection import asset_hub_memory_injection

    _ = tool_call_id
    agent = str(agent_code or "").strip() or _agent_from_runtime(runtime)
    if not agent:
        return json.dumps(
            {"ok": False, "error": "missing agent context"},
            ensure_ascii=False,
        )

    act = str(action or "").strip().lower()
    text = str(content or "").strip()

    if asset_hub_memory_injection() and act == "append":
        if not text:
            return json.dumps({"ok": False, "error": "content_required"}, ensure_ascii=False)
        try:
            from evoflow.assets.ad_hoc_note import write_ad_hoc_note
            from evoflow.assets.guidance import resolve_session_entity

            ly = str(layer or "journal").strip().lower()
            tag_map = {
                "journal": "[reflection]",
                "episodic": "[process]",
                "procedural": "[experience]",
            }
            tag = tag_map.get(ly, "[reflection]")
            prefix = f"{tag}\n"
            if title:
                prefix = f"{tag} {title.strip()}\n"
            entity = resolve_session_entity(
                agent_name=agent,
                principal_id=_principal_from_runtime(runtime),
            )
            data = write_ad_hoc_note(
                entity,
                f"{prefix}{text}",
                slug_hint=title or ly,
                source="person_memory_edit",
            )
            return json.dumps(
                {
                    "ok": True,
                    "action": act,
                    "path": data.get("path"),
                    "mode": "asset_ad_hoc",
                    "hint": "Use assets(search/read) for reads; assets(note) for writes.",
                },
                ensure_ascii=False,
            )
        except Exception as exc:
            logger.exception("person_memory_edit asset note failed")
            return json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)

    if asset_hub_memory_injection() and act in {"replace", "rethink"}:
        return json.dumps(
            {
                "ok": False,
                "error": "use_assets",
                "hint": "asset-hub memory mode: assets(search/read) the entry, then assets(note) with a correction.",
            },
            ensure_ascii=False,
        )

    from evoflow.person_kernel import edit_person_memory
    try:
        result = edit_person_memory(
            agent,
            action=action,
            content=content,
            entry_id=entry_id,
            layer=layer,
            title=title,
        )
    except Exception as exc:
        logger.exception("person_memory_edit failed agent=%s", agent)
        return json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)
    return json.dumps(result, ensure_ascii=False)
