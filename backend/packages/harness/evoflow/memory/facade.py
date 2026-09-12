"""Memory Facade: remember / recall / get_core / forget."""

from __future__ import annotations

import logging
from typing import Any

from evoflow.memory import store as mem_store

logger = logging.getLogger(__name__)


def _get_archive_floor() -> float:
    try:
        from evoflow.config.memory_config import get_memory_config

        return float(get_memory_config().consolidate.archive_vitality)
    except Exception:
        return 0.15


def remember(
    namespace: str,
    content: str,
    *,
    layer: str = "semantic",
    kind: str = "fact",
    summary: str = "",
    importance: float | None = None,
    confidence: float | None = None,
    vitality: float = 1.0,
    subject_key: str = "",
    evidence: dict[str, Any] | None = None,
    tags: list[Any] | None = None,
    source: str = "",
    pin: bool = False,
    atom_id: str | None = None,
    embedding: list[float] | None = None,
) -> str | None:
    """Write or update a memory atom. Returns atom id."""
    conf = mem_store.clamp01(confidence if confidence is not None else 0.7, 0.7)
    # Skip low-confidence noise unless pinned / explicit subject
    if conf < 0.55 and not pin and not subject_key and source not in {"user", "manual", "migrate"}:
        return None
    imp = mem_store.clamp01(
        importance if importance is not None else conf,
        0.5,
    )
    aid = mem_store.upsert_atom(
        namespace_id=namespace,
        content=content,
        layer=layer,
        kind=kind,
        summary=summary,
        importance=imp,
        confidence=conf,
        vitality=vitality,
        subject_key=subject_key,
        evidence=evidence,
        tags=tags,
        source=source,
        pin=pin,
        atom_id=atom_id,
        embedding=embedding,
    )
    if aid:
        if source != "migrate":
            _maybe_enqueue_threshold(namespace)
            _schedule_kg_batch(aid, namespace)
    return aid


def _schedule_kg_batch(atom_id: str, namespace: str) -> None:
    try:
        from evoflow.memory.kg_extract import schedule_kg_after_remember

        schedule_kg_after_remember(atom_id, namespace)
    except Exception as exc:
        logger.debug("mem_kg_batch schedule skip: %s", exc)


def _maybe_enqueue_kg_extract(atom_id: str, namespace: str) -> None:
    """Back-compat alias → batch schedule."""
    _schedule_kg_batch(atom_id, namespace)


def _maybe_enqueue_threshold(namespace: str) -> None:
    try:
        from evoflow.memory.consolidate import enqueue_consolidate, should_enqueue_threshold
        from evoflow.knowledge.owned import jobs

        if not should_enqueue_threshold(namespace):
            return
        ns = mem_store.ensure_namespace(namespace)
        kb_id = f"mem:{ns}"
        pending = jobs.list_jobs(kb_id, limit=8, states=["queued", "running"])
        if any(j.get("type") == "mem_consolidate" for j in pending):
            return
        enqueue_consolidate(ns, trigger="threshold")
    except Exception as exc:
        logger.debug("threshold consolidate enqueue skip: %s", exc)


def forget(atom_id: str, *, mode: str = "soft") -> bool:
    _ = mode
    return mem_store.soft_delete_atom(atom_id)


def consolidate(
    namespace: str,
    *,
    trigger: str = "manual",
    async_job: bool = False,
) -> dict[str, Any]:
    """Consolidate one namespace. Sync by default; set async_job to enqueue kb_jobs."""
    from evoflow.memory.consolidate import consolidate_namespace, enqueue_consolidate

    ns = (namespace or "").strip()
    if not ns:
        return {"ok": False, "error": "namespace required"}
    if async_job:
        job = enqueue_consolidate(ns, trigger=trigger)
        return {"ok": True, "queued": True, "job": job}
    return consolidate_namespace(ns, trigger=trigger)


def pin_atom(atom_id: str, pin: bool = True) -> bool:
    return mem_store.set_pin(atom_id, pin)


def mark_atom_stale(atom_id: str, *, reason: str = "", source_ref: str = "") -> bool:
    return mem_store.mark_atom_stale(atom_id, reason=reason, source_ref=source_ref)


