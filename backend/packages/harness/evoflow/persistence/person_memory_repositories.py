"""SQLite repository for Person Kernel autobiographical + procedural memory."""

from __future__ import annotations

import json
import uuid
from typing import Any

from evoflow.persistence.db import get_db, run_db_transaction
from evoflow.timeutil import utc_now_iso_z

_VALID_LAYERS = frozenset({"journal", "episodic", "semantic_self", "procedural"})
_VALID_STATUS = frozenset({"", "proposed", "corrected", "graduated", "retired"})
_VALID_KINDS = frozenset({"", "howto", "negative", "check"})
_VALID_TIERS = frozenset({"core", "archival"})

_SELECT_COLS = (
    "id, agent_code, layer, content, importance, vitality, "
    "round_id, source, created_at, status, kind, title, evidence_json, "
    "hit_count, updated_at, skill_name, access_tier, embedding_json"
)


def _row_dict(row: Any) -> dict[str, Any]:
    return {k: row[k] for k in row.keys()}


def _dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _loads(raw: str | None) -> Any:
    if not raw:
        return {}
    try:
        out = json.loads(raw)
        return out if isinstance(out, dict) else {}
    except Exception:
        return {}


def _enrich(d: dict[str, Any]) -> dict[str, Any]:
    d["evidence"] = _loads(d.pop("evidence_json", None))
    emb_raw = d.pop("embedding_json", None)
    if emb_raw is None and "embedding_json" in d:
        emb_raw = d.get("embedding_json")
    vec = None
    if emb_raw:
        try:
            parsed = json.loads(emb_raw) if isinstance(emb_raw, str) else emb_raw
            if isinstance(parsed, list) and parsed:
                vec = [float(x) for x in parsed]
        except Exception:
            vec = None
    d["embedding"] = vec
    return d


def insert_person_memory(
    agent_code: str,
    content: str,
    *,
    layer: str = "journal",
    importance: float = 0.5,
    vitality: float = 1.0,
    round_id: str = "",
    source: str = "wrap_up",
    entry_id: str | None = None,
    status: str = "",
    kind: str = "",
    title: str = "",
    evidence: dict[str, Any] | None = None,
    hit_count: int = 0,
    skill_name: str = "",
    access_tier: str = "",
) -> str | None:
    code = str(agent_code or "").strip().lower()
    text = " ".join(str(content or "").strip().split())
    if not code or not text:
        return None
    layer_s = str(layer or "journal").strip().lower()
    if layer_s not in _VALID_LAYERS:
        layer_s = "journal"
    status_s = str(status or "").strip().lower()
    if status_s not in _VALID_STATUS:
        status_s = "proposed" if layer_s == "procedural" else ""
    if layer_s == "procedural" and not status_s:
        status_s = "proposed"
    kind_s = str(kind or "").strip().lower()
    if kind_s not in _VALID_KINDS:
        kind_s = "howto" if layer_s == "procedural" else ""
    if layer_s == "procedural" and not kind_s:
        kind_s = "howto"
    tier = str(access_tier or "").strip().lower()
    if tier not in _VALID_TIERS:
        if layer_s == "procedural" and (
            kind_s == "negative" or status_s == "graduated" or float(importance) >= 0.75
        ):
            tier = "core"
        elif layer_s == "semantic_self" and float(importance) >= 0.7:
            tier = "core"
        else:
            tier = "archival"
    eid = (entry_id or "").strip() or f"pm_{uuid.uuid4().hex[:16]}"
    imp = max(0.0, min(1.0, float(importance)))
    vit = max(0.0, min(1.0, float(vitality)))
    title_s = " ".join(str(title or "").strip().split())[:120]
    hits = max(0, int(hit_count or 0))
    skill = str(skill_name or "").strip()[:80]
    ev = dict(evidence or {})
    ev.setdefault("round_id", str(round_id or "")[:120])
    ev.setdefault("status", status_s)
    ev.setdefault("skill_name", skill)
    ev.setdefault("hit_count", hits)
    ev.setdefault("access_tier", tier)

    try:
        from evoflow.memory.facade import remember
        from evoflow.memory.migrate_legacy import ensure_legacy_migrated
        from evoflow.memory.namespaces import person_ns

        ensure_legacy_migrated()
        mem_layer = {
            "journal": "episodic",
            "episodic": "episodic",
            "semantic_self": "semantic",
            "procedural": "procedural",
        }.get(layer_s, "episodic")
        return remember(
            person_ns(code),
            text[:2000],
            layer=mem_layer,
            kind=kind_s or layer_s,
            summary=title_s,
            importance=imp,
            confidence=0.85,
            vitality=vit,
            subject_key=f"person:{eid}",
            atom_id=eid,
            source=str(source or "wrap_up")[:80],
            pin=(tier == "core"),
            evidence=ev,
            tags=[status_s, skill, layer_s],
        )
    except Exception:
        return None


