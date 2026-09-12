"""SQLite CRUD for ``evoflow_artifacts`` (session-bound, append/upsert)."""

from __future__ import annotations

import json
from typing import Any

from evoflow.artifacts.chat_artifact import (
    artifact_state_key,
    normalize_chat_artifacts,
)
from evoflow.persistence.db import get_db
from evoflow.timeutil import utc_now_iso_z


def _dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def upsert_artifacts(
    session_key: str,
    thread_id: str,
    artifacts: list[dict[str, Any]] | list[Any],
) -> list[dict[str, Any]]:
    """Append or update typed artifacts for a session/thread. Returns normalized rows."""
    sk = str(session_key or "").strip()
    tid = str(thread_id or "").strip() or sk
    if not sk:
        return []
    items = normalize_chat_artifacts(artifacts)
    if not items:
        return []
    now = utc_now_iso_z()
    db = get_db()
    saved: list[dict[str, Any]] = []
    for item in items:
        aid = str(item["id"])
        existing = db.execute(
            """
            SELECT artifact_id, created_at, status FROM evoflow_artifacts
            WHERE session_key = ? AND thread_id = ? AND artifact_id = ?
            """,
            (sk, tid, aid),
        ).fetchone()
        status = "updated" if existing else "new"
        created_at = now
        if existing:
            try:
                created_at = str(existing["created_at"] or existing[1] or now)
            except Exception:
                created_at = now
        path = str(item.get("path") or "")
        url = str(item.get("url") or "")
        name = str(item.get("name") or "")
        type_ = str(item.get("type") or "file")
        mime = str(item.get("mime") or "")
        label = str(item.get("label") or "")
        size = item.get("size")
        content = item.get("content")
        meta = {k: v for k, v in item.items() if k not in {
            "id", "type", "path", "url", "name", "mime", "label", "size", "content", "status",
        }}
        db.execute(
            """
            INSERT INTO evoflow_artifacts (
                session_key, thread_id, artifact_id, path, name, updated_at,
                type, url, mime, label, size, content, status, created_at, meta_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_key, thread_id, artifact_id) DO UPDATE SET
                path = excluded.path,
                name = excluded.name,
                updated_at = excluded.updated_at,
                type = excluded.type,
                url = excluded.url,
                mime = excluded.mime,
                label = excluded.label,
                size = excluded.size,
                content = excluded.content,
                status = excluded.status,
                meta_json = excluded.meta_json
            """,
            (
                sk,
                tid,
                aid,
                path,
                name,
                now,
                type_,
                url,
                mime,
                label,
                size,
                content if isinstance(content, str) else None,
                status,
                created_at,
                _dumps(meta),
            ),
        )
        row = {
            **item,
            "status": status,
            "createdAt": created_at,
            "updatedAt": now,
            "sessionKey": sk,
            "threadId": tid,
        }
        saved.append(row)
    db.commit()
    return saved


def list_session_artifacts(
    session_key: str,
    *,
    thread_id: str | None = None,
    limit: int = 200,
) -> list[dict[str, Any]]:
    """List artifacts for a session (append order by created_at, then updated_at)."""
    sk = str(session_key or "").strip()
    if not sk:
        return []
    lim = max(1, min(int(limit or 200), 500))
    db = get_db()
    tid = str(thread_id or "").strip()
    if tid:
        rows = db.execute(
            """
            SELECT artifact_id, path, name, updated_at, type, url, mime, label, size,
                   content, status, created_at, meta_json, thread_id
            FROM evoflow_artifacts
            WHERE session_key = ? AND thread_id = ?
            ORDER BY COALESCE(created_at, updated_at) ASC, updated_at ASC
            LIMIT ?
            """,
            (sk, tid, lim),
        ).fetchall()
    else:
        # Session-wide: dedupe by artifact_id keeping latest thread row
        rows = db.execute(
            """
            SELECT artifact_id, path, name, updated_at, type, url, mime, label, size,
                   content, status, created_at, meta_json, thread_id
            FROM evoflow_artifacts
            WHERE session_key = ?
            ORDER BY COALESCE(created_at, updated_at) ASC, updated_at ASC
            LIMIT ?
            """,
            (sk, lim),
        ).fetchall()
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for r in rows:
        try:
            aid = str(r["artifact_id"] if hasattr(r, "keys") else r[0] or "")
        except Exception:
            aid = str(r[0] or "")
        if not aid or aid in seen:
            continue
        seen.add(aid)
        def _g(key: str, idx: int, default: Any = "") -> Any:
            try:
                if hasattr(r, "keys"):
                    return r[key]
                return r[idx]
            except Exception:
                return default

        item = {
            "id": aid,
            "type": str(_g("type", 4, "file") or "file"),
            "path": str(_g("path", 1, "") or ""),
            "url": str(_g("url", 5, "") or ""),
            "name": str(_g("name", 2, "") or ""),
            "mime": str(_g("mime", 6, "") or ""),
            "label": str(_g("label", 7, "") or ""),
            "status": str(_g("status", 10, "new") or "new"),
            "createdAt": str(_g("created_at", 11, "") or ""),
            "updatedAt": str(_g("updated_at", 3, "") or ""),
            "threadId": str(_g("thread_id", 13, "") or ""),
        }
        size = _g("size", 8, None)
        if size is not None:
            try:
                item["size"] = int(size)
            except (TypeError, ValueError):
                pass
        content = _g("content", 9, None)
        if isinstance(content, str) and content:
            item["content"] = content
        meta_raw = _g("meta_json", 12, None)
        if meta_raw:
            try:
                meta = json.loads(meta_raw) if isinstance(meta_raw, str) else meta_raw
            except Exception:
                meta = None
            if isinstance(meta, dict):
                for key, value in meta.items():
                    if key in item or value in ("", None):
                        continue
                    item[key] = value
        # Drop empty optional fields for a cleaner wire payload
        out.append({k: v for k, v in item.items() if v not in ("", None)})
    return out


def save_artifacts(
    session_key: str,
    thread_id: str,
    artifacts: list[str] | list[Any],
) -> None:
    """Legacy entry: upsert path/string keys without wiping prior typed rows."""
    sk = str(session_key or "").strip()
    tid = str(thread_id or "").strip()
    if not sk or not tid:
        return
    items: list[Any] = []
    for art in artifacts or []:
        if isinstance(art, str) and art.strip():
            items.append({"type": "file", "path": art.strip()})
        elif isinstance(art, dict):
            items.append(art)
    if items:
        upsert_artifacts(sk, tid, items)


def load_artifacts(session_key: str, thread_id: str) -> list[str]:
    """Legacy: load path/url/id keys for a session/thread pair."""
    rows = list_session_artifacts(session_key, thread_id=thread_id)
    keys: list[str] = []
    for row in rows:
        k = artifact_state_key(row) or str(row.get("id") or "")
        if k:
            keys.append(k)
    return keys


def delete_artifacts(session_key: str, thread_id: str) -> None:
    """Remove artifacts for a session/thread pair."""
    sk = str(session_key or "").strip()
    tid = str(thread_id or "").strip()
    if not sk or not tid:
        return
    get_db().execute(
        "DELETE FROM evoflow_artifacts WHERE session_key = ? AND thread_id = ?",
        (sk, tid),
    )
    get_db().commit()
