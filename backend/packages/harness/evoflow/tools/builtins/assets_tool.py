"""Unified Asset Hub tool — search / read / list / note / profile.

Standing · episodic · journal · craft share Markdown + frontmatter.
``assets note`` writes by tag straight to the destination; prefer this over
legacy ``experience_*`` / raw vault dumps for entity assets.
"""

from __future__ import annotations

import asyncio
import atexit
import json
import logging
import os
import re
from concurrent.futures import ThreadPoolExecutor
from typing import Annotated

from langchain.tools import InjectedToolCallId, ToolRuntime, tool
from langgraph.typing import ContextT

logger = logging.getLogger(__name__)

assets_tool_ui_metadata = {
    "label": "实体资产",
    "icon": "🗂️",
    "group": "memory",
    "description": "统一读写实体资产：记忆、过程、反思、经验(craft)、用户画像、员工情感 — search/read/list/note/write/delete/rename/profile/affect。",
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
    # An explicit employee/agent target used to be dropped here, so "update this
    # employee's profile" silently edited the **user's** 用户画像 instead — the
    # scariest failure mode in this tool because the write reports ok. Refuse.
    if act == "profile":
        if et and et != "user":
            raise ValueError(
                f"profile 只写用户画像（USER.md），不支持 entity_type={et}；"
                "员工/智能体档案请改用 write 到 craft|memory 路径，或 note 归档"
            )
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
    if act in ("read", "write", "delete", "rename") and rel.startswith("profile/"):
        return resolve_profile_entity(agent_name=agent, principal_id=pid)
    # Employee chat memory belongs on the employee tree, not the caller's user
    # bucket. The whitelist used to cover only note/search/list/read, which split
    # one identity across two buckets: ``note`` landed in employees/<id>/ while
    # ``write`` / ``delete`` / ``rename`` resolved to users/<pid>/ — so a write
    # "succeeded" against the user's tree, the follow-up read said not_found, and
    # a delete removed the wrong entity's file. Same rule must apply to every
    # path-taking action or the ledger lies.
    if agent and act in ("note", "search", "list", "read", "write", "delete", "rename", ""):
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


def _resolve_write_mode(mode: str = "", query: str = "") -> str:
    """Prefer explicit ``mode``; legacy ``query=append|replace`` still accepted."""
    m = str(mode or "").strip().lower()
    if m in ("append", "replace"):
        return m
    q = str(query or "").strip().lower()
    if q in ("append", "replace"):
        return q
    return "append"


# 【fullstack-dev · 2026-11-14 · 第7轮】新增：kind 缺失时按 path 前缀推断去向。
# 目录本身就写明了落点（与系统提示「落点表」一致），再逼调用方补一次 kind 只是白烧一轮。
# 与 normalize_note_kind 的别名表（standing→preference / craft→experience …）保持同一口径。
_PATH_KIND_PREFIXES: tuple[tuple[str, str], ...] = (
    ("memory/standing", "preference"),
    ("standing.md", "preference"),
    # 【fullstack-dev · 2026-11-14 · 第8轮】摘掉 ("handbook/", "experience")：
    # handbook 只是 search scope（search.py → memory/MEMORY.md + memory/facts/），
    # 并非 note 的可写目录；留着会让 handbook/x.md 推断成 experience 后落到
    # craft/handbook-x.md 并报 ignoredPath —— 「免 kind」有效、「按 path 落位」无效。
    # 摘掉后该前缀回空串，走原 kind_required 分支并给出映射表 hint，不再静默改址。
    ("craft/", "experience"),
    ("memory/journal/", "reflection"),
    ("journal/", "reflection"),
    ("memory/episodic/", "process"),
    ("episodic/", "process"),
)


def _note_kind_from_path(raw_path: str) -> str:
    p = str(raw_path or "").strip().lower()
    if not p:
        return ""
    for prefix, kind in _PATH_KIND_PREFIXES:
        if p == prefix or p.startswith(prefix):
            return kind
    return ""


@tool("assets", parse_docstring=True)
def assets_tool(
    action: str,
    runtime: ToolRuntime[ContextT, dict],
    tool_call_id: Annotated[str, InjectedToolCallId],
    query: str = "",
    path: str = "",
    kinds: str = "",
    kind: str = "",
    mode: str = "",
    content: str = "",
    entity_type: str = "",
    entity_id: str = "",
    scope: str = "",
    max_results: int = 12,
) -> str:
    """Search / read / list / note / write / delete / rename / profile / affect on Entity Asset Hub.

    落点、何时写、何时更新：以系统提示 ``## Entity assets``（read_path）为准，此处不重复。

    Actions: search | read | list | note | write | delete | rename | profile | affect.
    note 必须带 kind；write 默认**追加**（mode=replace 才整份覆盖）；
    delete 删一个文件（不可撤销，先 read 确认过时）；rename 改文件名（content 传新名，只在同目录内）。
    profile/affect 用 mode=append|replace。query 仅 search。

    Args:
        action: search | read | list | note | write | delete | rename | profile | affect
        query: Search keywords only (not write mode). Terms split on spaces/commas;
            wrap a phrase in double quotes to keep it literal
        path: Basename or relative path; for note = update target when set, but only
            inside that kind's own directory (kind decides the destination — a
            cross-kind path is ignored and reported as ignoredPath);
            for delete/rename = target file
        kinds: Search filter: standing,episodic,journal,craft,handbook,all
        kind: Note type: preference | process | experience | reflection
        mode: append (default) | replace — write/profile/affect
        content: Note / write / profile / affect markdown body (no type tag needed);
            for rename = new file name
        entity_type: Optional entity type override (user|employee|agent|…)
        entity_id: Optional entity id override
        scope: Optional scope shorthand (user|employee|…)
        max_results: Search hit cap (default 12)
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

            res = search_entity_assets(
                entity,
                q,
                path=_normalize_asset_rel(path, entity) or None,
                kinds=str(kinds or "").strip() or None,
                max_results=max(1, min(int(max_results or 12), 50)),
                context_lines=1,
                include_inbox=False,
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
        defaulted = not rel
        if not rel:
            # Prefer memory/ when listing root — mirrors progressive disclosure
            rel = "memory"
        try:
            data = list_tree(entity, rel)
            if defaulted:
                # Root listing shows one directory, which reads like "the hub only
                # has memory/" — the hub also holds craft/ and profile/.
                data["hint"] = (
                    "未传 path，默认只列 memory/。资产库另有 craft/ 与 profile/，"
                    "需要请分别 list（path=craft / path=profile）。"
                )
            return json.dumps({"ok": True, "action": "list", **data}, ensure_ascii=False)
        except FileNotFoundError:
            return json.dumps({"ok": False, "error": "not_found", "path": rel}, ensure_ascii=False)
        except Exception as exc:
            return json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)

    if act == "note":
        text = str(content or "").strip()
        # Search-box misuse: only fall back to query when it is not a write mode word.
        if not text and str(query or "").strip().lower() not in ("append", "replace", ""):
            text = str(query or "").strip()
        if not text:
            return json.dumps({"ok": False, "error": "content_required"}, ensure_ascii=False)
        note_entity = entity
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
            from evoflow.assets.ad_hoc_note import normalize_note_kind, write_ad_hoc_note

            note_kind = normalize_note_kind(kind)
            write_mode = _resolve_write_mode(mode, query)
            # 【fullstack-dev · 2026-11-14 · 第7轮】修：path 原先只做字面切反斜杠，
            # 而 catalog/搜索返回的是 ``journal/x.md`` 这类短名 —— 读侧第2轮已能认，写侧不认，
            # 于是「更新已有文件」会静默新建一份副本（比报错更坏，没人会发现重复了）。
            # 现在与读侧共用 :func:`canonicalize_asset_rel`，两侧寻址口径必须一致。
            try:
                from evoflow.assets.paths import canonicalize_asset_rel

                raw_path = canonicalize_asset_rel(path)
            except Exception:
                raw_path = str(path or "").strip().replace("\\", "/").lstrip("/")
            update_path = ""
            slug_hint = ""
            if raw_path and (
                raw_path.startswith(("craft/", "memory/episodic/", "memory/journal/"))
                or raw_path in ("memory/standing.md", "standing.md")
            ):
                update_path = "memory/standing.md" if raw_path == "standing.md" else raw_path
                if update_path == "memory/standing.md" and write_mode != "replace":
                    # Prefer append into standing unless model explicitly mode=replace.
                    update_path = ""
            else:
                slug_hint = raw_path

            if not note_kind and not re.match(
                r"^\[(preference|process|experience|reflection|project)\]", text, re.I
            ):
                # 【fullstack-dev · 2026-11-14 · 第7轮】修：本会话照着「note 必须带 kind」的说明
                # 传了 path=memory/standing.md 却没带 kind，被这里连弹 4 次 —— 每次都是白烧一轮，
                # 而且报错只让我"重试"，不给我任何落盘。path 前缀本身已经写明了去向，
                # 就该按目录推断 kind 直接落；只有真的一处线索都没有时才回错。
                note_kind = _note_kind_from_path(raw_path)
                if not note_kind:
                    return json.dumps(
                        {
                            "ok": False,
                            "error": "kind_required",
                            "hint": (
                                "Set kind=preference|process|experience|reflection, or pass path with a "
                                "known prefix (memory/standing.md→preference, craft/→experience, "
                                "memory/journal/→reflection, memory/episodic/→process)."
                            ),
                            "receivedPath": str(path or ""),
                        },
                        ensure_ascii=False,
                    )

            data = write_ad_hoc_note(
                note_entity,
                text,
                kind=note_kind,
                mode=write_mode,
                slug_hint=slug_hint,
                update_path=update_path,
            )
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
            kind = str(data.get("kind") or "")
            dest = {
                "standing": "长期记忆 memory/standing.md",
                "episodic": "过程 memory/episodic/",
                "craft": "经验 craft/",
                "journal": "反思 memory/journal/",
            }.get(kind, data.get("path") or "")
            # `kind` owns the destination, so an explicit path from another kind's
            # directory is dropped. That used to be silent — the caller believed
            # the note landed where they pointed it. Say so instead.
            actual_rel = str(data.get("path") or "").replace("\\", "/")
            path_ignored = bool(
                raw_path
                and "/" in raw_path
                and actual_rel
                and not actual_rel.startswith(raw_path if raw_path.endswith(".md") else raw_path.rstrip("/") + "/")
            )
            verb = "已更新" if data.get("updated") else "已写入"
            hint = f"{verb}{dest}。"
            payload = {
                "ok": True,
                "action": "note",
                "path": data.get("path"),
                "kind": kind,
                "tag": data.get("tag"),
                "updated": bool(data.get("updated")),
                "hint": hint,
            }
            # 【fullstack-dev · 2026-11-14 · 第7轮】修：正文超 4000 字时 ad_hoc_note 会砍尾
            # （``text[:3999] + "…"``），但返回体照旧 ok:true —— 我以为整份存进去了，实际少了后半段。
            # 这类「静默改我的数据还报成功」比报错危害大：没有任何信号会让我回头查。
            # 刻意放独立字段，下面 path_ignored 覆写 hint 时也丢不掉这条告警。
            if len(text) > 4000:
                payload["truncated"] = (
                    f"正文 {len(text)} 字，已截到 4000（尾部 {len(text) - 4000} 字未落盘）；"
                    "长内容请分段 note，或改用 action=write（整份写文件）。"
                )
                hint += " ⚠ 正文超长已截断，见 truncated 字段。"
                payload["hint"] = hint
            if path_ignored:
                payload["ignoredPath"] = raw_path
                payload["hint"] = (
                    f"{verb}{dest}（落点由 kind 决定，你传的 path={raw_path} 已忽略；"
                    f"要写进指定文件请改用 action=write）。"
                )
            return json.dumps(payload, ensure_ascii=False)
        except Exception as exc:
            return json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)

    if act == "write":
        rel = _normalize_asset_rel(path, entity)
        text = str(content or "").strip()
        if not rel:
            return json.dumps({"ok": False, "error": "path_required"}, ensure_ascii=False)
        if not text:
            return json.dumps({"ok": False, "error": "content_required"}, ensure_ascii=False)
        _KIND_DIRS = {
            "process": "memory/episodic/",
            "episodic": "memory/episodic/",
            "experience": "craft/",
            "craft": "craft/",
            "reflection": "memory/journal/",
            "journal": "memory/journal/",
        }
        # 【self-evolution-bot · 2026-11-16 · 第20轮】同一工具两套口径的缺陷：
        # note 分支按 kind 推导落点（"落点由 kind 决定"），write 分支却只认带前缀的
        # 完整相对路径，裸文件名一律 write_path_not_allowed。现网 obs 实测正是这样：
        # xiaomi 09:01 传 kind=episodic + path='补充-2026-11-16-...md'（裸名，语义明确、
        # 目标就是 episodic），被拒后还得再猜一次前缀。改为与 note 同口径：kind 能定目录
        # 且 path 无目录成分（或目录不属于可写集合）时，补上 kind 对应的目录，
        # 并在回执里明写 resolved_path，不静默改址。
        kind_dir = _KIND_DIRS.get(str(kind or "").strip().lower(), "")
        resolved_from_kind = False
        if kind_dir and not rel.startswith(("craft/", "memory/episodic/", "memory/journal/", "memory/standing")):
            if "/" not in rel:
                rel = f"{kind_dir}{rel}"
                resolved_from_kind = True
        allowed = rel.startswith(("craft/", "memory/episodic/", "memory/journal/", "memory/standing")) or rel in (
            "memory/standing.md",
            "memory/MEMORY.md",
            "profile/affect.md",
        )
        if not allowed:
            # 顺带把「该往哪写」直接说出来：原来只说白名单目录，不给可落点示例。
            return json.dumps(
                {
                    "ok": False,
                    "error": "write_path_not_allowed",
                    "received_path": path,
                    "hint": (
                        "write only craft / memory/episodic / memory/journal / memory/standing* / "
                        "memory/MEMORY.md / profile/affect.md；"
                        "传裸文件名时同时给 kind（episodic|journal|craft）可自动补目录"
                    ),
                    "examples": [
                        "craft/某配方.md",
                        "memory/journal/某教训.md",
                        "memory/episodic/某经过.md",
                    ],
                },
                ensure_ascii=False,
            )
        try:
            from evoflow.assets.hub import read_text_file, write_text_file

            # Write is append-by-default: a full overwrite must be explicit
            # (``mode=replace``). Without this, "tweak one paragraph" silently
            # wiped the whole file — the model rarely sends the full body.
            write_mode = _resolve_write_mode(mode, query)
            body = text if text.endswith("\n") else text + "\n"
            if rel == "profile/affect.md":
                # Same guard as action=affect: a replace must not drop the
                # source/mood/updated header the mood mirror depends on.
                from evoflow.assets.affect_mirror import write_affect_md

                data = write_affect_md(entity, text, mode=write_mode)
            elif write_mode == "replace":
                data = write_text_file(entity, rel, body)
            else:
                try:
                    existing = read_text_file(entity, rel).get("content") or ""
                except Exception:
                    existing = ""
                merged = existing
                if merged and not merged.endswith("\n"):
                    merged += "\n"
                # Idempotent append: re-sending the same paragraph must not stack.
                if body.strip() and body.strip() in merged:
                    data = write_text_file(entity, rel, merged)
                else:
                    merged += body
                    data = write_text_file(entity, rel, merged)
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
                logger.debug("assets write: standing invalidate skipped", exc_info=True)
            return json.dumps(
                {
                    "ok": True,
                    "action": "write",
                    "path": data.get("path") or rel,
                    # 【self-evolution-bot · 2026-11-16 · 第20轮】按 kind 补目录时必须回显，
                    # 否则调用方以为自己写的是 path=裸名，下次 update_path 又得猜一遍。
                    **({"resolved_path": rel, "resolved_from_kind": True} if resolved_from_kind else {}),
                    "updated": True,
                    "mode": write_mode,
                    "hint": (
                        (
                            f"已按 kind 补全目录后覆盖写入 {rel}。"
                            if write_mode == "replace"
                            else f"已按 kind 补全目录后追加到 {rel}（追加模式）。要整份覆盖请显式传 mode=replace。"
                        )
                        if resolved_from_kind
                        else (
                            f"已覆盖写入 {rel}。"
                            if write_mode == "replace"
                            else f"已追加到 {rel}（追加模式）。要整份覆盖请显式传 mode=replace。"
                        )
                    ),
                },
                ensure_ascii=False,
            )
        except Exception as exc:
            return json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)

    if act == "delete":
        rel = _normalize_asset_rel(path, entity)
        if not rel:
            return json.dumps({"ok": False, "error": "path_required"}, ensure_ascii=False)
        try:
            from evoflow.assets.hub import delete_text_file

            data = delete_text_file(entity, rel)
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
                logger.debug("assets delete: standing invalidate skipped", exc_info=True)
            return json.dumps(
                {
                    "ok": True,
                    "action": "delete",
                    "path": data.get("path") or rel,
                    "deleted": True,
                    "hint": f"已删除 {rel}。删除不可撤销——先确认内容确实过时了。",
                },
                ensure_ascii=False,
            )
        except FileNotFoundError:
            return json.dumps({"ok": False, "error": f"not_found:{rel}"}, ensure_ascii=False)
        except ValueError as exc:
            return json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)
        except Exception as exc:
            return json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)

    if act == "rename":
        rel = _normalize_asset_rel(path, entity)
        if not rel:
            return json.dumps({"ok": False, "error": "path_required"}, ensure_ascii=False)
        new_name = str(content or "").strip() or str(query or "").strip()
        if not new_name:
            return json.dumps(
                {"ok": False, "error": "content_required", "hint": "new file name goes in content"},
                ensure_ascii=False,
            )
        try:
            from evoflow.assets.hub import rename_text_file

            data = rename_text_file(entity, rel, new_name)
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
                logger.debug("assets rename: standing invalidate skipped", exc_info=True)
            synced = bool(data.get("frontmatterSynced"))
            keys = data.get("syncedKeys") or (["name"] if synced else [])
            return json.dumps(
                {
                    "ok": True,
                    "action": "rename",
                    "path": data.get("path") or rel,
                    "newPath": data.get("newPath"),
                    "renamed": bool(data.get("renamed")),
                    "frontmatterSynced": synced,
                    "syncedKeys": keys,
                    "hint": (
                        (
                            f"已重命名为 {data.get('newPath')}，frontmatter 的 {'/'.join(keys)} 已同步。"
                            if synced
                            else f"已重命名为 {data.get('newPath')}。"
                        )
                        if data.get("renamed")
                        else "文件名未变。"
                    ),
                },
                ensure_ascii=False,
            )
        except FileNotFoundError:
            return json.dumps({"ok": False, "error": f"not_found:{rel}"}, ensure_ascii=False)
        except FileExistsError as exc:
            return json.dumps(
                {"ok": False, "error": f"target_exists:{exc}"},
                ensure_ascii=False,
            )
        except ValueError as exc:
            return json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)
        except Exception as exc:
            return json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)

    if act == "profile":
        dim = str(path or "").strip() or "USER.md"
        if entity.normalized().entity_type != "user":
            return json.dumps(
                {"ok": False, "error": "profile_only_for_user_entity"},
                ensure_ascii=False,
            )
        write_mode = _resolve_write_mode(mode, query)
        text = str(content or "").strip()
        if not text and str(query or "").strip().lower() not in ("append", "replace", ""):
            text = str(query or "").strip()
        if not text:
            return json.dumps({"ok": False, "error": "content_required"}, ensure_ascii=False)
        try:
            from evoflow.assets.user_profile_dims import update_profile_dimension

            data = update_profile_dimension(dimension=dim, content=text, mode=write_mode, entity=entity)
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

    if act == "affect":
        # Lead/main → user vault affect；employee → employee vault.
        affect_entity = entity
        agent_code = _agent_from_runtime(runtime)
        code_l = str(agent_code or "").strip().lower()
        try:
            from evoflow.assets.guidance import is_employee_agent_name
            from evoflow.assets.paths import EntityRef

            if code_l and code_l not in {"main", "lead_agent", "user", "default", ""} and is_employee_agent_name(
                code_l
            ):
                affect_entity = EntityRef("employee", code_l).normalized()
            elif affect_entity.normalized().entity_type != "user":
                # Prefer the authenticated user bucket for main-agent 心境.
                pid = _principal_from_runtime(runtime)
                if pid:
                    affect_entity = EntityRef("user", pid).normalized()
                elif code_l and code_l not in {"main", "lead_agent", "user", "default", ""}:
                    affect_entity = EntityRef("agent", code_l).normalized()
        except Exception as exc:
            return json.dumps({"ok": False, "error": f"bad_affect_entity:{exc}"}, ensure_ascii=False)
        if affect_entity.normalized().entity_type not in ("employee", "agent", "user"):
            return json.dumps(
                {
                    "ok": False,
                    "error": "affect_entity_unsupported",
                    "hint": "情感写在用户（主智能体）或员工的 profile/affect.md。",
                },
                ensure_ascii=False,
            )
        write_mode = _resolve_write_mode(mode, query)
        text = str(content or "").strip()
        if not text and str(query or "").strip().lower() not in ("append", "replace", ""):
            text = str(query or "").strip()
        if not text:
            return json.dumps({"ok": False, "error": "content_required"}, ensure_ascii=False)
        try:
            from evoflow.assets.affect_mirror import write_affect_md

            data = write_affect_md(affect_entity, text, mode=write_mode)
            return json.dumps(
                {
                    "ok": True,
                    "action": "affect",
                    "path": data.get("path") or "profile/affect.md",
                    "mode": data.get("mode"),
                    "entityType": affect_entity.entity_type,
                    "entityId": affect_entity.entity_id,
                    "hint": "已更新情感 profile/affect.md；下一轮注入会读到。",
                },
                ensure_ascii=False,
            )
        except ValueError as exc:
            return json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)
        except Exception as exc:
            logger.exception("assets affect failed")
            return json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)

    return json.dumps(
        {
            "ok": False,
            "error": "unknown_action",
            "hint": "Use action=search|read|list|note|write|delete|rename|profile|affect",
        },
        ensure_ascii=False,
    )


# 【self-evolution-bot · 2026-11-17 · 第34轮】新增：assets 工具自报「函数体内真实耗时」(body_ms)。
# 为什么：obs 现网连续实测——一轮里 N 个并发工具调用，每条 duration 都 ≈ 整批墙钟
#   （6 连发各 ~3.8s、11 连发各 ~9.6-10.5s，同秒起同秒止），而同批 bash 的 exec 只有
#   35~90ms、queue_wait 0.006ms，assets 单发只有 174ms。于是「慢到底在资产代码里还是
#   在通道/调度里」一直只能靠推理。这里把本函数进口→出口的真实毫秒写进 tool_timing，
#   中间件会把它和 duration_ms 并列落进 evoflow_obs_tool_invocations.timing_json。
# 判读口径（下一批并发直接看数）：
#   body_ms ≈ duration_ms  ⇒ 慢在资产代码，继续优化 hub
#   body_ms ≪ duration_ms  ⇒ 慢在通道/调度，差值即排队，别再来资产层找
# 边界：纯观测，不改变任何返回值/异常/耗时行为；上报失败一律吞掉；
#   tool_call_id 取不到时不上报（不污染别人的键）；body_ms>0 才写。
#
# 【2026-11-17】再挂专用线程池 coroutine：StructuredTool 无 coroutine 时 ainvoke 走
# ``run_in_executor(None, …)``（事件循环默认池）。桌面 Gateway 上该池常被别的同步活
# （压缩、MCP sync wrapper、阻塞 I/O）占满，assets 本体 <1ms 却整批卡 2s+（body_ms≪
# duration）。挂上专用池后 ainvoke 不再跟默认池抢槽。

_assets_body_func = getattr(assets_tool, "func", None)
if _assets_body_func is not None:  # pragma: no branch - 工具对象形态异常时静默跳过

    def _assets_timed_func(*args: object, **kwargs: object) -> object:
        import time as _t

        t0 = _t.perf_counter()
        try:
            return _assets_body_func(*args, **kwargs)
        finally:
            try:
                from evoflow.observability.tool_timing import note_tool_exec_detail

                tcid = kwargs.get("tool_call_id")
                if not tcid and len(args) > 2:
                    tcid = args[2]
                key = str(tcid or "").strip()
                if key:
                    note_tool_exec_detail(
                        key, {"assets_body_ms": round((_t.perf_counter() - t0) * 1000.0, 2)}
                    )
            except Exception:
                logger.debug("assets body timing skipped", exc_info=True)

    try:
        assets_tool.func = _assets_timed_func
    except Exception:  # pragma: no cover - pydantic 冻结时退回原样，不影响功能
        logger.debug("assets body timing mount skipped", exc_info=True)


def _assets_pool_workers() -> int:
    raw = (os.getenv("EVOFLOW_ASSETS_TOOL_WORKERS") or "8").strip()
    try:
        return max(2, min(32, int(raw)))
    except ValueError:
        return 8


_ASSETS_TOOL_POOL = ThreadPoolExecutor(
    max_workers=_assets_pool_workers(),
    thread_name_prefix="assets-tool",
)
atexit.register(lambda: _ASSETS_TOOL_POOL.shutdown(wait=False))


async def _assets_tool_coroutine(*args: object, **kwargs: object) -> object:
    """Run the sync assets body on the dedicated pool (not the loop default executor)."""
    loop = asyncio.get_running_loop()
    sync_fn = getattr(assets_tool, "func", None) or _assets_body_func
    if sync_fn is None:  # pragma: no cover
        raise RuntimeError("assets tool sync func missing")
    return await loop.run_in_executor(
        _ASSETS_TOOL_POOL,
        lambda: sync_fn(*args, **kwargs),
    )


try:
    assets_tool.coroutine = _assets_tool_coroutine
except Exception:  # pragma: no cover
    logger.debug("assets dedicated-pool coroutine mount skipped", exc_info=True)