def _atom_as_person_row(atom: dict[str, Any], *, agent_code: str) -> dict[str, Any]:
    ev = atom.get("evidence") if isinstance(atom.get("evidence"), dict) else {}
    tags = atom.get("tags") if isinstance(atom.get("tags"), list) else []
    layer_raw = str(atom.get("layer") or "episodic")
    kind = str(atom.get("kind") or "")
    # Restore journal/semantic_self labels when present in tags
    layer_out = layer_raw
    if "journal" in tags:
        layer_out = "journal"
    elif "semantic_self" in tags:
        layer_out = "semantic_self"
    elif layer_raw == "semantic":
        layer_out = "semantic_self"
    elif layer_raw == "episodic" and kind in {"", "episodic", "journal"}:
        layer_out = "journal" if "journal" in tags or kind == "journal" else "episodic"
    status = ""
    skill = ""
    for t in tags:
        ts = str(t or "")
        if ts in _VALID_STATUS:
            status = ts
        elif ts and ts not in _VALID_LAYERS and ts not in {"howto", "negative", "check"}:
            if not skill and len(ts) <= 80:
                skill = ts
    tier = str(ev.get("access_tier") or ("core" if atom.get("pin") else "archival"))
    return {
        "id": atom.get("id"),
        "agent_code": agent_code,
        "layer": layer_out,
        "content": atom.get("content") or "",
        "importance": float(atom.get("importance") or 0.5),
        "vitality": float(atom.get("vitality") or 1.0),
        "round_id": str(ev.get("round_id") or ""),
        "source": atom.get("source") or "",
        "created_at": atom.get("created_at") or "",
        "status": status or str(ev.get("status") or ""),
        "kind": kind,
        "title": atom.get("summary") or "",
        "evidence": ev,
        "evidence_json": _dumps(ev),
        "hit_count": int(ev.get("hit_count") or 0),
        "updated_at": atom.get("updated_at") or "",
        "skill_name": skill or str(ev.get("skill_name") or ""),
        "access_tier": tier,
        "embedding": atom.get("embedding_vec"),
    }


def list_person_memory(
    agent_code: str,
    *,
    limit: int = 20,
    layer: str | None = None,
) -> list[dict[str, Any]]:
    code = str(agent_code or "").strip().lower()
    if not code:
        return []
    lim = max(1, min(int(limit or 20), 200))
    try:
        from evoflow.memory.migrate_legacy import ensure_legacy_migrated
        from evoflow.memory.namespaces import person_ns
        from evoflow.memory.store import list_namespace_atoms

        ensure_legacy_migrated()
        layer_filter = None
        if layer:
            layer_s = str(layer).strip().lower()
            layer_filter = {
                "journal": ["episodic"],
                "episodic": ["episodic"],
                "semantic_self": ["semantic"],
                "procedural": ["procedural"],
            }.get(layer_s)
        atoms = list_namespace_atoms(
            person_ns(code),
            layers=layer_filter,
            limit=lim * 2,
        )
        rows = [_atom_as_person_row(a, agent_code=code) for a in atoms]
        if layer:
            layer_s = str(layer).strip().lower()
            rows = [r for r in rows if str(r.get("layer") or "") == layer_s]
        rows.sort(key=lambda r: str(r.get("created_at") or ""), reverse=True)
        return rows[:lim]
    except Exception:
        return []


