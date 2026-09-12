"""Namespace memory consolidate: merge / decay / GC (deterministic, no LLM).

See internal design docs (not published in this repository) §13.2.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Any

from evoflow.config.memory_config import get_memory_config
from evoflow.knowledge.owned.retrieve import cosine
from evoflow.memory import store as mem_store
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

_TOKEN_RE = re.compile(r"[\w\u4e00-\u9fff]+", re.UNICODE)
# Layers eligible for similarity merge (L3/L4). L2 episodic never fuzzy-merges.
_MERGE_LAYERS = frozenset({"semantic", "procedural"})


def _cfg() -> Any:
    return get_memory_config().consolidate


def _parse_ts(raw: str | None) -> datetime | None:
    s = (raw or "").strip()
    if not s:
        return None
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def _days_since(raw: str | None, *, now: datetime) -> float:
    dt = _parse_ts(raw)
    if not dt:
        return 0.0
    return max(0.0, (now - dt).total_seconds() / 86400.0)


def _tokens(text: str) -> set[str]:
    return {t.lower() for t in _TOKEN_RE.findall(text or "") if len(t) > 1}


def _char_bigrams(text: str) -> set[str]:
    s = re.sub(r"\s+", "", (text or "").lower())
    if len(s) < 2:
        return {s} if s else set()
    return {s[i : i + 2] for i in range(len(s) - 1)}


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union else 0.0


def text_overlap(a: str, b: str) -> float:
    """Best of token Jaccard and char-bigram Jaccard (better for CJK)."""
    return max(_jaccard(_tokens(a), _tokens(b)), _jaccard(_char_bigrams(a), _char_bigrams(b)))


def _similarity(a: dict[str, Any], b: dict[str, Any]) -> float:
    va = a.get("embedding_vec")
    vb = b.get("embedding_vec")
    if isinstance(va, list) and isinstance(vb, list) and va and vb and len(va) == len(vb):
        try:
            return float(cosine(va, vb))
        except Exception:
            pass
    text_a = f"{a.get('summary') or ''} {a.get('content') or ''}".strip()
    text_b = f"{b.get('summary') or ''} {b.get('content') or ''}".strip()
    return text_overlap(text_a, text_b)


def _keep_prefer(a: dict[str, Any], b: dict[str, Any]) -> dict[str, Any]:
    """Prefer pin, then higher confidence/importance, then longer content, then newer."""
    for key, reverse in (("pin", True), ("confidence", True), ("importance", True)):
        av, bv = a.get(key), b.get(key)
        if bool(av) != bool(bv) and key == "pin":
            return a if av else b
        if key != "pin":
            try:
                af, bf = float(av or 0), float(bv or 0)
            except (TypeError, ValueError):
                continue
            if af != bf:
                return a if af > bf else b
    la = len(str(a.get("content") or ""))
    lb = len(str(b.get("content") or ""))
    if la != lb:
        return a if la > lb else b
    return a if str(a.get("updated_at") or "") >= str(b.get("updated_at") or "") else b


def _merge_content(keep: dict[str, Any], drop: dict[str, Any]) -> str:
    kc = str(keep.get("content") or "").strip()
    dc = str(drop.get("content") or "").strip()
    if not dc or dc in kc:
        return kc
    if not kc or kc in dc:
        return dc
    # Prefer longer; append short unique fragment if useful
    if len(kc) >= len(dc):
        return kc
    return dc


def consolidate_namespace(
    namespace_id: str,
    *,
    trigger: str = "manual",
    similarity_merge: float | None = None,
    decay_factor: float | None = None,
    archive_vitality: float | None = None,
    gc_min_confidence: float | None = None,
    gc_idle_days: int | None = None,
) -> dict[str, Any]:
    """Run consolidate for one namespace. Deterministic; no LLM."""
    cfg = _cfg()
    sim_th = float(similarity_merge if similarity_merge is not None else cfg.similarity_merge)
    decay = float(decay_factor if decay_factor is not None else cfg.decay_factor)
    # archive_vitality reserved for recall filtering (facade); decay still applied here
    _ = float(archive_vitality if archive_vitality is not None else cfg.archive_vitality)
    gc_conf = float(gc_min_confidence if gc_min_confidence is not None else cfg.gc_min_confidence)
    gc_days = int(gc_idle_days if gc_idle_days is not None else cfg.gc_idle_days)

    ns = mem_store.ensure_namespace(namespace_id)
    now = datetime.now(timezone.utc)
    now_iso = utc_now_iso_z()

    atoms = mem_store.list_namespace_atoms(ns, limit=2000)
    stats = {
        "namespace": ns,
        "trigger": trigger,
        "scanned": len(atoms),
        "subject_merged": 0,
        "similarity_merged": 0,
        "decayed": 0,
        "gc_deleted": 0,
        "skipped_pin": 0,
    }

    # --- A1. Same subject_key (all layers; L2 only when subject matches) ---
    by_subject: dict[str, list[dict[str, Any]]] = {}
    for atom in atoms:
        sk = str(atom.get("subject_key") or "").strip()
        if not sk:
            continue
        by_subject.setdefault(sk, []).append(atom)

    active_ids = {a["id"] for a in atoms}
    for _sk, group in by_subject.items():
        live = [a for a in group if a["id"] in active_ids]
        if len(live) < 2:
            continue
        keep = live[0]
        for cand in live[1:]:
            keep = _keep_prefer(keep, cand)
        for cand in live:
            if cand["id"] == keep["id"]:
                continue
            if cand.get("pin") and not keep.get("pin"):
                # Pin may only be superseded by another pin / higher-confidence keep already preferred
                stats["skipped_pin"] += 1
                continue
            merged = _merge_content(keep, cand)
            if merged != str(keep.get("content") or ""):
                mem_store.update_atom_fields(
                    keep["id"],
                    content=merged,
                    importance=max(float(keep.get("importance") or 0), float(cand.get("importance") or 0)),
                    confidence=max(float(keep.get("confidence") or 0), float(cand.get("confidence") or 0)),
                )
                keep["content"] = merged
            mem_store.supersede_atom(cand["id"], keep["id"], source="consolidate_subject")
            active_ids.discard(cand["id"])
            stats["subject_merged"] += 1

    # Refresh after subject pass
    atoms = mem_store.list_namespace_atoms(ns, limit=2000)
    active_ids = {a["id"] for a in atoms}

    # --- A2. Similarity merge (semantic/procedural only; never L2 fuzzy) ---
    merge_pool = [
        a
        for a in atoms
        if a["id"] in active_ids and str(a.get("layer") or "") in _MERGE_LAYERS and not str(a.get("subject_key") or "").strip()
    ]
    merge_pool.sort(key=lambda a: (float(a.get("importance") or 0), a.get("updated_at") or ""), reverse=True)
    consumed: set[str] = set()
    for i, a in enumerate(merge_pool):
        if a["id"] in consumed or a["id"] not in active_ids:
            continue
        for b in merge_pool[i + 1 :]:
            if b["id"] in consumed or b["id"] not in active_ids:
                continue
            if str(a.get("layer")) != str(b.get("layer")):
                continue
            score = _similarity(a, b)
            if score < sim_th:
                continue
            keep, drop = (a, b) if _keep_prefer(a, b) is a else (b, a)
            if drop.get("pin") and not keep.get("pin"):
                stats["skipped_pin"] += 1
                continue
            if drop.get("pin") and keep.get("pin"):
                # Both pinned: allow supersede only if keep is clearly better
                if float(keep.get("confidence") or 0) < float(drop.get("confidence") or 0):
                    stats["skipped_pin"] += 1
                    continue
            merged = _merge_content(keep, drop)
            mem_store.update_atom_fields(
                keep["id"],
                content=merged,
                importance=max(float(keep.get("importance") or 0), float(drop.get("importance") or 0)),
                confidence=max(float(keep.get("confidence") or 0), float(drop.get("confidence") or 0)),
            )
            keep["content"] = merged
            mem_store.supersede_atom(drop["id"], keep["id"], source="consolidate_sim")
            try:
                from evoflow.memory.kg_extract import mark_atoms_kg_dirty

                mark_atoms_kg_dirty(ns, [str(keep["id"])])
            except Exception:
                pass
            consumed.add(drop["id"])
            active_ids.discard(drop["id"])
            stats["similarity_merged"] += 1

    # --- B. Vitality decay ---
    atoms = mem_store.list_namespace_atoms(ns, limit=2000)
    for atom in atoms:
        if atom.get("pin"):
            continue
        anchor = atom.get("last_accessed_at") or atom.get("updated_at") or atom.get("created_at")
        days = _days_since(str(anchor) if anchor else None, now=now)
        if days < 1.0:
            continue
        old_v = float(atom.get("vitality") or 1.0)
        new_v = old_v * (decay ** (days / 7.0))
        new_v = max(0.0, min(1.0, new_v))
        if abs(new_v - old_v) < 1e-6:
            continue
        mem_store.update_atom_fields(atom["id"], vitality=new_v)
        stats["decayed"] += 1

    # --- C. Low-confidence GC (pin exempt) ---
    atoms = mem_store.list_namespace_atoms(ns, limit=2000)
    for atom in atoms:
        if atom.get("pin"):
            stats["skipped_pin"] += 1
            continue
        conf = float(atom.get("confidence") or 0)
        if conf >= gc_conf:
            continue
        anchor = atom.get("last_accessed_at") or atom.get("updated_at") or atom.get("created_at")
        idle = _days_since(str(anchor) if anchor else None, now=now)
        if idle < float(gc_days):
            continue
        mem_store.soft_delete_atom(atom["id"], source="consolidate_gc")
        stats["gc_deleted"] += 1

    stats["finished_at"] = now_iso
    stats["active_after"] = mem_store.count_active_atoms(ns)
    try:
        from evoflow.memory.kg_extract import flush_kg_batch

        flush_kg_batch(ns)
    except Exception:
        logger.debug("consolidate kg batch schedule skipped", exc_info=True)
    logger.info(
        "mem consolidate ns=%s trigger=%s merged_subj=%s merged_sim=%s decayed=%s gc=%s",
        ns,
        trigger,
        stats["subject_merged"],
        stats["similarity_merged"],
        stats["decayed"],
        stats["gc_deleted"],
    )
    return stats


def should_enqueue_threshold(namespace_id: str) -> bool:
    cfg = _cfg()
    return mem_store.count_active_atoms(namespace_id) > int(cfg.max_active_atoms)


def enqueue_consolidate(
    namespace_id: str,
    *,
    trigger: str = "manual",
    priority: int = 180,
) -> dict[str, Any]:
    """Enqueue mem_consolidate on owned kb_jobs (kb_id = mem:{ns})."""
    from evoflow.knowledge.owned import jobs
    from evoflow.knowledge.owned.worker import ensure_owned_kb_worker_started

    ns = mem_store.ensure_namespace(namespace_id)
    kb_id = f"mem:{ns}"
    job = jobs.enqueue(
        kb_id=kb_id,
        type="mem_consolidate",
        doc_id=None,
        priority=priority,
        payload={"namespace": ns, "trigger": trigger},
    )
    ensure_owned_kb_worker_started()
    return job


def run_consolidate_job(job: dict[str, Any]) -> dict[str, Any]:
    payload = job.get("payload") or {}
    ns = str(payload.get("namespace") or "").strip()
    if not ns:
        # Fallback: strip mem: prefix from kb_id
        kb = str(job.get("kb_id") or job.get("kbId") or "")
        ns = kb[4:] if kb.startswith("mem:") else kb
    trigger = str(payload.get("trigger") or "job")
    if not ns:
        raise ValueError("mem_consolidate job missing namespace")
    return consolidate_namespace(ns, trigger=trigger)
