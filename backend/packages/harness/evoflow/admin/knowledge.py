"""Knowledge admin CLI — owned KB only (Obsidian vault support removed)."""

from __future__ import annotations

import asyncio
from typing import Any

from evoflow.admin.errors import NotFoundError, ValidationError


def _run_async(coro: Any) -> Any:
    return asyncio.run(coro)


def list_bases() -> dict[str, Any]:
    """List platform-owned knowledge bases."""
    from evoflow.knowledge.owned import service as owned_service

    items = owned_service.list_bases()
    return {"provider": "owned", "items": items, "count": len(items)}


def create_owned_base(
    *,
    name: str,
    description: str = "",
    embedding_model_ref: str | None = None,
) -> dict[str, Any]:
    """Create a platform-owned knowledge base."""
    from evoflow.knowledge.owned import service as owned_service

    title = str(name or "").strip()
    if not title:
        raise ValidationError("name is required")

    payload: dict[str, Any] = {
        "name": title,
        "description": str(description or "").strip(),
    }
    ref = str(embedding_model_ref or "").strip()
    if ref:
        payload["embeddingModelRef"] = ref

    try:
        created = owned_service.create_base(payload)
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc

    kb_id = str(created.get("id") or "").strip()
    return {
        "provider": "owned",
        "base": created,
        "kbId": kb_id,
    }


def reindex_owned_base(
    kb_id: str,
    *,
    embedding_model_ref: str | None = None,
    force: bool = True,
) -> dict[str, Any]:
    """Trigger reindex for an owned knowledge base."""
    from evoflow.knowledge.owned import service as owned_service

    kid = str(kb_id or "").strip()
    if not kid.startswith("kb_"):
        raise ValidationError("kbId must be an owned knowledge base id (kb_…)")
    if not owned_service.get_base(kid):
        raise NotFoundError(f"Owned knowledge base '{kid}' not found")
    try:
        return owned_service.reindex_base(
            kid,
            embedding_model_ref=embedding_model_ref,
            force=force,
        )
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc


def delete_owned_base(kb_id: str) -> dict[str, Any]:
    """Soft-delete a platform-owned knowledge base (destructive)."""
    from evoflow.knowledge.owned import service as owned_service

    kid = str(kb_id or "").strip()
    if not kid.startswith("kb_"):
        raise ValidationError("kbId must be an owned knowledge base id (kb_…)")
    base = owned_service.get_base(kid)
    if not base:
        raise NotFoundError(f"Owned knowledge base '{kid}' not found")
    try:
        owned_service.delete_base(kid)
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    return {
        "provider": "owned",
        "kbId": kid,
        "vaultId": kid,
        "name": str(base.get("name") or kid),
        "deleted": True,
    }


def requeue_owned_orphans(kb_id: str | None = None, *, limit: int = 200) -> dict[str, Any]:
    """Re-enqueue stuck parse jobs."""
    from evoflow.knowledge.owned import service as owned_service

    kid = str(kb_id or "").strip() or None
    if kid and not kid.startswith("kb_"):
        raise ValidationError("kbId must be an owned knowledge base id (kb_…)")
    if kid and not owned_service.get_base(kid):
        raise NotFoundError(f"Owned knowledge base '{kid}' not found")
    return owned_service.requeue_orphan_parse_docs(kid, limit=limit)


def purge_owned_orphan_jobs(*, limit: int = 500) -> dict[str, Any]:
    """Cancel failed jobs whose owning KB or document is gone."""
    from evoflow.knowledge.owned import jobs as owned_jobs

    purged = owned_jobs.purge_failed_orphan_jobs(limit=int(limit or 500))
    return {"purged": int(purged or 0)}


def _owned_target_ids(vault_id: str | None = None) -> list[str]:
    """Resolve which owned KB ids to operate on (explicit kb_… or all)."""
    from evoflow.knowledge.owned import service as owned_service

    vid = str(vault_id or "").strip()
    if vid.startswith("kb_"):
        if not owned_service.get_base(vid):
            raise NotFoundError(f"Owned knowledge base '{vid}' not found")
        return [vid]
    bases = owned_service.list_bases()
    if not bases:
        raise ValidationError("还没有自有知识库。请先在面板「自有知识库」创建或导入。")
    return [str(b["id"]) for b in bases]


def list_knowledge(
    *,
    vault_id: str | None = None,
    prefix: str = "",
    limit: int = 80,
) -> dict[str, Any]:
    """List documents across owned knowledge bases (or one explicit kb_…)."""
    from evoflow.knowledge.owned import service as owned_service

    kids = _owned_target_ids(vault_id)
    pref = (prefix or "").strip().lstrip("/")
    limit_n = max(1, min(int(limit or 80), 200))
    entries: list[dict[str, Any]] = []
    total = 0
    for kid in kids:
        docs = owned_service.list_documents(kid)
        total += len(docs)
        base = owned_service.get_base(kid) or {}
        for d in docs:
            path = (d.get("folderPath") and f"{d['folderPath']}/{d['fileName']}") or d.get("fileName") or d["id"]
            if pref and not path.startswith(pref) and not str(d.get("title") or "").startswith(pref):
                continue
            entries.append(
                {
                    "path": path,
                    "docId": d["id"],
                    "kbId": kid,
                    "kbName": base.get("name"),
                    "title": d.get("title"),
                    "parseStatus": d.get("parseStatus"),
                }
            )
            if len(entries) >= limit_n:
                break
        if len(entries) >= limit_n:
            break
    return {
        "provider": "owned",
        "kbIds": kids,
        "query": None,
        "prefix": pref or None,
        "total": total,
        "count": len(entries),
        "truncated": len(entries) < total,
        "entries": entries,
    }