def list_craft(
    agent_code: str,
    *,
    limit: int = 40,
    statuses: list[str] | None = None,
    kind: str | None = None,
) -> list[dict[str, Any]]:
    rows = list_person_memory(agent_code, limit=max(limit, 80), layer="procedural")
    want_st = {str(s).strip().lower() for s in (statuses or []) if str(s).strip()}
    kind_s = str(kind or "").strip().lower()
    out: list[dict[str, Any]] = []
    for r in rows:
        st = str(r.get("status") or "proposed").strip().lower() or "proposed"
        if want_st and st not in want_st:
            continue
        if kind_s and str(r.get("kind") or "").strip().lower() != kind_s:
            continue
        if st == "retired":
            if want_st and "retired" in want_st:
                out.append(r)
            continue
        out.append(r)
        if len(out) >= limit:
            break
    return out


def count_person_memory(agent_code: str) -> int:
    code = str(agent_code or "").strip().lower()
    if not code:
        return 0
    try:
        return len(list_person_memory(code, limit=500))
    except Exception:
        return 0


def count_craft(agent_code: str, *, status: str = "graduated") -> int:
    code = str(agent_code or "").strip().lower()
    if not code:
        return 0
    st = str(status or "").strip().lower()
    try:
        rows = list_craft(code, limit=200, statuses=[st] if st else None)
        return len(rows)
    except Exception:
        return 0


def update_craft_entry(
    entry_id: str,
    *,
    status: str | None = None,
    content: str | None = None,
    title: str | None = None,
    hit_count: int | None = None,
    evidence: dict[str, Any] | None = None,
    skill_name: str | None = None,
    importance: float | None = None,
    vitality: float | None = None,
    access_tier: str | None = None,
    layer: str | None = None,
) -> bool:
    eid = str(entry_id or "").strip()
    if not eid:
        return False
    try:
        from evoflow.memory import store as mem_store
        from evoflow.memory.facade import remember

        atom = mem_store.get_atom(eid)
        if not atom:
            return False
        ns = atom["namespace_id"]
        text = content if content is not None else str(atom.get("content") or "")
        text = " ".join(str(text).strip().split())[:2000]
        title_s = title if title is not None else str(atom.get("summary") or "")
        title_s = " ".join(str(title_s).strip().split())[:120]
        ev = dict(atom.get("evidence") or {})
        if evidence is not None:
            ev.update(evidence)
        if status is not None:
            st = str(status).strip().lower()
            if st not in _VALID_STATUS:
                return False
            ev["status"] = st
        if hit_count is not None:
            ev["hit_count"] = max(0, int(hit_count))
        if skill_name is not None:
            ev["skill_name"] = str(skill_name).strip()[:80]
        tier = access_tier
        if tier is not None:
            tier = str(tier).strip().lower()
            if tier not in _VALID_TIERS:
                return False
            ev["access_tier"] = tier
        pin = (ev.get("access_tier") == "core") if access_tier is not None else bool(atom.get("pin"))
        mem_layer = atom.get("layer") or "procedural"
        if layer is not None:
            ly = str(layer).strip().lower()
            if ly not in _VALID_LAYERS:
                return False
            mem_layer = {
                "journal": "episodic",
                "episodic": "episodic",
                "semantic_self": "semantic",
                "procedural": "procedural",
            }.get(ly, "procedural")
        tags = list(atom.get("tags") or [])
        if status is not None:
            tags = [t for t in tags if t not in _VALID_STATUS]
            tags.append(str(status).strip().lower())
        if skill_name is not None:
            tags = [t for t in tags if t != atom.get("skill_name")]
            tags.append(str(skill_name).strip()[:80])
        aid = remember(
            ns,
            text,
            layer=str(mem_layer),
            kind=str(atom.get("kind") or "howto"),
            summary=title_s,
            importance=float(importance) if importance is not None else float(atom.get("importance") or 0.5),
            confidence=float(atom.get("confidence") or 0.85),
            vitality=float(vitality) if vitality is not None else float(atom.get("vitality") or 1.0),
            subject_key=str(atom.get("subject_key") or f"person:{eid}"),
            atom_id=eid,
            source=str(atom.get("source") or "craft"),
            pin=pin,
            evidence=ev,
            tags=tags,
        )
        return bool(aid)
    except Exception:
        return False


