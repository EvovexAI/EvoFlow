"""Experience library admin — craft SKILL.md primary, SQLite legacy fallback."""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any

from evoflow.admin.errors import NotFoundError, ValidationError
from evoflow.persistence import get_db
from evoflow.persistence.schema import ensure_app_schema
from evoflow.persistence.timestamps import now_iso_z

logger = logging.getLogger(__name__)

_DEFAULT_CATEGORY = "general"
_MAX_CONTEXT_CHARS = 2000
_MAX_STEPS = 20


def _db():
    db = get_db()
    ensure_app_schema(db)
    return db


def _json_or_raw(value: Any) -> Any:
    if isinstance(value, str) and value.startswith(("[", "{")):
        try:
            return json.loads(value)
        except (json.JSONDecodeError, TypeError):
            pass
    return value


def _ensure_list(value: Any, default: Any = None) -> list:
    if value is None:
        return default if default is not None else []
    parsed = _json_or_raw(value)
    if isinstance(parsed, list):
        return parsed
    if isinstance(parsed, str):
        return [parsed]
    return []


def _row_to_dict(row) -> dict[str, Any]:
    if row is None:
        raise NotFoundError("Experience not found")
    out = {
        "id": row[0],
        "title": row[1],
        "category": row[2],
        "tags": json.loads(row[3]) if row[3] else [],
        "context": json.loads(row[4]) if row[4] else {},
        "steps": json.loads(row[5]) if row[5] else [],
        "source_sessions": json.loads(row[6]) if row[6] else [],
        "related_ids": json.loads(row[7]) if row[7] else [],
        "confidence": row[8],
        "use_count": row[9],
        "superseded_by": row[10],
        "deprecated": bool(row[11]),
        "created_at": row[12],
        "updated_at": row[13],
        "last_used_at": row[14],
        "storage": "sqlite",
    }
    return out


def _summary_row(r, *, storage: str = "sqlite") -> dict[str, Any]:
    context = json.loads(r[4]) if r[4] else {}
    steps = json.loads(r[9]) if len(r) > 9 and r[9] else []
    return {
        "id": r[0],
        "title": r[1],
        "category": r[2],
        "tags": json.loads(r[3]) if r[3] else [],
        "problem": (context.get("problem") or "")[:200],
        "solution": (context.get("solution") or "")[:200],
        "outcome": (context.get("outcome") or "")[:100],
        "step_count": len(steps),
        "confidence": r[5],
        "use_count": r[6],
        "created_at": r[7],
        "last_used_at": r[8],
        "storage": storage,
    }


def _craft_summary(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row.get("id"),
        "title": row.get("title"),
        "category": row.get("category"),
        "tags": row.get("tags") or [],
        "problem": row.get("problem") or "",
        "solution": row.get("solution") or "",
        "outcome": row.get("outcome") or "",
        "step_count": row.get("step_count") or 0,
        "confidence": row.get("confidence"),
        "use_count": row.get("use_count") or 0,
        "created_at": "",
        "last_used_at": "",
        "storage": "craft",
        "path": row.get("path"),
    }


def list_experiences(
    *,
    category: str = "",
    tags: list[str] | str | None = None,
    query: str = "",
    max_results: int = 10,
    principal_id: str = "",
) -> dict[str, Any]:
    from evoflow.assets.craft import list_craft_experiences

    max_results = min(max(1, max_results), 30)
    # Authenticated callers see their personal bucket first, then the shared
    # legacy bucket (so old shared experiences remain discoverable).
    craft_hits: list[dict[str, Any]] = []
    seen_paths: set[str] = set()
    pid = str(principal_id or "").strip()
    if pid:
        from evoflow.assets.paths import EntityRef, sanitize_user_asset_id

        personal = list_craft_experiences(
            category=category,
            query=query,
            max_results=max_results,
            entity=EntityRef("user", sanitize_user_asset_id(pid)),
        )
        for hit in personal:
            craft_hits.append(hit)
            seen_paths.add(str(hit.get("path") or ""))
    for hit in list_craft_experiences(category=category, query=query, max_results=max_results):
        p = str(hit.get("path") or "")
        if p and p in seen_paths:
            continue
        craft_hits.append(hit)
        seen_paths.add(p)
    experiences = [_craft_summary(h) for h in craft_hits]
    seen = {str(e.get("id") or "") for e in experiences}

    if len(experiences) < max_results:
        parsed_tags = _ensure_list(tags)
        db = _db()
        conditions = ["deprecated = 0"]
        params: list[Any] = []
        if category:
            conditions.append("category LIKE ?")
            params.append(f"{category}%")
        for tag in parsed_tags:
            conditions.append("tags_json LIKE ?")
            params.append(f"%{tag}%")
        if query:
            like = f"%{query}%"
            conditions.append("(title LIKE ? OR context_json LIKE ?)")
            params.extend([like, like])
        where = " AND ".join(conditions)
        rows = db.execute(
            f"""SELECT id, title, category, tags_json, context_json,
                       confidence, use_count, created_at, last_used_at, steps_json
                FROM evoflow_experience_entries
                WHERE {where}
                ORDER BY confidence DESC, use_count DESC, last_used_at DESC
                LIMIT ?""",
            (*params, max_results * 2),
        ).fetchall()
        for r in rows:
            if str(r[0]) in seen:
                continue
            experiences.append(_summary_row(r))
            seen.add(str(r[0]))
            if len(experiences) >= max_results:
                break

    return {
        "total": len(experiences),
        "category_filter": category,
        "query_filter": query,
        "experiences": experiences[:max_results],
    }


