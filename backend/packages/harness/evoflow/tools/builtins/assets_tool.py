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
from typing import Annotated

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


def _ctx_get(ctx: object, key: str) -> str:
    if ctx is None:
        return ""
    if isinstance(ctx, dict):
        return str(ctx.get(key) or "").strip()
    getter = getattr(ctx, "get", None)
    if callable(getter):
        return str(getter(key) or "").strip()
    return str(getattr(ctx, key, None) or "").strip()


def _agent_from_runtime(runtime: ToolRuntime[ContextT, dict] | None) -> str:
    """Session agent / employee code from run context (identity for entity routing)."""
    if runtime is None:
        return ""
    ctx = getattr(runtime, "context", None)
    for key in ("proactive_agent_code", "agent_name", "agent_code", "position_code"):
        v = _ctx_get(ctx, key)
        if v:
            return v
    cfg = getattr(runtime, "config", None) or {}
    if isinstance(cfg, dict):
        conf = cfg.get("configurable") if isinstance(cfg.get("configurable"), dict) else {}
        for key in ("proactive_agent_code", "agent_name"):
            v = str(conf.get(key) or "").strip()
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
    from evoflow.assets.paths import EntityRef, sanitize_user_asset_id

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
        raise PermissionError(
            "workspace_memory_disabled: use employee/user assets instead of project workspace memory"
        )
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
        if ent.entity_type == "employee":
            current_agent = (_agent_from_runtime(runtime) or "").strip().lower()
            if act == "note":
                # 写入只落当前员工自己的树；无员工身份的会话不允许显式写他人员工
                if not current_agent:
                    raise PermissionError("employee_entity_forbidden_without_session_agent")
                if current_agent != ent.entity_id:
                    return EntityRef("employee", current_agent).normalized()
                return ent
            # 读 / 列表 / 检索同样不允许跨员工（防提示注入越权读他人员工的日志）
            if not current_agent or current_agent != ent.entity_id:
                raise PermissionError("cross_employee_entity_forbidden")
            return ent
        return ent
    agent = _agent_from_runtime(runtime) or None
    if act == "read" and rel.startswith("profile/"):
        return resolve_profile_entity(agent_name=agent, principal_id=pid)
    # Employee chat memory (note/search/list/read) belongs on the employee tree,
    # not the caller's user bucket — otherwise note writes succeed then read
    # returns not_found under assets/users/<pid>/ (authenticated sessions).
    if agent and act in ("note", "search", "list", "read", ""):
        from evoflow.assets.guidance import is_employee_agent_name

        if is_employee_agent_name(agent):
            return resolve_memory_entity(agent_name=agent, principal_id=pid)
    if pid:
        # Default memory bucket follows the authenticated caller.
        return _user_entity()
    return resolve_memory_entity(agent_name=agent)