def bump_craft_hit(entry_id: str, *, delta: int = 1) -> int:
    eid = str(entry_id or "").strip()
    if not eid:
        return 0
    try:
        from evoflow.memory import store as mem_store

        atom = mem_store.get_atom(eid)
        if not atom:
            return 0
        ev = dict(atom.get("evidence") or {})
        cur = int(ev.get("hit_count") or 0) + max(1, int(delta))
        update_craft_entry(eid, hit_count=cur, evidence=ev)
        return cur
    except Exception:
        return 0


def retrieve_person_memory_for_injection(
    agent_code: str,
    *,
    limit: int = 8,
) -> list[dict[str, Any]]:
    """Recent auto-bio entries (excludes procedural — use craft inject)."""
    rows = list_person_memory(agent_code, limit=max(limit * 3, 24))
    rows = [r for r in rows if str(r.get("layer") or "") != "procedural"]
    if not rows:
        return []

    def _score(r: dict[str, Any]) -> float:
        try:
            imp = float(r.get("importance") or 0.5)
            vit = float(r.get("vitality") or 1.0)
        except (TypeError, ValueError):
            imp, vit = 0.5, 1.0
        layer = str(r.get("layer") or "")
        boost = 0.05 if layer == "semantic_self" else 0.0
        return imp * vit + boost

    ranked = sorted(rows, key=_score, reverse=True)
    top = ranked[: max(1, min(limit, 20))]
    top.sort(key=lambda r: str(r.get("created_at") or ""))
    return top


def get_person_memory(entry_id: str) -> dict[str, Any] | None:
    eid = str(entry_id or "").strip()
    if not eid:
        return None
    try:
        from evoflow.memory import store as mem_store
        from evoflow.memory.namespaces import parse_namespace

        atom = mem_store.get_atom(eid)
        if not atom:
            return None
        _kind, owner = parse_namespace(str(atom.get("namespace_id") or ""))
        return _atom_as_person_row(atom, agent_code=owner)
    except Exception:
        return None


def list_core_memory(agent_code: str, *, limit: int = 12) -> list[dict[str, Any]]:
    """Entries marked core (or high-importance fallback)."""
    rows = list_person_memory(agent_code, limit=max(limit * 4, 40))
    core: list[dict[str, Any]] = []
    for r in rows:
        tier = str(r.get("access_tier") or "").strip().lower()
        layer = str(r.get("layer") or "")
        st = str(r.get("status") or "")
        kind = str(r.get("kind") or "")
        try:
            imp = float(r.get("importance") or 0.5)
        except (TypeError, ValueError):
            imp = 0.5
        if tier == "core":
            core.append(r)
        elif layer == "procedural" and (kind == "negative" or st == "graduated") and imp >= 0.6:
            core.append(r)
        elif layer == "semantic_self" and imp >= 0.7:
            core.append(r)
        if len(core) >= limit:
            break
    return core


def _tokenize(text: str) -> set[str]:
    import re

    raw = str(text or "").lower()
    tokens: set[str] = set()
    # Latin tokens
    for m in re.findall(r"[a-z0-9_]{3,}", raw):
        tokens.add(m)
    # CJK: collect overlapping bigrams/trigrams so short query terms hit
    chars = re.findall(r"[\u4e00-\u9fff]", raw)
    for n in (2, 3):
        for i in range(0, max(0, len(chars) - n + 1)):
            tokens.add("".join(chars[i : i + n]))
    return tokens


def _recency_score(iso_ts: str) -> float:
    """Exponential decay by Beijing days (half-life ~7d)."""
    from datetime import datetime

    from evoflow.timeutil import BEIJING_TZ

    raw = str(iso_ts or "").strip()
    if not raw:
        return 0.3
    try:
        ts = raw.replace("Z", "+00:00")
        dt = datetime.fromisoformat(ts)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=BEIJING_TZ)
        now = datetime.now(BEIJING_TZ)
        days = max(0.0, (now - dt.astimezone(BEIJING_TZ)).total_seconds() / 86400.0)
        return max(0.05, 0.5 ** (days / 7.0))
    except Exception:
        return 0.3


def _relevance_overlap(query: str, row: dict[str, Any]) -> float:
    q = _tokenize(query)
    if not q:
        return 0.0
    blob = f"{row.get('title') or ''} {row.get('content') or ''}"
    t = _tokenize(blob)
    if not t:
        return 0.0
    inter = len(q & t)
    return min(1.0, inter / max(1.0, min(len(q), 8.0)))


