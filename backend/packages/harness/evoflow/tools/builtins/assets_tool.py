"""Unified Asset Hub tool — search / read / list / note across memory families.

Facts · episodic · journal · craft share the same Markdown + frontmatter shape.
This tool reuses ``evoflow.assets.search`` (file substring) and hub read/write —
not a second DB index. Prefer this over legacy ``experience_*`` / raw vault dumps
when looking up **entity assets** (user / agent / employee / workspace).
"""

from __future__ import annotations

import json
import logging
import re
from typing import Annotated, Any

from langchain.tools import InjectedToolCallId, ToolRuntime, tool
from langgraph.typing import ContextT

logger = logging.getLogger(__name__)

assets_tool_ui_metadata = {
    "label": "实体资产",
    "icon": "🗂️",
    "group": "memory",
    "description": "统一读写实体资产：记忆、过程、反思、经验(craft)、用户画像 — search/read/list/note/profile。",
}

_SLUG_RE = re.compile(r"[^a-zA-Z0-9\u4e00-\u9fff_-]+")


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


def _workspace_from_runtime(runtime: ToolRuntime[ContextT, dict] | None) -> str:
    if runtime is None:
        return ""
    ctx = getattr(runtime, "context", None) or {}
    if isinstance(ctx, dict):
        for key in ("workspace_path", "local_workspace_root", "cwd"):
            v = str(ctx.get(key) or "").strip()
            if v:
                return v
    return ""


def _principal_from_runtime(runtime: ToolRuntime[ContextT, dict] | None) -> str:
    """Current principal id from run context — anchors per-user asset buckets.

    Asset Center reads ``assets/users/<pid>/`` for authenticated callers;
    dialogue-time profile/memory writes must land in the same bucket, or
    updates stay invisible to the panel (shared-bucket bug).
    """
    try:
        from evoflow.authz.runtime_identity import principal_id_from_runtime

        return str(principal_id_from_runtime(runtime) or "").strip()
    except Exception:
        return ""


def _resolve_entity(
    runtime: ToolRuntime[ContextT, dict] | None,
    *,
    entity_type: str = "",
    entity_id: str = "",
    scope: str = "",
    action: str = "",
    path: str = "",
):
    from evoflow.assets.guidance import resolve_memory_entity, resolve_profile_entity
    from evoflow.assets.paths import EntityRef, sanitize_user_asset_id, workspace_entity_ref

    et = str(entity_type or "").strip().lower()
    eid = str(entity_id or "").strip()
    sc = str(scope or "").strip().lower()
    act = str(action or "").strip().lower()
    rel = str(path or "").strip().lstrip("/").lower()
    pid = _principal_from_runtime(runtime)

    def _user_entity() -> EntityRef:
        """User asset bucket: per-principal when authenticated, shared otherwise."""
        if pid:
            return EntityRef("user", sanitize_user_asset_id(pid)).normalized()
        return EntityRef("user", "user").normalized()

    # User profile dimensions always belong to the user entity (asset center).
    if act == "profile":
        return _user_entity()
    if sc in ("workspace", "project", "ws") or et == "workspace":
        wp = eid or _workspace_from_runtime(runtime)
        if wp:
            return workspace_entity_ref(wp)
    if et and eid:
        ent = EntityRef(et, eid).normalized()
        if ent.entity_type == "user":
            # Mirror resolve-side anti-IDOR: authenticated callers always use
            # their own bucket; unauthenticated legacy keeps explicit/shared id.
            if pid:
                return _user_entity()
            if eid.lower() in ("user", "me", "self"):
                return EntityRef("user", "user").normalized()
            return ent
        if ent.entity_type == "agent" and act in ("note", "search", "list"):
            return _user_entity()
        if ent.entity_type == "agent" and act == "read" and rel.startswith("profile/"):
            return ent
        if ent.entity_type == "agent":
            return _user_entity()
        return ent
    agent = _agent_from_runtime(runtime) or None
    if act == "read" and rel.startswith("profile/"):
        return resolve_profile_entity(agent_name=agent, principal_id=pid)
    if pid:
        # Default memory bucket follows the authenticated caller.
        return _user_entity()
    return resolve_memory_entity(agent_name=agent)


def _slug(text: str, *, fallback: str = "note") -> str:
    s = _SLUG_RE.sub("-", str(text or "").strip()).strip("-_")[:48]
    return s or fallback