def mark_related_memories_stale(
    *,
    query: str,
    namespaces: list[str] | None = None,
    reason: str = "",
    source_ref: str = "",
    top_k: int = 12,
) -> dict[str, Any]:
    """Keyword-match memories and mark them stale (minimal TTL substitute).

    Used when a Task / Item is closed so outdated bug claims stop driving rework.
    Pinned atoms are skipped. Does not delete.
    """
    q = " ".join(str(query or "").strip().split())
    if len(q) < 4:
        return {"ok": True, "marked": 0, "skipped": "query_too_short"}
    ns_list = [str(n).strip() for n in (namespaces or []) if str(n).strip()]
    if not ns_list:
        ns_list = [mem_store.ensure_namespace("user:default")]
        try:
            from evoflow.memory.namespaces import workspace_ns

            # Best-effort: also scan a generic workspace if configured elsewhere.
            _ = workspace_ns
        except Exception:
            pass
    try:
        hits = mem_store.search_keyword_ns(ns_list, q, top_k=max(1, min(int(top_k), 40)))
    except Exception as exc:
        logger.debug("mark_related_memories_stale search failed: %s", exc)
        return {"ok": False, "marked": 0, "error": str(exc)}
    marked: list[str] = []
    for hit in hits:
        if not isinstance(hit, dict):
            continue
        if hit.get("pin"):
            continue
        tags = hit.get("tags") or []
        if "stale" in {str(t).strip().lower() for t in tags}:
            continue
        aid = str(hit.get("id") or "").strip()
        if not aid:
            continue
        if mem_store.mark_atom_stale(
            aid,
            reason=reason or f"closed: {q[:80]}",
            source_ref=source_ref,
        ):
            marked.append(aid)
    return {
        "ok": True,
        "marked": len(marked),
        "atom_ids": marked[:20],
        "query": q[:120],
        "namespaces": ns_list,
    }


def list_atoms(
    namespace: str,
    *,
    layers: list[str] | None = None,
    pinned_only: bool = False,
    limit: int = 200,
) -> list[dict[str, Any]]:
    return mem_store.list_namespace_atoms(
        namespace,
        layers=layers,
        pinned_only=pinned_only,
        limit=limit,
    )


def get_core(
    namespaces: list[str],
    *,
    max_chars: int = 1200,
    min_confidence: float = 0.0,
) -> list[dict[str, Any]]:
    """Pinned + preference-like atoms for standing injection (not encyclopedia noise)."""
    prefer_kinds = {"preference", "behavior"}
    context_kinds = {"context"}
    picked: list[dict[str, Any]] = []
    seen: set[str] = set()
    for ns in namespaces:
        if not ns:
            continue
        for atom in mem_store.list_namespace_atoms(ns, pinned_only=True, limit=40):
            if atom["id"] in seen:
                continue
            if float(atom.get("confidence") or 0) < min_confidence:
                continue
            kind = str(atom.get("kind") or "")
            # Skip encyclopedia / section bodies here — sections come from document formatter
            if kind.startswith("section:") or kind == "knowledge":
                continue
            seen.add(atom["id"])
            picked.append(atom)
        for atom in mem_store.list_namespace_atoms(
            ns, layers=["semantic", "procedural"], limit=60
        ):
            if atom["id"] in seen:
                continue
            if float(atom.get("confidence") or 0) < max(min_confidence, 0.7):
                continue
            kind = str(atom.get("kind") or "").strip().lower()
            if kind in prefer_kinds:
                pass
            elif kind in context_kinds:
                text = str(atom.get("content") or "")
                if len(text) > 180 or float(atom.get("importance") or 0) < 0.75:
                    continue
            else:
                continue
            if float(atom.get("importance") or 0) < 0.65 and not atom.get("pin"):
                continue
            seen.add(atom["id"])
            picked.append(atom)
    out: list[dict[str, Any]] = []
    used = 0
    for atom in picked:
        text = (atom.get("summary") or atom.get("content") or "").strip()
        if not text:
            continue
        if used + len(text) > max_chars and out:
            break
        out.append(atom)
        used += len(text) + 1
    return out


