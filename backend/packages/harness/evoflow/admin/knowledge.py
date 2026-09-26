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


def requeue_owned_orphans(kb_id: str | None = None, *, limit: int = 200) -> dict[str, Any]:
    """Re-enqueue stuck parse jobs."""
    from evoflow.knowledge.owned import service as owned_service

    kid = str(kb_id or "").strip() or None
    if kid and not kid.startswith("kb_"):
        raise ValidationError("kbId must be an owned knowledge base id (kb_…)")
    if kid and not owned_service.get_base(kid):
        raise NotFoundError(f"Owned knowledge base '{kid}' not found")
    return owned_service.requeue_orphan_parse_docs(kid, limit=limit)


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

    merged.sort(
        key=lambda x: float(x.get("rrfScore") or x.get("vectorScore") or x.get("score") or 0),
        reverse=True,
    )
    entries = merged[:top_k]
    return {
        "provider": "owned",
        "query": q,
        "kbIds": kids,
        "mode": owned_mode,
        "category": category,
        "total": len(entries),
        "entries": entries,
    }
