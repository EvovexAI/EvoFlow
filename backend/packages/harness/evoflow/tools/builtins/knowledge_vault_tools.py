"""High-level Knowledge tool for Lead / Subagents (owned KB preferred; vault optional).

Agents use a single ``knowledge`` tool with an ``action`` discriminator.
When owned bases exist, list/search/read/status prefer them.
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

from langchain.tools import tool

from evoflow.knowledge.vault import service as vault_service
from evoflow.knowledge.vault import store as vault_store
from evoflow.knowledge.vault.errors import KnowledgeError, map_exception
from evoflow.knowledge.vault.models import AccessMode
from evoflow.knowledge.vault.prompt_safe import wrap_knowledge_source
from evoflow.knowledge.vault.provider import get_knowledge_provider
from evoflow.knowledge.vault.sanitize import sanitize_text

logger = logging.getLogger(__name__)

KNOWLEDGE_ACTIONS = frozenset({"list", "search", "read", "graph", "status", "write", "ingest"})
KNOWLEDGE_READ_ACTIONS = frozenset({"list", "search", "read", "graph", "status"})
KNOWLEDGE_WRITE_ACTIONS = frozenset({"write", "ingest"})

_PREF_HINT_RE = None  # lazy compile


def _looks_like_user_preference_note(content: str) -> bool:
    """Heuristic: lasting user prefs / reflections should go to assets(note), not KB notes."""
    import re

    global _PREF_HINT_RE
    text = str(content or "").strip()
    if not text or len(text) > 2000:
        return False
    if _PREF_HINT_RE is None:
        _PREF_HINT_RE = re.compile(
            r"(记住|称呼|叫我|偏好|习惯|以后用|回复风格|用\s*bullet|青柠|"
            r"remember\s+(that|to|me)|call\s+me|prefer|preference|nickname)",
            re.I,
        )
    return bool(_PREF_HINT_RE.search(text))


def _reject_preference_as_kb_note(
    *,
    kb_id: str | None,
    path: str,
    content: str,
    operation: str,
) -> str | None:
    """Block preference dumps into builtin guide / Agent Notes."""
    if operation not in {"create", "append", "replace"}:
        return None
    if not _looks_like_user_preference_note(content):
        return None
    kid = str(kb_id or "").strip().lower()
    p = str(path or "").replace("\\", "/").strip().lower()
    folderish = (
        "agent notes" in p
        or p.startswith("agent notes/")
        or "/agent notes/" in f"/{p}/"
    )
    builtin = "builtin" in kid or "user_guide" in kid or kid.startswith("kb_builtin")
    # create without path defaults to Agent Notes folder in _owned_write
    default_notes = operation == "create" and not p
    if not (builtin or folderish or default_notes):
        return None
    return _json(
        {
            "ok": False,
            "error": "use_assets_note",
            "message": (
                "User preferences, reflections, and experience belong in Entity Asset Hub. "
                "Call assets(action=note, …) instead of knowledge.write to builtin guide / Agent Notes."
            ),
        }
    )


# Pre-unification tool names — mapped to ``knowledge`` for allowlists / aliases.
KNOWLEDGE_LEGACY_TOOL_NAMES = frozenset(
    {
        "knowledge_search",
        "knowledge_read",
        "knowledge_graph",
        "knowledge_status",
        "knowledge_write",
        "knowledge_ingest",
    }
)
KNOWLEDGE_READ_TOOL_NAMES = frozenset(
    {
        "knowledge",
        "knowledge_search",
        "knowledge_read",
        "knowledge_graph",
        "knowledge_status",
    }
)
KNOWLEDGE_WRITE_TOOL_NAMES = frozenset({"knowledge_write", "knowledge_ingest"})


def _json(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2)


def _err(exc: BaseException) -> str:
    ke = map_exception(exc) if not isinstance(exc, KnowledgeError) else exc
    return _json(ke.to_dict())


def _default_vault_id(vault_id: str | None) -> str | None:
    if vault_id and str(vault_id).strip():
        return str(vault_id).strip()
    configs = [c for c in vault_store.list_vault_configs() if c.enabled]
    if len(configs) == 1:
        return configs[0].id
    if not configs:
        return None
    return configs[0].id


def _any_read_write_vault() -> bool:
    try:
        return any(
            c.enabled and c.access_mode == AccessMode.read_write
            for c in vault_store.list_vault_configs()
        )
    except Exception:
        return False


def _vault_allows_write(vault_id: str) -> bool:
    cfg = vault_store.get_vault_config(vault_id)
    return bool(cfg and cfg.enabled and cfg.access_mode == AccessMode.read_write)


def _owned_bases() -> list[dict]:
    try:
        from evoflow.knowledge.owned import service as owned_service

        return owned_service.list_bases()
    except Exception:
        return []


def _default_owned_kb_id(kb_id: str | None) -> str | None:
    if kb_id and str(kb_id).strip():
        return str(kb_id).strip()
    bases = _owned_bases()
    if not bases:
        return None
    return str(bases[0].get("id") or "") or None


def _owned_kb_ids(kb_id: str | None) -> list[str]:
    """Resolve target owned KB ids. Empty kb_id → all owned bases."""
    if kb_id and str(kb_id).strip():
        return [str(kb_id).strip()]
    return [str(b.get("id") or "") for b in _owned_bases() if b.get("id")]


def _prefer_owned(vault_id: str | None = None) -> bool:
    """Prefer owned KB when primary=owned (default). Obsidian only if primary=vault."""
    bases = _owned_bases()
    has_owned = bool(bases)
    try:
        from evoflow.knowledge.owned import settings as owned_settings

        mode = owned_settings.get_primary()
        if mode == "owned":
            return has_owned
        if mode == "vault":
            return False
        if not owned_settings.prefer_owned(vault_id=vault_id, has_owned_bases=has_owned):
            return False
    except Exception:
        if not has_owned:
            return False
    if not has_owned:
        return False
    if vault_id and str(vault_id).strip():
        vid = str(vault_id).strip()
        if any(str(b.get("id")) == vid for b in bases):
            return True
        try:
            if vault_store.get_vault_config(vid) is not None:
                return False
        except Exception:
            pass
    return True


async def _owned_search(*, query: str, kb_id: str | None, mode: str, top_k: int) -> str:
    from evoflow.knowledge.owned import service as owned_service

    kids = _owned_kb_ids(kb_id)
    if not kids:
        return _json({"error": "knowledge_disabled", "message": "No owned knowledge base configured."})
    if not str(query or "").strip():
        return _json({"error": "invalid_args", "message": "action=search requires non-empty query."})
    limit = max(1, min(int(top_k or 8), 20))
    per_kb = limit if len(kids) == 1 else max(limit, min(12, limit * 2))
    t0 = time.perf_counter()
    try:
        name_by_id = {str(b.get("id")): str(b.get("name") or b.get("id")) for b in _owned_bases()}
        merged: list[dict[str, Any]] = []
        degraded_any = False
        modes: set[str] = set()
        for kid in kids:
            result = await owned_service.search(
                kid,
                query,
                mode=mode or "hybrid",
                top_k=per_kb,
            )
            if result.get("degraded"):
                degraded_any = True
            modes.add(str(result.get("mode") or mode or "hybrid"))
            for item in result.get("items") or []:
                score = item.get("rrfScore") or item.get("vectorScore") or item.get("score") or 0
                try:
                    score_f = float(score)
                except (TypeError, ValueError):
                    score_f = 0.0
                merged.append(
                    {
                        "path": item.get("fileName") or item.get("title"),
                        "title": item.get("title"),
                        "snippet": (item.get("content") or "")[:500],
                        "content": item.get("content"),
                        "chunkId": item.get("chunkId"),
                        "docId": item.get("docId"),
                        "kbId": kid,
                        "kbName": name_by_id.get(kid, kid),
                        "score": score_f,
                        "provider": "owned",
                    }
                )
        merged.sort(key=lambda x: float(x.get("score") or 0), reverse=True)
        seen_docs: set[str] = set()
        items: list[dict[str, Any]] = []
        for row in merged:
            did = str(row.get("docId") or "")
            if did and did in seen_docs:
                continue
            if did:
                seen_docs.add(did)
            items.append(row)
            if len(items) >= limit:
                break
        elapsed_ms = int((time.perf_counter() - t0) * 1000)
        return _json(
            {
                "kbId": kids[0] if len(kids) == 1 else None,
                "kbIds": kids,
                "action": "search",
                "provider": "owned",
                "query": query,
                "mode": next(iter(modes)) if len(modes) == 1 else "hybrid",
                "degraded": degraded_any,
                "count": len(items),
                "elapsedMs": elapsed_ms,
                "items": items,
                "hint": "Use knowledge(action=read, paths=[docId or file path], vault_id=kbId) for full evidence.",
            }
        )
    except Exception as exc:
        logger.warning("owned knowledge search failed: %s", sanitize_text(str(exc)))
        return _json({"error": "search_failed", "message": str(exc)})


async def _action_search(
    *,
    query: str,
    vault_id: str | None,
    mode: str,
    top_k: int,
    tags: list[str] | None,
    scopes: list[str] | None,
    rerank: bool,
) -> str:
    if _prefer_owned(vault_id):
        return await _owned_search(query=query, kb_id=vault_id, mode=mode, top_k=top_k)
    vid = _default_vault_id(vault_id)
    if not vid:
        if _owned_bases():
            return await _owned_search(query=query, kb_id=None, mode=mode, top_k=top_k)
        return _json({"error": "knowledge_disabled", "message": "No Knowledge Vault or owned KB configured."})
    if not str(query or "").strip():
        return _json({"error": "invalid_args", "message": "action=search requires non-empty query."})
    t0 = time.perf_counter()
    try:
        provider = get_knowledge_provider()
        results = await provider.search(
            vid,
            query=query,
            mode=mode or "hybrid",
            top_k=max(1, min(int(top_k or 8), 20)),
            tags=tags or [],
            scopes=scopes or [],
            rerank=bool(rerank),
        )
        elapsed_ms = int((time.perf_counter() - t0) * 1000)
        logger.info(
            "knowledge action=search vault=%s mode=%s top_k=%s hits=%s ms=%s rerank=%s",
            vid,
            mode,
            top_k,
            len(results),
            elapsed_ms,
            rerank,
        )
        return _json(
            {
                "vaultId": vid,
                "action": "search",
                "provider": "vault",
                "query": query,
                "mode": mode,
                "count": len(results),
                "elapsedMs": elapsed_ms,
                "items": [r.model_dump(by_alias=True, mode="json") for r in results],
                "hint": "Select up to 3 notes and call knowledge(action=read) for evidence. Cite paths in the answer.",
            }
        )
    except Exception as exc:
        logger.warning("knowledge action=search failed: %s", sanitize_text(str(exc)))
        return _err(exc)


async def _owned_read(*, paths: list[str] | None, kb_id: str | None, max_content_chars: int) -> str:
    from evoflow.knowledge.owned import service as owned_service

    kids = _owned_kb_ids(kb_id)
    if not kids:
        return _json({"error": "knowledge_disabled", "message": "No owned knowledge base configured."})
    path_list = list(paths or [])[:5]
    if not path_list:
        return _json({"error": "invalid_args", "message": "action=read requires paths (max 5)."})
    cap = max(500, min(int(max_content_chars or 12000), 50000))
    items: list[dict[str, Any]] = []
    for key in path_list:
        doc = None
        hit_kb = None
        for kid in kids:
            doc = owned_service.resolve_document(kid, str(key))
            if doc:
                hit_kb = kid
                break
        if not doc or not hit_kb:
            continue
        text = owned_service.get_document_text(doc["id"], max_chars=cap)
        path = doc.get("folderPath") and f'{doc["folderPath"]}/{doc["fileName"]}' or doc.get("fileName") or doc["id"]
        items.append(
            {
                "path": path,
                "title": doc.get("title"),
                "docId": doc["id"],
                "kbId": hit_kb,
                "content": text,
                "summary": doc.get("summaryText") or "",
                "parseStatus": doc.get("parseStatus"),
                "provider": "owned",
                "contentForModel": wrap_knowledge_source(path, text),
            }
        )
    return _json(
        {
            "kbId": kids[0] if len(kids) == 1 else None,
            "kbIds": kids,
            "action": "read",
            "provider": "owned",
            "items": items,
            "count": len(items),
        }
    )


async def _action_read(
    *,
    paths: list[str] | None,
    vault_id: str | None,
    max_content_chars: int,
) -> str:
    if _prefer_owned(vault_id):
        return await _owned_read(paths=paths, kb_id=vault_id, max_content_chars=max_content_chars)
    vid = _default_vault_id(vault_id)
    if not vid:
        if _owned_bases():
            return await _owned_read(paths=paths, kb_id=None, max_content_chars=max_content_chars)
        return _json({"error": "knowledge_disabled", "message": "No Knowledge Vault or owned KB configured."})
    path_list = list(paths or [])
    if not path_list:
        return _json({"error": "invalid_args", "message": "action=read requires paths (max 5)."})
    try:
        provider = get_knowledge_provider()
        notes = await provider.read(vid, path_list, max_content_chars=max_content_chars)
        items = []
        for n in notes:
            dump = n.model_dump(by_alias=True, mode="json")
            dump["contentForModel"] = wrap_knowledge_source(n.path, n.content)
            items.append(dump)
        logger.info("knowledge action=read vault=%s paths=%s", vid, [n.path for n in notes])
        return _json({"vaultId": vid, "action": "read", "provider": "vault", "items": items, "count": len(items)})
    except Exception as exc:
        return _err(exc)


async def _action_graph(
    *,
    path: str,
    vault_id: str | None,
    depth: int,
    direction: str,
) -> str:
    if _prefer_owned(vault_id):
        return await _owned_graph(path=path, kb_id=vault_id, depth=depth)
    vid = _default_vault_id(vault_id)
    if not vid:
        if _owned_bases():
            return await _owned_graph(path=path, kb_id=None, depth=depth)
        return _json({"error": "knowledge_disabled", "message": "No Knowledge Vault or owned KB configured."})
    if not str(path or "").strip():
        return _json({"error": "invalid_args", "message": "action=graph requires path."})
    try:
        provider = get_knowledge_provider()
        g = await provider.graph(vid, path=path, depth=depth, direction=direction or "both")
        logger.info("knowledge action=graph vault=%s path=%s depth=%s nodes=%s", vid, path, depth, len(g.nodes))
        return _json({"action": "graph", "provider": "vault", **g.model_dump(by_alias=True, mode="json")})
    except Exception as exc:
        return _err(exc)


async def _owned_graph(*, path: str, kb_id: str | None, depth: int) -> str:
    from evoflow.knowledge.owned import kg as kg_mod
    from evoflow.knowledge.owned import wiki as wiki_mod

    kid = _default_owned_kb_id(kb_id)
    if not kid:
        return _json({"error": "knowledge_disabled", "message": "No owned knowledge base configured."})
    center = str(path or "").strip() or None
    if center and center.lower().startswith(("kg:", "entity:")):
        name = center.split(":", 1)[1].strip() or None
        g = kg_mod.graph_payload(kid, center=name)
        return _json({"action": "graph", "provider": "owned", **g})
    if center in ("", "*", "index", ".", "wiki"):
        center = "index" if wiki_mod.get_page(kid, "index") else None
    g = wiki_mod.graph_payload(kid, center_slug=center, depth=max(1, min(int(depth or 2), 3)))
    if (g.get("nodeCount") or 0) == 0:
        g = kg_mod.graph_payload(kid, center=None)
    return _json({"action": "graph", "provider": "owned", **g})


async def _owned_status(*, kb_id: str | None) -> str:
    from evoflow.knowledge.owned import service as owned_service

    bases = _owned_bases()
    if kb_id and str(kb_id).strip():
        kid = str(kb_id).strip()
        base = owned_service.get_base(kid)
        if not base:
            return _json({"error": "not_found", "message": f"owned kb not found: {kid}"})
        docs = owned_service.list_documents(kid)
        ready = sum(1 for d in docs if d.get("parseStatus") == "completed")
        return _json(
            {
                "action": "status",
                "provider": "owned",
                "kbId": kid,
                "name": base.get("name"),
                "documentCount": len(docs),
                "readyCount": ready,
                "embeddingMode": base.get("embeddingMode"),
                "hasEmbeddingApiKey": bool(base.get("hasEmbeddingApiKey")),
                "vectorEnabled": bool(base.get("vectorEnabled")),
            }
        )
    if not bases:
        return _json({"error": "knowledge_disabled", "message": "No owned knowledge base configured.", "items": []})
    items = []
    for b in bases:
        docs = owned_service.list_documents(b["id"])
        ready = sum(1 for d in docs if d.get("parseStatus") == "completed")
        items.append(
            {
                "kbId": b["id"],
                "name": b.get("name"),
                "documentCount": len(docs),
                "readyCount": ready,
                "embeddingMode": b.get("embeddingMode"),
                "provider": "owned",
            }
        )
    return _json({"action": "status", "provider": "owned", "items": items, "count": len(items)})


async def _action_status(*, vault_id: str | None) -> str:
    if _prefer_owned(vault_id):
        return await _owned_status(kb_id=vault_id)
    try:
        provider = get_knowledge_provider()
        if vault_id:
            st = await provider.status(str(vault_id).strip())
            return _json({"action": "status", "provider": "vault", **st.model_dump(by_alias=True, mode="json")})
        configs = [c for c in vault_store.list_vault_configs() if c.enabled]
        if not configs:
            if _owned_bases():
                return await _owned_status(kb_id=None)
            return _json({"error": "knowledge_disabled", "message": "No Knowledge Vault or owned KB configured.", "items": []})
        items = []
        for c in configs:
            st = await provider.status(c.id)
            items.append(st.model_dump(by_alias=True, mode="json"))
        return _json({"action": "status", "provider": "vault", "items": items, "count": len(items)})
    except Exception as exc:
        return _err(exc)


async def _owned_list(*, kb_id: str | None, prefix: str, limit: int) -> str:
    from evoflow.knowledge.owned import service as owned_service

    kids = _owned_kb_ids(kb_id)
    if not kids:
        return _json({"error": "knowledge_disabled", "message": "No owned knowledge base configured."})
    limit_n = max(1, min(int(limit or 80), 200))
    pref = (prefix or "").strip().lstrip("/")
    name_by_id = {str(b.get("id")): str(b.get("name") or b.get("id")) for b in _owned_bases()}
    items = []
    total = 0
    for kid in kids:
        docs = owned_service.list_documents(kid)
        total += len(docs)
        for d in docs:
            path = (d.get("folderPath") and f'{d["folderPath"]}/{d["fileName"]}') or d.get("fileName") or d["id"]
            if pref and not path.startswith(pref) and not str(d.get("title") or "").startswith(pref):
                continue
            items.append(
                {
                    "path": path,
                    "docId": d["id"],
                    "kbId": kid,
                    "kbName": name_by_id.get(kid, kid),
                    "title": d.get("title"),
                    "parseStatus": d.get("parseStatus"),
                    "summary": (d.get("summaryText") or "")[:240] or None,
                    "chunkCount": d.get("chunkCount") or 0,
                }
            )
            if len(items) >= limit_n:
                break
        if len(items) >= limit_n:
            break
    return _json(
        {
            "action": "list",
            "provider": "owned",
            "kbId": kids[0] if len(kids) == 1 else None,
            "kbIds": kids,
            "prefix": pref or None,
            "total": total,
            "count": len(items),
            "truncated": len(items) < total and (not pref or len(items) >= limit_n),
            "items": items,
            "hint": "Use knowledge(action=read, paths=[docId]) or knowledge(action=search).",
        }
    )


async def _action_list(
    *,
    vault_id: str | None,
    prefix: str,
    limit: int,
) -> str:
    """List documents in owned KB or Markdown note paths in a vault."""
    if _prefer_owned(vault_id):
        return await _owned_list(kb_id=vault_id, prefix=prefix, limit=limit)
    vid = _default_vault_id(vault_id)
    if not vid:
        if _owned_bases():
            return await _owned_list(kb_id=None, prefix=prefix, limit=limit)
        return _json({"error": "knowledge_disabled", "message": "No Knowledge Vault or owned KB configured."})
    try:
        limit_n = max(1, min(int(limit or 80), 200))
        data = vault_service.list_notes(vid, limit=limit_n, prefix=prefix or "")
        logger.info(
            "knowledge action=list vault=%s prefix=%s count=%s total=%s",
            vid,
            prefix or "",
            data.get("count"),
            data.get("total"),
        )
        return _json(
            {
                "action": "list",
                "provider": "vault",
                "vaultId": vid,
                "prefix": prefix or None,
                "total": data.get("total", 0),
                "count": data.get("count", 0),
                "truncated": data.get("truncated", False),
                "items": data.get("items") or [],
                "hint": "Use knowledge(action=read, paths=[...]) for note bodies, or knowledge(action=search) for keyword/semantic lookup.",
            }
        )
    except Exception as exc:
        return _err(exc)


async def _action_write(
    *,
    operation: str,
    path: str,
    vault_id: str | None,
    content: str,
    target: str,
    section: str | None,
    key: str,
    value: str,
    add_tags: list[str] | None,
    remove_tags: list[str] | None,
) -> str:
    if _prefer_owned(vault_id):
        return await _owned_write(
            operation=operation,
            path=path,
            kb_id=vault_id,
            content=content,
            section=section,
        )
    if not _any_read_write_vault():
        if _owned_bases():
            return await _owned_write(
                operation=operation,
                path=path,
                kb_id=None,
                content=content,
                section=section,
            )
        return _json(
            {
                "error": "knowledge_read_only",
                "message": "No owned KB or read_write Knowledge Vault enabled; write unavailable.",
            }
        )
    vid = _default_vault_id(vault_id)
    if not vid:
        return _json({"error": "knowledge_disabled", "message": "No Knowledge Vault configured or enabled."})
    if not _vault_allows_write(vid):
        return _json(
            {
                "error": "knowledge_read_only",
                "message": f"Vault {vid!r} is not read_write; cannot write.",
                "vaultId": vid,
            }
        )
    if not str(path or "").strip():
        return _json({"error": "invalid_args", "message": "action=write requires path."})
    op = str(operation or "").strip().lower()
    provider = get_knowledge_provider()
    try:
        if op == "create":
            note = await provider.create_note(vid, path, content)
        elif op == "append":
            note = await provider.append_note(vid, path, content, section=section)
        elif op == "patch":
            note = await provider.patch_note(vid, path, target=target, operation="replace", content=content)
        elif op == "set_frontmatter":
            note = await provider.set_frontmatter(vid, path, key=key, value=value)
        elif op == "update_tags":
            note = await provider.update_tags(vid, path, add=add_tags, remove=remove_tags)
        else:
            return _json({"error": "invalid_provider_response", "message": f"unsupported write operation: {op}"})
        logger.info("knowledge action=write vault=%s op=%s path=%s", vid, op, path)
        return _json(
            {
                "ok": True,
                "action": "write",
                "provider": "vault",
                "operation": op,
                "note": note.model_dump(by_alias=True, mode="json"),
            }
        )
    except Exception as exc:
        return _err(exc)


async def _owned_write(
    *,
    operation: str,
    path: str,
    kb_id: str | None,
    content: str,
    section: str | None,
) -> str:
    from evoflow.knowledge.owned import service as owned_service

    kid = _default_owned_kb_id(kb_id)
    if not kid:
        return _json({"error": "knowledge_disabled", "message": "No owned knowledge base configured."})
    op = str(operation or "create").strip().lower() or "create"
    blocked = _reject_preference_as_kb_note(
        kb_id=kid, path=path, content=content, operation=op
    )
    if blocked:
        return blocked
    if not str(path or "").strip() and op != "create":
        return _json({"error": "invalid_args", "message": "action=write requires path (or docId)."})

    def _job_id(doc: dict) -> str | None:
        job = doc.get("job")
        if isinstance(job, dict):
            return job.get("id")
        return doc.get("latestJobId")

    def _write_ok(*, operation: str, doc: dict, extra: dict | None = None) -> str:
        payload = {
            "ok": True,
            "action": "write",
            "provider": "owned",
            "operation": operation,
            "kbId": kid,
            "docId": doc.get("id"),
            "title": doc.get("title"),
            "parseStatus": doc.get("parseStatus"),
            "jobId": _job_id(doc),
            "hint": "Document queued for parse_index; use knowledge(action=status) to check.",
        }
        if extra:
            payload.update(extra)
        return _json(payload)

    try:
        if op == "create":
            title = Path(str(path or "").strip() or "note").stem or "note"
            if not str(content or "").strip():
                return _json({"error": "invalid_args", "message": "write create requires content."})
            folder = "Agent Notes"
            p = str(path or "").replace("\\", "/").strip()
            if "/" in p:
                folder = "/".join(p.split("/")[:-1]) or "Agent Notes"
            doc = owned_service.upload_manual_markdown(
                kid, title=title, content=content, folder_path=folder
            )
            return _write_ok(operation="create", doc=doc, extra={"folderPath": doc.get("folderPath")})
        if op == "append":
            doc = owned_service.resolve_document(kid, str(path).strip())
            if not doc:
                return _json({"error": "not_found", "message": f"document not found: {path}"})
            if not str(content or "").strip():
                return _json({"error": "invalid_args", "message": "write append requires content."})
            out = owned_service.append_document_content(doc["id"], content, section=section)
            return _write_ok(operation="append", doc=out)
        if op == "replace":
            doc = owned_service.resolve_document(kid, str(path).strip())
            if not doc:
                return _json({"error": "not_found", "message": f"document not found: {path}"})
            if not str(content or "").strip():
                return _json({"error": "invalid_args", "message": "write replace requires content."})
            out = owned_service.replace_document_content(doc["id"], content)
            return _write_ok(operation="replace", doc=out)
        if op == "delete":
            doc = owned_service.resolve_document(kid, str(path).strip())
            if not doc:
                return _json({"error": "not_found", "message": f"document not found: {path}"})
            owned_service.delete_document(doc["id"])
            return _json(
                {
                    "ok": True,
                    "action": "write",
                    "provider": "owned",
                    "operation": "delete",
                    "kbId": kid,
                    "docId": doc.get("id"),
                    "title": doc.get("title"),
                    "hint": "Document soft-deleted; index purged. Prefer deleting Agent Notes / Inbox drafts.",
                }
            )
        return _json(
            {
                "error": "unsupported",
                "message": (
                    f"owned write supports create|append|replace|delete (got {op}). "
                    "Use vault for patch/frontmatter/tags."
                ),
            }
        )
    except Exception as exc:
        return _json({"error": "write_failed", "message": str(exc)})


async def _action_ingest(
    *,
    title: str,
    content: str,
    vault_id: str | None,
    summary: str,
    source: str,
    source_description: str,
    confidence: float,
    tags: list[str] | None,
    related_paths: list[str] | None,
) -> str:
    if _prefer_owned(vault_id):
        return await _owned_ingest(title=title, content=content, kb_id=vault_id, summary=summary)
    if not _any_read_write_vault():
        if _owned_bases():
            return await _owned_ingest(title=title, content=content, kb_id=None, summary=summary)
        return _json(
            {
                "error": "knowledge_read_only",
                "message": "No owned KB or read_write Knowledge Vault enabled; ingest unavailable.",
            }
        )
    vid = _default_vault_id(vault_id)
    if not vid:
        return _json({"error": "knowledge_disabled", "message": "No Knowledge Vault configured or enabled."})
    if not _vault_allows_write(vid):
        return _json(
            {
                "error": "knowledge_read_only",
                "message": f"Vault {vid!r} is not read_write; cannot ingest.",
                "vaultId": vid,
            }
        )
    if not str(title or "").strip() or not str(content or "").strip():
        return _json({"error": "invalid_args", "message": "action=ingest requires title and content."})
    try:
        provider = get_knowledge_provider()
        result = await provider.ingest(
            vid,
            title=title,
            content=content,
            summary=summary,
            source=source or "evoflow",
            source_description=source_description,
            confidence=float(confidence),
            tags=tags,
            related_paths=related_paths,
        )
        if isinstance(result, dict):
            return _json({"action": "ingest", "provider": "vault", **result})
        return _json({"action": "ingest", "provider": "vault", "result": result})
    except Exception as exc:
        return _err(exc)


async def _owned_ingest(*, title: str, content: str, kb_id: str | None, summary: str) -> str:
    from evoflow.knowledge.owned import service as owned_service

    kid = _default_owned_kb_id(kb_id)
    if not kid:
        return _json({"error": "knowledge_disabled", "message": "No owned knowledge base configured."})
    if not str(title or "").strip() or not str(content or "").strip():
        return _json({"error": "invalid_args", "message": "action=ingest requires title and content."})
    body = content
    if summary and str(summary).strip():
        body = f"> 摘要：{str(summary).strip()}\n\n{content}"
    try:
        doc = owned_service.upload_manual_markdown(kid, title=title.strip(), content=body, folder_path="Inbox")
        return _json(
            {
                "ok": True,
                "action": "ingest",
                "provider": "owned",
                "kbId": kid,
                "docId": doc.get("id"),
                "title": doc.get("title"),
                "folderPath": doc.get("folderPath"),
                "parseStatus": doc.get("parseStatus"),
                "hint": "Document queued for parse_index; use knowledge(action=status) to check.",
            }
        )
    except Exception as exc:
        return _json({"error": "ingest_failed", "message": str(exc)})


_KNOWLEDGE_TOOL_DESCRIPTION = """\
Owned knowledge bases (default). action: list | search | read | graph | status | write | ingest.
Omit vault_id to use all owned bases; pass kb_… id to target one.
search needs query; read needs paths (max 5, read ≤3 after search); write ops: create|append|replace|delete.
User prefs/reflections → assets(note), not KB Agent Notes.
"""


@tool("knowledge", description=_KNOWLEDGE_TOOL_DESCRIPTION, parse_docstring=False)
async def knowledge_tool(
    action: str,
    vault_id: str | None = None,
    query: str = "",
    mode: str = "hybrid",
    top_k: int = 8,
    tags: list[str] | None = None,
    scopes: list[str] | None = None,
    rerank: bool = False,
    paths: list[str] | None = None,
    path: str = "",
    max_content_chars: int = 12000,
    depth: int = 1,
    direction: str = "both",
    operation: str = "",
    content: str = "",
    target: str = "",
    section: str | None = None,
    key: str = "",
    value: str = "",
    add_tags: list[str] | None = None,
    remove_tags: list[str] | None = None,
    title: str = "",
    summary: str = "",
    source: str = "evoflow",
    source_description: str = "",
    confidence: float = 0.7,
    related_paths: list[str] | None = None,
) -> str:
    """Knowledge vault / owned KB actions (policy in tool description)."""
    act = str(action or "").strip().lower()
    if act in ("ls", "browse"):
        act = "list"
    if act not in KNOWLEDGE_ACTIONS:
        return _json(
            {
                "error": "invalid_args",
                "message": f"unsupported action: {action!r}. Use one of: {', '.join(sorted(KNOWLEDGE_ACTIONS))}",
            }
        )
    if act == "list":
        prefix = str(path or "").strip()
        if not prefix and scopes:
            prefix = str(scopes[0] or "").strip()
        # top_k defaults to 8 for search; treat that default as list's 80.
        try:
            raw_limit = int(top_k) if top_k is not None else 80
        except (TypeError, ValueError):
            raw_limit = 80
        list_limit = 80 if raw_limit == 8 else raw_limit
        return await _action_list(vault_id=vault_id, prefix=prefix, limit=list_limit)
    if act == "search":
        return await _action_search(
            query=query,
            vault_id=vault_id,
            mode=mode,
            top_k=top_k,
            tags=tags,
            scopes=scopes,
            rerank=rerank,
        )
    if act == "read":
        return await _action_read(paths=paths, vault_id=vault_id, max_content_chars=max_content_chars)
    if act == "graph":
        return await _action_graph(path=path, vault_id=vault_id, depth=depth, direction=direction)
    if act == "status":
        return await _action_status(vault_id=vault_id)
    if act == "write":
        return await _action_write(
            operation=operation,
            path=path,
            vault_id=vault_id,
            content=content,
            target=target,
            section=section,
            key=key,
            value=value,
            add_tags=add_tags,
            remove_tags=remove_tags,
        )
    return await _action_ingest(
        title=title,
        content=content,
        vault_id=vault_id,
        summary=summary,
        source=source,
        source_description=source_description,
        confidence=confidence,
        tags=tags,
        related_paths=related_paths,
    )


KNOWLEDGE_VAULT_TOOLS = [knowledge_tool]