def get_experience(experience_id: str) -> dict[str, Any]:
    from evoflow.assets.craft import get_craft_experience

    craft = get_craft_experience(experience_id)
    if craft is not None:
        return craft
    db = _db()
    row = db.execute(
        "SELECT * FROM evoflow_experience_entries WHERE id = ? AND deprecated = 0",
        (experience_id,),
    ).fetchone()
    if row is None:
        raise NotFoundError(f"Experience '{experience_id}' not found")
    return _row_to_dict(row)


def save_experience(data: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ValidationError("Experience payload must be a JSON object")
    title = str(data.get("title") or "").strip()
    if not title:
        raise ValidationError("title is required")

    from evoflow.assets.craft import save_craft_from_experience

    payload = dict(data)
    if isinstance(data.get("context"), dict):
        ctx = data["context"]
        payload.setdefault("problem", ctx.get("problem"))
        payload.setdefault("solution", ctx.get("solution"))
        payload.setdefault("outcome", ctx.get("outcome"))
        payload.setdefault("applicable_to", ctx.get("applicable_to"))
    payload["origin"] = payload.get("origin") or "distilled"
    # Multi-user isolation: authenticated callers persist into their personal
    # bucket ``assets/users/<id>/craft`` (the same bucket the Asset Center reads).
    # Unauthenticated/local legacy callers keep the shared ``assets/user`` bucket.
    pid = str(payload.get("principal_id") or "").strip()
    if pid and not str(payload.get("entity_type") or "").strip():
        from evoflow.assets.paths import sanitize_user_asset_id

        payload["entity_type"] = "user"
        payload["entity_id"] = sanitize_user_asset_id(pid)
    payload.pop("principal_id", None)
    try:
        return save_craft_from_experience(payload)
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc


def update_experience(experience_id: str, data: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ValidationError("Experience payload must be a JSON object")
    from evoflow.assets.craft import get_craft_experience, save_craft_from_experience

    existing_craft = get_craft_experience(experience_id)
    if existing_craft is not None:
        merged = dict(existing_craft)
        ctx = dict(merged.get("context") or {})
        if "title" in data and data["title"] is not None:
            merged["title"] = str(data["title"])
        if "category" in data and data["category"] is not None:
            merged["category"] = str(data["category"])
        if "tags" in data:
            merged["tags"] = _ensure_list(data["tags"])
        for key in ("problem", "solution", "outcome", "applicable_to"):
            if key in data and data[key] is not None:
                ctx[key] = str(data[key])
        if isinstance(data.get("context"), dict):
            ctx.update(data["context"])
        merged["context"] = ctx
        if "steps" in data:
            merged["steps"] = _ensure_list(data["steps"])[:_MAX_STEPS]
        elif "append_steps" in data:
            merged["steps"] = list(merged.get("steps") or []) + _ensure_list(data["append_steps"])
            merged["steps"] = merged["steps"][:_MAX_STEPS]
        merged["id"] = experience_id
        return save_craft_from_experience(merged)

    db = _db()
    row = db.execute(
        "SELECT * FROM evoflow_experience_entries WHERE id = ? AND deprecated = 0",
        (experience_id,),
    ).fetchone()
    if row is None:
        raise NotFoundError(f"Experience '{experience_id}' not found")
    existing = _row_to_dict(row)
    now_str = now_iso_z()
    updates: dict[str, Any] = {"updated_at": now_str}
    json_fields: dict[str, Any] = {}
    if "title" in data and data["title"] is not None:
        updates["title"] = str(data["title"])
    if "category" in data and data["category"] is not None:
        updates["category"] = str(data["category"])
    if "tags" in data:
        json_fields["tags_json"] = _ensure_list(data["tags"])
    ctx = dict(existing["context"])
    for key in ("problem", "solution", "outcome", "applicable_to"):
        if key in data and data[key] is not None:
            limit = 2000 if key in ("problem", "solution") else 1000
            ctx[key] = str(data[key])[:limit]
    if any(k in data for k in ("problem", "solution", "outcome", "applicable_to", "context")):
        if isinstance(data.get("context"), dict):
            ctx.update(data["context"])
        json_fields["context_json"] = ctx
    if "steps" in data:
        json_fields["steps_json"] = _ensure_list(data["steps"])[:_MAX_STEPS]
    if "append_steps" in data:
        merged = list(existing["steps"])
        merged.extend(_ensure_list(data["append_steps"]))
        json_fields["steps_json"] = merged[:_MAX_STEPS]
    if "source_sessions" in data:
        merged_src = list(set(existing["source_sessions"] + _ensure_list(data["source_sessions"])))
        json_fields["source_sessions_json"] = merged_src
    set_parts = []
    set_params: list[Any] = []
    for k, v in updates.items():
        set_parts.append(f"{k} = ?")
        set_params.append(v)
    for k, v in json_fields.items():
        set_parts.append(f"{k} = ?")
        set_params.append(json.dumps(v, ensure_ascii=False))
    set_params.append(experience_id)
    db.execute(
        f"UPDATE evoflow_experience_entries SET {', '.join(set_parts)} WHERE id = ?",
        set_params,
    )
    db.commit()
    return {"success": True, "id": experience_id, "storage": "sqlite"}


def mark_experience_used(experience_id: str) -> dict[str, Any]:
    from evoflow.assets.craft import get_craft_experience

    if get_craft_experience(experience_id) is not None:
        return {"success": True, "id": experience_id, "storage": "craft"}
    db = _db()
    now_str = now_iso_z()
    cur = db.execute(
        """UPDATE evoflow_experience_entries
           SET use_count = use_count + 1, last_used_at = ?, updated_at = ?
           WHERE id = ? AND deprecated = 0""",
        (now_str, now_str, experience_id),
    )
    db.commit()
    if cur.rowcount == 0:
        raise NotFoundError(f"Experience '{experience_id}' not found")
    return {"success": True, "id": experience_id, "storage": "sqlite"}


def delete_experience(experience_id: str, *, permanent: bool = False) -> dict[str, Any]:
    from evoflow.assets.craft import delete_craft_experience, get_craft_experience

    if get_craft_experience(experience_id) is not None:
        delete_craft_experience(experience_id)
        return {"success": True, "id": experience_id, "action": "deleted", "storage": "craft"}
    db = _db()
    now_str = now_iso_z()
    if permanent:
        cur = db.execute("DELETE FROM evoflow_experience_entries WHERE id = ?", (experience_id,))
        action = "permanently deleted"
    else:
        cur = db.execute(
            "UPDATE evoflow_experience_entries SET deprecated = 1, updated_at = ? WHERE id = ?",
            (now_str, experience_id),
        )
        action = "deprecated"
    db.commit()
    if cur.rowcount == 0:
        raise NotFoundError(f"Experience '{experience_id}' not found")
    return {"success": True, "id": experience_id, "action": action, "storage": "sqlite"}


def migrate_sqlite_experiences_to_craft(*, dry_run: bool = False) -> dict[str, Any]:
    """Copy legacy SQLite experience rows into ``craft/*/SKILL.md``."""
    from evoflow.assets.craft import get_craft_experience, save_craft_from_experience

    db = _db()
    rows = db.execute(
        "SELECT * FROM evoflow_experience_entries WHERE deprecated = 0 ORDER BY created_at"
    ).fetchall()
    migrated = 0
    skipped = 0
    errors: list[str] = []
    for row in rows:
        data = _row_to_dict(row)
        eid = str(data.get("id") or "")
        if not eid:
            continue
        if get_craft_experience(eid) is not None:
            skipped += 1
            continue
        if dry_run:
            migrated += 1
            continue
        try:
            payload = {
                **data,
                "origin": "migrated_experience",
                "problem": (data.get("context") or {}).get("problem"),
                "solution": (data.get("context") or {}).get("solution"),
                "outcome": (data.get("context") or {}).get("outcome"),
                "applicable_to": (data.get("context") or {}).get("applicable_to"),
            }
            save_craft_from_experience(payload)
            migrated += 1
        except Exception as exc:
            errors.append(f"{eid}: {exc}")
    return {
        "ok": not errors,
        "dry_run": dry_run,
        "total": len(rows),
        "migrated": migrated,
        "skipped": skipped,
        "errors": errors,
    }