@tool("assets", parse_docstring=True)
def assets_tool(
    action: str,
    runtime: ToolRuntime[ContextT, dict],
    tool_call_id: Annotated[str, InjectedToolCallId],
    query: str = "",
    path: str = "",
    kinds: str = "",
    content: str = "",
    entity_type: str = "",
    entity_id: str = "",
    scope: str = "",
    max_results: int = 12,
) -> str:
    """Search, read, list, note, or update profile Entity Asset Hub files.

    **One tool for all durable knowledge families** — same Markdown + frontmatter:

    - profile/basic-info.md · preferences.md · persona.md — user identity (Tier-0)
    - memory/facts/ — preferences & short facts
    - memory/episodic/ — process / rollout recaps
    - memory/journal/ — reflections
    - craft/*/SKILL.md — reusable experience / procedures
    - memory/MEMORY.md + memory/standing.md — registry & standing (read only in dialogue)

    Prefer this over legacy ``experience_*``, ``memory_remember``, or direct file edits.

    High-weight families: craft / journal / episodic — reuse when relevant (not decoration).

    Deposit policy:
      - Stable prefs/habits → note/profile in the same turn (no need to wait for "remember").
      - Valuable workflow / valuable process / recurring mistakes → MUST ask the user first
        whether to save as [experience] / [process] / [reflection]; write only after consent.
      - Skip chitchat and one-off noise.

    Actions:
      - search: substring search (kinds=facts,episodic,journal,craft,handbook,all)
      - read: read one relative path
      - list: list directory (default memory/)
      - note: ad-hoc write → memory/_inbox/notes/ (Phase2 merges to facts/journal/craft/standing)
      - profile: update user profile dimension (basic-info | preferences | persona).
        Default mode append (query=append). Use query=replace for full rewrite.
        When user shares stable identity/prefs/habits, update profile proactively.

    For action=note, start content with optional tags: [preference], [reflection], [experience], [process].

    Citation: if memory files informed the reply, append one `<evo-asset-citation>` block last
    (`path:start-end|note=[brief]` per line under `citation_entries`).

    Args:
        action: search | read | list | note | profile
        query: Search keywords (comma-separated ok). Required for search.
               When action=profile, use append (default) or replace.
        path: Relative path for read/list, or profile dimension for action=profile
              (basic-info.md, preferences, persona, …).
        kinds: Comma-separated asset kinds for search (facts,episodic,journal,craft,standing,handbook,all).
        content: Note body for action=note; markdown snippet for action=profile.
        entity_type: Optional user|agent|employee|workspace (default: session entity).
        entity_id: Optional entity id / workspace path.
        scope: Optional shortcut ``workspace`` to force project assets.
        max_results: Cap search hits (default 12).
    """
    _ = tool_call_id
    act = str(action or "").strip().lower()
    try:
        entity = _resolve_entity(
            runtime,
            entity_type=entity_type,
            entity_id=entity_id,
            scope=scope,
            action=act,
            path=path,
        )
    except Exception as exc:
        return json.dumps({"ok": False, "error": f"bad_entity:{exc}"}, ensure_ascii=False)

    try:
        from evoflow.assets.hub import ensure_entity_tree, list_tree, read_text_file, write_text_file

        ensure_entity_tree(entity)
    except Exception as exc:
        return json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)

    if act == "search":
        q = str(query or "").strip()
        if not q:
            return json.dumps({"ok": False, "error": "query_required"}, ensure_ascii=False)
        try:
            from evoflow.assets.search import search_entity_assets

            res = search_entity_assets(
                entity,
                q,
                path=str(path or "").strip() or None,
                kinds=str(kinds or "").strip() or None,
                max_results=max(1, min(int(max_results or 12), 50)),
                context_lines=1,
            )
            # Compact for model: drop huge snippets slightly
            matches = []
            paths_to_touch: list[str] = []
            for m in res.get("matches") or []:
                snip = str(m.get("snippet") or "")
                if len(snip) > 600:
                    snip = snip[:599] + "…"
                matches.append({**m, "snippet": snip})
                p = str(m.get("path") or "").strip()
                if p:
                    paths_to_touch.append(p)
            try:
                from evoflow.assets.usage import touch_asset_usages

                touch_asset_usages(entity, paths_to_touch)
            except Exception:
                logger.debug("assets search usage touch skipped", exc_info=True)
            return json.dumps(
                {
                    "ok": True,
                    "action": "search",
                    "entityType": res.get("entityType"),
                    "entityId": res.get("entityId"),
                    "kinds": res.get("kinds"),
                    "matches": matches,
                    "truncated": res.get("truncated"),
                    "hint": "Open 1–2 paths with assets(action=read). Cite with <evo-asset-citation>.",
                },
                ensure_ascii=False,
            )
        except ValueError as exc:
            return json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)
        except Exception as exc:
            logger.exception("assets search failed")
            return json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)

    if act == "read":
        rel = str(path or "").strip().lstrip("/")
        if not rel:
            return json.dumps({"ok": False, "error": "path_required"}, ensure_ascii=False)
        try:
            data = read_text_file(entity, rel)
            try:
                from evoflow.assets.usage import touch_asset_usage

                touch_asset_usage(entity, str(data.get("path") or rel))
            except Exception:
                logger.debug("assets read usage touch skipped", exc_info=True)
            body = str(data.get("content") or "")
            if len(body) > 12000:
                body = body[:11999] + "\n…(truncated)"
            return json.dumps(
                {
                    "ok": True,
                    "action": "read",
                    "path": data.get("path"),
                    "content": body,
                    "size": data.get("size"),
                },
                ensure_ascii=False,
            )
        except FileNotFoundError:
            return json.dumps({"ok": False, "error": "not_found", "path": rel}, ensure_ascii=False)
        except Exception as exc:
            return json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)

    if act == "list":
        rel = str(path or "").strip().lstrip("/")
        if not rel:
            # Prefer memory/ when listing root — mirrors progressive disclosure
            rel = "memory"
        try:
            data = list_tree(entity, rel)
            return json.dumps({"ok": True, "action": "list", **data}, ensure_ascii=False)
        except FileNotFoundError:
            return json.dumps({"ok": False, "error": "not_found", "path": rel}, ensure_ascii=False)
        except Exception as exc:
            return json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)

    if act == "note":
        text = str(content or query or "").strip()
        if not text:
            return json.dumps({"ok": False, "error": "content_required"}, ensure_ascii=False)
        note_entity = entity
        if re.match(r"^\[project\]", text, re.I):
            wp = _workspace_from_runtime(runtime)
            if wp:
                from evoflow.assets.paths import workspace_entity_ref

                note_entity = workspace_entity_ref(wp)
                text = re.sub(r"^\[project\]\s*", "", text, count=1, flags=re.I).strip()
        if note_entity.normalized().entity_type == "workspace":
            try:
                from evoflow.assets.workspace_memory_policy import is_workspace_ephemeral_content

                if is_workspace_ephemeral_content(text):
                    return json.dumps(
                        {
                            "ok": False,
                            "error": "workspace_ephemeral_content",
                            "hint": "Workspace stores durable project facts (modules/logic/conventions), not tests or session noise.",
                        },
                        ensure_ascii=False,
                    )
            except Exception:
                pass
        try:
            from evoflow.assets.ad_hoc_note import write_ad_hoc_note

            data = write_ad_hoc_note(note_entity, text, slug_hint=str(path or "").strip())
            return json.dumps(
                {
                    "ok": True,
                    "action": "note",
                    "path": data.get("path"),
                    "hint": "Note queued in _inbox; Phase2 consolidates. Do not edit standing/MEMORY directly.",
                },
                ensure_ascii=False,
            )
        except Exception as exc:
            return json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)

    if act == "profile":
        dim = str(path or "").strip()
        if not dim:
            return json.dumps(
                {
                    "ok": False,
                    "error": "path_required",
                    "hint": "path=basic-info|preferences|persona (or *.md)",
                },
                ensure_ascii=False,
            )
        if entity.normalized().entity_type != "user":
            return json.dumps(
                {"ok": False, "error": "profile_only_for_user_entity"},
                ensure_ascii=False,
            )
        qraw = str(query or "").strip().lower()
        mode = qraw if qraw in ("append", "replace") else "append"
        text = str(content or "").strip()
        if not text and qraw not in ("append", "replace"):
            text = str(query or "").strip()
        if not text:
            return json.dumps({"ok": False, "error": "content_required"}, ensure_ascii=False)
        try:
            from evoflow.assets.user_profile_dims import update_profile_dimension

            data = update_profile_dimension(dimension=dim, content=text, mode=mode, entity=entity)
            rel = f"profile/{data['filename']}"
            return json.dumps(
                {
                    "ok": True,
                    "action": "profile",
                    "path": rel,
                    "mode": data.get("mode"),
                    "entityType": entity.entity_type,
                    "entityId": entity.entity_id,
                    "hint": "Profile updated; Tier-0 injection refreshes on next turn. Briefly tell user what you saved.",
                },
                ensure_ascii=False,
            )
        except ValueError as exc:
            return json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)
        except Exception as exc:
            logger.exception("assets profile failed")
            return json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)

    return json.dumps(
        {
            "ok": False,
            "error": "unknown_action",
            "hint": "Use action=search|read|list|note|profile",
        },
        ensure_ascii=False,
    )