def _try_embed_sync(text: str) -> list[float] | None:
    """Best-effort sync embed via knowledge embedding stack; None if unavailable."""
    raw = " ".join(str(text or "").strip().split())
    if not raw:
        return None
    try:
        from evoflow.code_index.store import _embed_query_sync

        vec = _embed_query_sync(raw[:1200])
        if isinstance(vec, list) and vec:
            return [float(x) for x in vec]
    except Exception:
        return None
    return None


def _cosine(a: list[float] | None, b: list[float] | None) -> float | None:
    if not a or not b or len(a) != len(b):
        return None
    try:
        dot = 0.0
        na = 0.0
        nb = 0.0
        for x, y in zip(a, b):
            xf = float(x)
            yf = float(y)
            dot += xf * yf
            na += xf * xf
            nb += yf * yf
        if na <= 0 or nb <= 0:
            return None
        return max(0.0, min(1.0, dot / ((na**0.5) * (nb**0.5))))
    except Exception:
        return None


def _maybe_embed_and_store(entry_id: str, text: str) -> None:
    eid = str(entry_id or "").strip()
    if not eid:
        return
    vec = _try_embed_sync(text)
    if not vec:
        return
    now = utc_now_iso_z()
    blob = json.dumps(vec, separators=(",", ":"))

    def _write(db: Any) -> None:
        try:
            db.execute(
                "UPDATE evoflow_person_memory_entries SET embedding_json=?, updated_at=? WHERE id=?",
                (blob, now, eid),
            )
        except Exception:
            pass

    try:
        run_db_transaction(_write)
    except Exception:
        pass


def _row_embedding(row: dict[str, Any]) -> list[float] | None:
    emb = row.get("embedding")
    if isinstance(emb, list) and emb:
        try:
            return [float(x) for x in emb]
        except Exception:
            return None
    return None


def retrieve_for_query(
    agent_code: str,
    query: str,
    *,
    limit: int = 8,
    include_procedural: bool = True,
    bump_hits: bool = True,
) -> list[dict[str, Any]]:
    """Three-axis retrieval: recency × importance × relevance.

    Relevance = blend of embedding cosine (if available) + word overlap.
    Falls back to overlap-only when embeddings are missing.
    """
    code = str(agent_code or "").strip().lower()
    q = str(query or "").strip()
    if not code or not q:
        return []
    rows = list_person_memory(code, limit=120)
    if not include_procedural:
        rows = [r for r in rows if str(r.get("layer") or "") != "procedural"]
    else:
        rows = [r for r in rows if str(r.get("status") or "") != "retired"]
    q_vec = _try_embed_sync(q)
    alpha, beta, gamma = 0.3, 0.3, 0.4
    scored: list[tuple[float, dict[str, Any]]] = []
    for r in rows:
        try:
            imp = float(r.get("importance") or 0.5)
        except (TypeError, ValueError):
            imp = 0.5
        if str(r.get("kind") or "") == "negative":
            imp = min(1.0, imp + 0.1)
        if str(r.get("status") or "") == "graduated":
            imp = min(1.0, imp + 0.05)
        rec = _recency_score(str(r.get("updated_at") or r.get("created_at") or ""))
        overlap = _relevance_overlap(q, r)
        cos = _cosine(q_vec, _row_embedding(r)) if q_vec else None
        if cos is not None:
            rel = 0.6 * float(cos) + 0.4 * float(overlap)
        else:
            rel = float(overlap)
        if rel <= 0 and str(r.get("access_tier") or "") != "core":
            continue
        score = alpha * rec + beta * imp + gamma * rel
        scored.append((score, r))
    scored.sort(key=lambda x: x[0], reverse=True)
    top = [r for _, r in scored[: max(1, min(limit, 20))]]
    if bump_hits:
        for r in top:
            if _relevance_overlap(q, r) > 0 or (_cosine(q_vec, _row_embedding(r)) or 0) > 0.35:
                try:
                    bump_craft_hit(str(r.get("id") or ""))
                except Exception:
                    pass
    return top