def _normalize_asset_rel(path: str, entity=None) -> str:
    """Accept LLM shortcuts: ``_inbox/...`` → ``memory/_inbox/...``; bare ``foo.md`` → entity path."""
    if entity is not None:
        from evoflow.assets.paths import resolve_asset_rel

        return resolve_asset_rel(entity, path)
    rel = str(path or "").strip().replace("\\", "/").lstrip("/")
    if rel.startswith("_inbox/") or rel == "_inbox":
        return f"memory/{rel}"
    return rel

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

    **One tool for all durable knowledge families** — same Markdown + frontmatter.

    Content kinds (product IA — two memory bodies + peers):
    - memory/facts/ — 条目：one-line durable prefs & short facts (detail list)
    - memory/episodic/ — 过程：dialogue / rollout recaps
    - memory/journal/ — 反思；craft/<name>.md — 经验 / procedures
    - profile/* — user identity (Tier-0)
    - memory/standing.md — 记忆摘要（overall derived page；every-turn L1；read-only in dialogue；Phase2 rewrites）
    - memory/MEMORY.md — handbook / registry（read-only in dialogue）

    Prefer this over legacy ``experience_*``, ``memory_remember``, or direct file edits.

    Decision table (dialogue):
      WHEN (prefer write without waiting for consent — users dislike extra replies):
            stable pref/habit/fact → note same turn;
            solved-problem takeaways, routine procedures, high-signal process/experience
            → note same turn; optional one-line "已记下…" (do not block on reply);
            chitchat / one-off noise / unverified guesses → skip;
            ask first ONLY if sensitive/ambiguous (privacy, rejected brainstorm, unclear boundary).
      WHAT: evidence that changes future behavior (prefs, constraints, conclusions,
            reusable steps, failure shields). No secrets / huge tool dumps / generic advice.
      WRITE: only ``assets note`` → memory/_inbox/notes/ with tag
            [preference]|[process]|[experience]|[reflection]. Never write facts/,
            episodic/, craft/, standing.md, MEMORY.md directly.
      UPDATE formal files: Phase2 only (inbox → facts/episodic/craft/journal + standing).
            Use ``profile`` for identity dims.
      LOAD: standing (L1) + catalog (L2) every turn; pending _inbox notes injected live
            next turn after note (no wait for Phase2 / new session); body via read/search
            (L3, search includes inbox); Hub Recall matches formal + pending titles.

    Actions:
      - search: substring search (kinds=facts,episodic,journal,craft,standing,handbook,all)
      - read: read one relative path
      - list: list directory (default memory/)
      - note: ad-hoc write → memory/_inbox/notes/ (Phase2 merges to facts/episodic/journal/craft/standing)
      - profile: update user profile dimension (basic-info | preferences | persona).
        Default mode append (query=append). Use query=replace for full rewrite.
        When user shares stable identity/prefs/habits, update profile proactively.

    For action=note, start content with optional tags: [preference], [process], [experience], [reflection].

    Citation: if memory files informed the reply, append one `<evo-asset-citation>` block last
    (`path:start-end|note=[brief]` per line under `citation_entries`).
    Paths must be entity-relative asset files (e.g. memory/…); never bare kb_ ids or loose
    `citation_entries:` prose — always wrap in the XML tags.

    Args:
        action: search | read | list | note | profile
        query: Search keywords (comma-separated ok). Required for search.
               When action=profile, use append (default) or replace.
        path: Filename or entity-relative path for read/list (basename is enough), or profile dimension for action=profile
              (basic-info.md, preferences, persona, …).
        kinds: Comma-separated asset kinds for search (facts,episodic,journal,craft,standing,handbook,all).
        content: Note body for action=note; markdown snippet for action=profile.
        entity_type: Optional user|agent|employee (default: session entity). Workspace/project memory is disabled.
        entity_id: Optional entity id.
        scope: Optional entity shortcut (workspace/project disabled).
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
        from evoflow.assets.hub import ensure_entity_tree, list_tree, read_text_file

        ensure_entity_tree(entity)
    except Exception as exc:
        return json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)

    if act == "search":
        q = str(query or "").strip()
        if not q:
            return json.dumps({"ok": False, "error": "query_required"}, ensure_ascii=False)
        try:
            from evoflow.assets.search import search_entity_assets

            # Dialogue search includes pending _inbox notes so a note written
            # this turn is findable before Phase2 consolidation.
            res = search_entity_assets(
                entity,
                q,
                path=_normalize_asset_rel(path, entity) or None,
                kinds=str(kinds or "").strip() or None,
                max_results=max(1, min(int(max_results or 12), 50)),
                context_lines=1,
                include_inbox=True,
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
        rel = _normalize_asset_rel(path, entity)
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
        rel = _normalize_asset_rel(path, entity)
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
        # ``[project]`` no longer routes to workspace Asset Hub — project notes stay on
        # the session entity (user/employee). Strip the tag so Phase2 still classifies.
        if re.match(r"^\[project\]", text, re.I):
            text = re.sub(r"^\[project\]\s*", "[process] ", text, count=1, flags=re.I).strip()
        if note_entity.normalized().entity_type == "workspace":
            return json.dumps(
                {
                    "ok": False,
                    "error": "workspace_memory_disabled",
                    "hint": "Workspace/project memory is disabled; write to employee or user assets instead.",
                },
                ensure_ascii=False,
            )
        try:
            from evoflow.assets.ad_hoc_note import write_ad_hoc_note

            data = write_ad_hoc_note(note_entity, text, slug_hint=str(path or "").strip())
            # Next turn must see pending inbox + refreshed standing/catalog when freeze lifts.
            try:
                from evoflow.agents.memory.standing_freeze import invalidate_standing_memory

                tid = _ctx_get(getattr(runtime, "context", None), "thread_id")
                if not tid:
                    cfg = getattr(runtime, "config", None) or {}
                    if isinstance(cfg, dict):
                        conf = cfg.get("configurable") if isinstance(cfg.get("configurable"), dict) else {}
                        tid = str(conf.get("thread_id") or "").strip()
                invalidate_standing_memory(tid or None)
            except Exception:
                logger.debug("assets note: standing invalidate skipped", exc_info=True)
            return json.dumps(
                {
                    "ok": True,
                    "action": "note",
                    "path": data.get("path"),
                    "hint": (
                        "已写入 memory/_inbox/notes/：下一轮起会自动带上（待整合预览）；"
                        "Phase2 空闲后合进正式条目/过程/经验。勿直改 standing/MEMORY。"
                    ),
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