def get_knowledge(path: str, *, vault_id: str | None = None) -> dict[str, Any]:
    """Read one document (docId or folder/file path) from owned knowledge bases."""
    from evoflow.knowledge.owned import service as owned_service

    note_path = str(path or "").strip()
    if not note_path:
        raise ValidationError("path is required")

    kids = _owned_target_ids(vault_id)
    for kid in kids:
        doc = owned_service.resolve_document(kid, note_path)
        if not doc:
            continue
        content = owned_service.get_document_content(doc["id"]) or {}
        return {
            "provider": "owned",
            "kbId": kid,
            "item": {
                "docId": doc["id"],
                "path": note_path,
                "title": doc.get("title"),
                "content": content.get("content") or "",
                "parseStatus": doc.get("parseStatus"),
            },
        }
    raise NotFoundError(f"Document '{note_path}' not found in owned knowledge bases")


def remember(data: dict[str, Any], *, vault_id: str | None = None) -> dict[str, Any]:
    """Ingest a note into an owned knowledge base (kb_… or first existing)."""
    from evoflow.knowledge.owned import service as owned_service

    if not isinstance(data, dict):
        raise ValidationError("Knowledge payload must be a JSON object")
    title = str(data.get("title") or "").strip()
    content = str(data.get("knowledge") or data.get("content") or "").strip()
    if not title:
        raise ValidationError("title is required")
    if not content:
        raise ValidationError("knowledge/content is required")

    explicit = vault_id or data.get("vaultId") or data.get("vault_id") or data.get("kbId") or data.get("kb_id")
    explicit_s = str(explicit).strip() if explicit else None
    kids = _owned_target_ids(explicit_s)
    kid = kids[0]
    doc = owned_service.upload_manual_markdown(
        kid,
        title=title,
        content=content,
        folder_path=str(data.get("inboxPath") or data.get("inbox_path") or "00-Inbox"),
    )
    return {
        "provider": "owned",
        "kbId": kid,
        "ok": True,
        "result": doc,
        "path": str(doc.get("fileName") or doc.get("path") or ""),
        "via": "owned",
    }


def delete_knowledge(path: str, *, vault_id: str | None = None) -> dict[str, Any]:
    """Delete one document (docId or folder/file path) from owned knowledge bases."""
    from evoflow.knowledge.owned import service as owned_service

    note_path = str(path or "").strip()
    if not note_path:
        raise ValidationError("path is required")

    kids = _owned_target_ids(vault_id)
    for kid in kids:
        doc = owned_service.resolve_document(kid, note_path)
        if not doc:
            continue
        owned_service.delete_document(doc["id"])
        return {"provider": "owned", "kbId": kid, "ok": True, "deleted": note_path}
    raise NotFoundError(f"Document '{note_path}' not found in owned knowledge bases")


def recall(
    query: str,
    *,
    kb_id: str | None = None,
    category: str | None = None,
    limit: int = 8,
    mode: str = "fulltext",
) -> dict[str, Any]:
    """Search owned knowledge bases."""
    from evoflow.knowledge.owned import service as owned_service

    q = str(query or "").strip()
    if not q:
        raise ValidationError("query required")
    mode_s = str(mode or "fulltext").strip().lower() or "fulltext"
    top_k = max(1, min(int(limit or 8), 20))
    tags = [str(category).strip()] if category else None

    # Resolve target KBs
    kids: list[str] = []
    if kb_id:
        kid = str(kb_id).strip()
        if not kid.startswith("kb_"):
            raise ValidationError("kbId must start with kb_")
        if not owned_service.get_base(kid):
            raise NotFoundError(f"Knowledge base '{kid}' not found")
        kids = [kid]
    else:
        bases = owned_service.list_bases()
        kids = [str(b["id"]) for b in bases if str(b["id"]).startswith("kb_")]

    if not kids:
        return {"provider": "owned", "query": q, "kbIds": [], "entries": [], "total": 0}

    owned_mode = {
        "fulltext": "keyword",
        "keyword": "keyword",
        "title": "title",
        "hybrid": "hybrid",
        "semantic": "semantic",
        "vector": "semantic",
    }.get(mode_s, "hybrid")

    merged: list[dict[str, Any]] = []
    for kid in kids:
        result = _run_async(owned_service.search(kid, q, mode=owned_mode, top_k=top_k, tags=tags))
        base = owned_service.get_base(kid) or {}
        for item in result.get("items") or []:
            merged.append({**item, "kbId": kid, "kbName": base.get("name"), "provider": "owned"})

    from evoflow.knowledge.owned.retrieve import rerank_by_query_match

    entries = rerank_by_query_match(merged, q)[:top_k]
    return {
        "provider": "owned",
        "query": q,
        "kbIds": kids,
        "mode": owned_mode,
        "category": category,
        "total": len(entries),
        "entries": entries,
    }