def recall(
    namespaces: list[str],
    query: str,
    *,
    layers: list[str] | None = None,
    top_k: int = 8,
    max_chars: int = 1000,
    query_embedding: list[float] | None = None,
) -> list[dict[str, Any]]:
    """Hybrid archival recall for a query."""
    ns = [n for n in namespaces if n]
    q = (query or "").strip()
    if not ns:
        return []
    if not q:
        # No query: return recent high-importance archival (non-pin preference)
        hits: list[dict[str, Any]] = []
        for n in ns:
            hits.extend(
                mem_store.list_namespace_atoms(n, layers=layers, limit=top_k)
            )
        hits.sort(
            key=lambda a: (float(a.get("importance") or 0), a.get("updated_at") or ""),
            reverse=True,
        )
        return _budget(hits[:top_k], max_chars)

    kw = mem_store.search_keyword_ns(ns, q, top_k=max(top_k * 3, 12), layers=layers)
    vec: list[dict[str, Any]] = []
    if query_embedding:
        vec = mem_store.search_vector_ns(
            ns, query_embedding, top_k=max(top_k * 3, 12), layers=layers
        )
    else:
        # Try embed query best-effort (sync bridge)
        emb = _try_embed_sync(q)
        if emb:
            vec = mem_store.search_vector_ns(
                ns, emb, top_k=max(top_k * 3, 12), layers=layers
            )
    if kw and vec:
        fused = mem_store.rrf_fuse_atoms(kw, vec, top_k=top_k)
    elif kw:
        fused = kw[:top_k]
    else:
        fused = vec[:top_k]

    # Optional graph expand (default hops=0 → no-op)
    try:
        from evoflow.config.memory_config import get_memory_config
        from evoflow.memory.graph import expand_recall_atoms

        hops = int(get_memory_config().graph.expand_hops)
    except Exception:
        hops = 0
        expand_recall_atoms = None  # type: ignore
    if hops > 0 and expand_recall_atoms is not None and fused:
        neighbors = expand_recall_atoms(fused, hops=hops, limit=max(top_k * 3, 12))
        if neighbors:
            # Mild merge: keep seed order, append unseen neighbors, trim later
            seen = {a["id"] for a in fused if a.get("id")}
            for n in neighbors:
                if n.get("id") in seen:
                    continue
                seen.add(n["id"])
                fused.append(n)
            fused = fused[: max(top_k * 2, top_k)]

    mem_store.touch_accessed([a["id"] for a in fused if a.get("id")])
    return _budget(_filter_archived(fused, q), max_chars)


def _filter_archived(atoms: list[dict[str, Any]], query: str) -> list[dict[str, Any]]:
    """Drop low-vitality atoms unless pinned or query strongly overlaps content."""
    floor = _get_archive_floor()
    q = (query or "").strip().lower()
    out: list[dict[str, Any]] = []
    for atom in atoms:
        if atom.get("pin"):
            out.append(atom)
            continue
        vit = float(atom.get("vitality") or 1.0)
        if vit >= floor:
            out.append(atom)
            continue
        if not q:
            continue
        text = f"{atom.get('summary') or ''} {atom.get('content') or ''}".lower()
        # Strong hit: all query tokens appear
        tokens = [t for t in q.split() if len(t) > 1]
        if tokens and all(t in text for t in tokens):
            out.append(atom)
    return out


def format_atoms_block(
    atoms: list[dict[str, Any]],
    *,
    title: str = "Memory",
) -> str:
    if not atoms:
        return ""
    lines: list[str] = []
    for atom in atoms:
        text = (atom.get("summary") or atom.get("content") or "").strip()
        if not text:
            continue
        layer = atom.get("layer") or ""
        kind = atom.get("kind") or ""
        prefix = ""
        if layer or kind:
            prefix = f"[{layer}:{kind}] " if kind else f"[{layer}] "
        pin = "★ " if atom.get("pin") else ""
        lines.append(f"- {pin}{prefix}{text}")
    if not lines:
        return ""
    body = "\n".join(lines)
    return f"<{title.lower().replace(' ', '_')}>\n{body}\n</{title.lower().replace(' ', '_')}>"


def _budget(atoms: list[dict[str, Any]], max_chars: int) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    used = 0
    for atom in atoms:
        text = (atom.get("summary") or atom.get("content") or "").strip()
        if not text:
            continue
        if used + len(text) > max_chars and out:
            break
        out.append(atom)
        used += len(text) + 1
    return out


def _try_embed_sync(text: str) -> list[float] | None:
    try:
        import asyncio

        from evoflow.knowledge.embedding.registry import get_embedding

        async def _run() -> list[float]:
            return list(await get_embedding(text))

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        if loop and loop.is_running():
            # Avoid nested loop; skip vector in sync path
            return None
        return asyncio.run(_run())
    except Exception as exc:
        logger.debug("memory embed skip: %s", exc)
        return None
