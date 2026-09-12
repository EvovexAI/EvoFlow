"""LLM-only memory knowledge-graph extract.

Hot path: ``remember`` marks atoms dirty and schedules **one** ``mem_kg_batch``
per namespace (debounced). Batch job extracts many atoms in a single LLM call.

See internal design docs (not published in this repository) §13.3.2.
Heuristic / regex fill is intentionally NOT used as a fallback.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from evoflow.config.memory_config import get_memory_config
from evoflow.knowledge.owned import jobs, kg
from evoflow.knowledge.owned.db import db
from evoflow.knowledge.owned.ids import utc_now
from evoflow.memory import store as mem_store

logger = logging.getLogger(__name__)

_JSON_OBJ_RE = re.compile(r"\{[\s\S]*\}")
_ALLOWED_RELS = frozenset({"ABOUT", "RELATED", "RESULTED_IN", "APPLIES_TO", "EVIDENCED_BY", "相关", "是"})
_SKIP_LAYER_KINDS = frozenset({"identity", "soul", "system"})
_BOOTSTRAP_SOURCES = frozenset({"bootstrap", "bootstrap-scan", "migrate"})
_SECRET_HINT = re.compile(
    r"(api[_-]?key|secret|password|token|bearer\s+[a-z0-9]|sk-[a-z0-9]{10,})",
    re.I,
)


def mem_kb_id(namespace_id: str) -> str:
    ns = mem_store.ensure_namespace(namespace_id)
    return f"mem:{ns}"


def _dirty_meta_key(namespace_id: str) -> str:
    return f"mem_kg_dirty:{mem_store.ensure_namespace(namespace_id)}"


def mark_atoms_kg_dirty(namespace_id: str, atom_ids: list[str]) -> None:
    """Record atom ids that need graph extract (no LLM yet)."""
    ns = mem_store.ensure_namespace(namespace_id)
    incoming = [str(a).strip() for a in atom_ids if str(a or "").strip()]
    if not incoming:
        return
    key = _dirty_meta_key(ns)
    raw = mem_store.migration_flag(key)
    try:
        existing = json.loads(raw) if raw else []
    except Exception:
        existing = []
    if not isinstance(existing, list):
        existing = []
    merged: list[str] = []
    seen: set[str] = set()
    for aid in [*existing, *incoming]:
        a = str(aid).strip()
        if not a or a in seen:
            continue
        seen.add(a)
        merged.append(a)
        if len(merged) >= 800:
            break
    mem_store.set_migration_flag(key, json.dumps(merged, ensure_ascii=False))


def pop_dirty_atom_ids(namespace_id: str, limit: int) -> list[str]:
    """Atomically take up to ``limit`` dirty ids."""
    ns = mem_store.ensure_namespace(namespace_id)
    key = _dirty_meta_key(ns)
    lim = max(1, min(int(limit or 24), 80))
    raw = mem_store.migration_flag(key)
    try:
        existing = json.loads(raw) if raw else []
    except Exception:
        existing = []
    if not isinstance(existing, list) or not existing:
        return []
    taken = [str(x).strip() for x in existing[:lim] if str(x or "").strip()]
    rest = [str(x).strip() for x in existing[lim:] if str(x or "").strip()]
    if rest:
        mem_store.set_migration_flag(key, json.dumps(rest, ensure_ascii=False))
    else:
        mem_store.set_migration_flag(key, "[]")
    return taken


def dirty_count(namespace_id: str) -> int:
    raw = mem_store.migration_flag(_dirty_meta_key(namespace_id))
    try:
        existing = json.loads(raw) if raw else []
    except Exception:
        return 0
    return len(existing) if isinstance(existing, list) else 0


def clear_atom_entities(atom_id: str) -> None:
    with db() as conn:
        conn.execute("DELETE FROM mem_atom_entities WHERE atom_id=?", (atom_id,))


def link_atom_entity(atom_id: str, node_id: str, kb_id: str, *, role: str = "about") -> None:
    role_n = (role or "about").strip().lower() or "about"
    with db() as conn:
        conn.execute(
            """
            INSERT INTO mem_atom_entities(atom_id, node_id, kb_id, role)
            VALUES (?,?,?,?)
            ON CONFLICT(atom_id, node_id, role) DO UPDATE SET kb_id=excluded.kb_id
            """,
            (atom_id, node_id, kb_id, role_n),
        )


def list_atom_entities(atom_id: str) -> list[dict[str, Any]]:
    with db() as conn:
        rows = conn.execute(
            """
            SELECT e.*, n.name AS node_name
            FROM mem_atom_entities e
            LEFT JOIN kg_nodes n ON n.id = e.node_id
            WHERE e.atom_id=?
            """,
            (atom_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def _should_skip_atom(atom: dict[str, Any]) -> str | None:
    """Hard skips (secrets / empty / identity)."""
    kind = str(atom.get("kind") or "").strip().lower()
    if kind in _SKIP_LAYER_KINDS:
        return f"skip kind={kind}"
    text = f"{atom.get('summary') or ''} {atom.get('content') or ''}"
    if _SECRET_HINT.search(text):
        return "skip secret-like content"
    if not str(atom.get("content") or "").strip():
        return "empty content"
    return None


def _should_skip_batch_llm(atom: dict[str, Any]) -> str | None:
    """Policy skips for batch LLM (sections / bootstrap noise)."""
    hard = _should_skip_atom(atom)
    if hard:
        return hard
    cfg = get_memory_config().graph
    kind = str(atom.get("kind") or "")
    source = str(atom.get("source") or "").strip().lower()
    if getattr(cfg, "skip_section_llm", True) and (
        kind.startswith("section:") or str(atom.get("subject_key") or "").startswith("section.")
    ):
        return "skip section summary"
    if getattr(cfg, "skip_bootstrap_source", True) and source in _BOOTSTRAP_SOURCES:
        return "skip bootstrap/migrate source"
    return None


def _norm_rel(rel: str) -> str:
    r = (rel or "RELATED").strip().upper().replace(" ", "_")
    aliases = {
        "相关": "RELATED",
        "RELATED_TO": "RELATED",
        "ABOUT": "ABOUT",
        "RESULTED_IN": "RESULTED_IN",
        "APPLIES_TO": "APPLIES_TO",
        "EVIDENCED_BY": "EVIDENCED_BY",
        "是": "RELATED",
    }
    mapped = aliases.get(r, r)
    if mapped not in {"ABOUT", "RELATED", "RESULTED_IN", "APPLIES_TO", "EVIDENCED_BY"}:
        return "RELATED"
    return mapped


def _norm_name(name: str) -> str:
    return re.sub(r"\s+", " ", str(name or "").strip())[:120]


async def extract_graph_llm(atom: dict[str, Any]) -> dict[str, Any]:
    """Call LLM for a single atom (rebuild / legacy job). Raise on failure."""
    content = str(atom.get("content") or "").strip()
    evidence = atom.get("evidence") or {}
    ev_s = ""
    if isinstance(evidence, dict) and evidence:
        try:
            ev_s = json.dumps(evidence, ensure_ascii=False)[:800]
        except Exception:
            ev_s = str(evidence)[:800]
    prompt = (
        "你是记忆图谱抽取器。根据记忆原子内容抽取实体与关系。\n"
        "只输出一个 JSON 对象（不要 Markdown），schema:\n"
        '{"nodes":[{"name":"实体名","kind":"concept|person|task|tool|other"}],'
        '"edges":[{"src":"实体A","rel":"ABOUT|RELATED|RESULTED_IN|APPLIES_TO|EVIDENCED_BY","dst":"实体B"}]}\n'
        "规则：\n"
        "- 只抽内容/证据里出现的实体与关系，禁止编造\n"
        "- 不要把 Identity、密钥、工具原始 dump 当实体\n"
        "- 最多 8 个 nodes、10 条 edges\n"
        f"layer={atom.get('layer')} kind={atom.get('kind')}\n"
        f"content:\n{content[:3000]}\n"
        f"evidence:\n{ev_s or '(none)'}\n"
    )
    from evoflow.context.internal_model_invoke import ainvoke_internal_chat_model
    from evoflow.models import create_chat_model

    model_name = get_memory_config().model_name
    model = create_chat_model(
        name=model_name,
        thinking_enabled=False,
        invocation_kind="mem_kg_extract",
    )
    resp = await ainvoke_internal_chat_model(model, [{"role": "user", "content": prompt}])
    raw = str(getattr(resp, "content", "") or resp).strip()
    m = _JSON_OBJ_RE.search(raw)
    if not m:
        raise ValueError("mem_kg_extract: LLM response missing JSON object")
    data = json.loads(m.group(0))
    if not isinstance(data, dict):
        raise ValueError("mem_kg_extract: JSON root must be object")
    nodes = data.get("nodes") if isinstance(data.get("nodes"), list) else []
    edges = data.get("edges") if isinstance(data.get("edges"), list) else []
    return {"nodes": nodes[:8], "edges": edges[:10], "raw": raw[:500]}


async def extract_graph_llm_batch(atoms: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """One LLM call for many atoms. Returns map atom_id → {nodes, edges}."""
    if not atoms:
        return {}
    if len(atoms) == 1:
        one = await extract_graph_llm(atoms[0])
        return {str(atoms[0].get("id") or ""): one}

    blocks: list[str] = []
    for atom in atoms:
        aid = str(atom.get("id") or "")
        content = str(atom.get("content") or "").strip()[:1200]
        blocks.append(
            f"- atom_id={aid} layer={atom.get('layer')} kind={atom.get('kind')}\n"
            f"  content: {content}"
        )
    prompt = (
        "你是记忆图谱抽取器。下面有多条记忆原子，请为每条分别抽取实体与关系。\n"
        "只输出一个 JSON 对象（不要 Markdown），schema:\n"
        '{"items":[{"atom_id":"...","nodes":[{"name":"...","kind":"concept|person|task|tool|other"}],'
        '"edges":[{"src":"...","rel":"ABOUT|RELATED|RESULTED_IN|APPLIES_TO|EVIDENCED_BY","dst":"..."}]}]}\n'
        "规则：\n"
        "- 每条 atom 独立抽取；禁止编造未出现的实体\n"
        "- 不要把 Identity、密钥、工具原始 dump 当实体\n"
        "- 每条最多 6 个 nodes、8 条 edges；无实体则 nodes/edges 为空数组\n"
        "- items 必须覆盖输入的每个 atom_id\n"
        "原子列表：\n"
        + "\n".join(blocks)
        + "\n"
    )
    from evoflow.context.internal_model_invoke import ainvoke_internal_chat_model
    from evoflow.models import create_chat_model

    model_name = get_memory_config().model_name
    model = create_chat_model(
        name=model_name,
        thinking_enabled=False,
        invocation_kind="mem_kg_batch",
    )
    resp = await ainvoke_internal_chat_model(model, [{"role": "user", "content": prompt}])
    raw = str(getattr(resp, "content", "") or resp).strip()
    m = _JSON_OBJ_RE.search(raw)
    if not m:
        raise ValueError("mem_kg_batch: LLM response missing JSON object")
    data = json.loads(m.group(0))
    if not isinstance(data, dict):
        raise ValueError("mem_kg_batch: JSON root must be object")
    items = data.get("items") if isinstance(data.get("items"), list) else []
    out: dict[str, dict[str, Any]] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        aid = str(item.get("atom_id") or "").strip()
        if not aid:
            continue
        nodes = item.get("nodes") if isinstance(item.get("nodes"), list) else []
        edges = item.get("edges") if isinstance(item.get("edges"), list) else []
        out[aid] = {"nodes": nodes[:6], "edges": edges[:8]}
    # Ensure every input id present (empty graph if model omitted)
    for atom in atoms:
        aid = str(atom.get("id") or "")
        if aid and aid not in out:
            out[aid] = {"nodes": [], "edges": []}
    return out


def apply_extracted_graph(
    atom: dict[str, Any],
    extracted: dict[str, Any],
) -> dict[str, Any]:
    """Normalize LLM output and write kg_* + mem_atom_entities. No inventing edges."""
    ns = str(atom.get("namespace_id") or "")
    atom_id = str(atom.get("id") or "")
    if not ns or not atom_id:
        raise ValueError("atom missing id/namespace")
    kb_id = mem_kb_id(ns)
    clear_atom_entities(atom_id)

    name_to_id: dict[str, str] = {}
    nodes_in = extracted.get("nodes") or []
    for item in nodes_in:
        if not isinstance(item, dict):
            continue
        name = _norm_name(str(item.get("name") or ""))
        if not name or _SECRET_HINT.search(name):
            continue
        kind = str(item.get("kind") or "concept").strip()[:40]
        node = kg.upsert_node(kb_id, name, chunk_id=atom_id, attrs=[{"kind": kind, "source": "mem_kg"}])
        name_to_id[node["name"]] = node["id"]
        link_atom_entity(atom_id, node["id"], kb_id, role="about")

    edges_added = 0
    for item in extracted.get("edges") or []:
        if not isinstance(item, dict):
            continue
        src = _norm_name(str(item.get("src") or ""))
        dst = _norm_name(str(item.get("dst") or ""))
        rel = _norm_rel(str(item.get("rel") or "RELATED"))
        if not src or not dst or src == dst:
            continue
        if src not in name_to_id:
            node = kg.upsert_node(kb_id, src, chunk_id=atom_id, attrs=[{"source": "mem_kg"}])
            name_to_id[node["name"]] = node["id"]
            link_atom_entity(atom_id, node["id"], kb_id, role="about")
        if dst not in name_to_id:
            node = kg.upsert_node(kb_id, dst, chunk_id=atom_id, attrs=[{"source": "mem_kg"}])
            name_to_id[node["name"]] = node["id"]
            link_atom_entity(atom_id, node["id"], kb_id, role="about")
        role = "about"
        if rel == "APPLIES_TO":
            role = "applies"
        elif rel == "EVIDENCED_BY":
            role = "evidence"
        if role != "about":
            link_atom_entity(atom_id, name_to_id[dst], kb_id, role=role)
        kg.upsert_edge(kb_id, name_to_id[src], name_to_id[dst], rel)
        edges_added += 1

    return {
        "kb_id": kb_id,
        "atom_id": atom_id,
        "nodes": len(name_to_id),
        "edges": edges_added,
    }


async def run_mem_kg_extract(job: dict[str, Any]) -> dict[str, Any]:
    """Legacy single-atom job (still supported for old queued work)."""
    payload = job.get("payload") or {}
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except Exception:
            payload = {}
    atom_id = str(payload.get("atom_id") or "").strip()
    if not atom_id:
        raise ValueError("mem_kg_extract missing atom_id")
    atom = mem_store.get_atom(atom_id)
    if not atom:
        raise ValueError(f"atom not found: {atom_id}")
    skip = _should_skip_batch_llm(atom)
    if skip:
        return {"ok": True, "skipped": skip, "atom_id": atom_id}
    extracted = await extract_graph_llm(atom)
    applied = apply_extracted_graph(atom, extracted)
    return {"ok": True, **applied}


async def run_mem_kg_batch(job: dict[str, Any]) -> dict[str, Any]:
    """Process dirty atoms for one namespace with a single LLM call."""
    payload = job.get("payload") or {}
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except Exception:
            payload = {}
    ns = str(payload.get("namespace") or "").strip()
    if not ns:
        raise ValueError("mem_kg_batch missing namespace")
    cfg = get_memory_config().graph
    if not cfg.extract_enabled:
        return {"ok": True, "skipped": "extract_disabled", "namespace": ns}

    batch_size = int(getattr(cfg, "batch_size", 24) or 24)
    ids = pop_dirty_atom_ids(ns, batch_size)
    atoms: list[dict[str, Any]] = []
    skipped: list[dict[str, str]] = []
    for aid in ids:
        atom = mem_store.get_atom(aid)
        if not atom or atom.get("deleted_at"):
            skipped.append({"atom_id": aid, "reason": "missing"})
            continue
        reason = _should_skip_batch_llm(atom)
        if reason:
            skipped.append({"atom_id": aid, "reason": reason})
            continue
        atoms.append(atom)

    applied_n = 0
    node_total = 0
    edge_total = 0
    if atoms:
        extracted_map = await extract_graph_llm_batch(atoms)
        for atom in atoms:
            aid = str(atom.get("id") or "")
            piece = extracted_map.get(aid) or {"nodes": [], "edges": []}
            applied = apply_extracted_graph(atom, piece)
            applied_n += 1
            node_total += int(applied.get("nodes") or 0)
            edge_total += int(applied.get("edges") or 0)

    remaining = dirty_count(ns)
    if remaining > 0:
        # Continue draining without extra debounce
        enqueue_mem_kg_batch(ns, debounce_seconds=0, priority=210)

    return {
        "ok": True,
        "namespace": ns,
        "processed": applied_n,
        "skipped": len(skipped),
        "skipped_detail": skipped[:20],
        "nodes": node_total,
        "edges": edge_total,
        "remaining_dirty": remaining,
    }


def _run_after_iso(debounce_seconds: float) -> str:
    sec = max(0.0, float(debounce_seconds or 0))
    when = datetime.now(timezone.utc) + timedelta(seconds=sec)
    return when.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def enqueue_mem_kg_batch(
    namespace_id: str,
    *,
    priority: int = 200,
    debounce_seconds: float | None = None,
) -> dict[str, Any] | None:
    """Schedule one batch extract job per namespace (debounced)."""
    cfg = get_memory_config().graph
    if not cfg.extract_enabled:
        return None
    ns = mem_store.ensure_namespace(namespace_id)
    if dirty_count(ns) <= 0:
        return None
    kb_id = mem_kb_id(ns)
    delay = (
        float(debounce_seconds)
        if debounce_seconds is not None
        else float(getattr(cfg, "batch_debounce_seconds", 45) or 45)
    )
    run_after = _run_after_iso(delay)

    pending = jobs.list_jobs(kb_id, limit=30, states=["queued", "running"])
    for j in pending:
        if j.get("type") != "mem_kg_batch":
            continue
        # Already scheduled — pull run_after forward if we want sooner flush
        if delay <= 0 and j.get("state") == "queued":
            with db() as conn:
                conn.execute(
                    "UPDATE kb_jobs SET run_after=?, updated_at=? WHERE id=? AND state='queued'",
                    (utc_now(), utc_now(), j["id"]),
                )
            return j
        return j

    from evoflow.knowledge.owned.worker import ensure_owned_kb_worker_started

    job = jobs.enqueue(
        kb_id=kb_id,
        type="mem_kg_batch",
        doc_id=None,
        priority=priority,
        payload={"namespace": ns},
        run_after=run_after,
    )
    ensure_owned_kb_worker_started()
    return job


def schedule_kg_after_remember(atom_id: str, namespace_id: str) -> None:
    """Hot-path hook: mark dirty + debounce batch (no per-atom LLM)."""
    cfg = get_memory_config().graph
    if not cfg.extract_enabled:
        return
    aid = (atom_id or "").strip()
    if not aid:
        return
    mark_atoms_kg_dirty(namespace_id, [aid])
    enqueue_mem_kg_batch(namespace_id)


def flush_kg_batch(namespace_id: str) -> dict[str, Any] | None:
    """After a bulk save: ensure batch runs soon."""
    return enqueue_mem_kg_batch(namespace_id, debounce_seconds=0, priority=190)


def enqueue_mem_kg_extract(atom_id: str, namespace_id: str, *, priority: int = 220) -> dict[str, Any] | None:
    """Deprecated hot path: redirect to dirty + batch.

    Kept for callers/tests; does **not** enqueue per-atom LLM jobs anymore.
    """
    schedule_kg_after_remember(atom_id, namespace_id)
    return enqueue_mem_kg_batch(namespace_id, priority=priority)
