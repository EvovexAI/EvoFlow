"""Persist media tool outputs (task ids, remote URLs, local paths) in ``evoflow_media_assets``."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from evoflow.persistence.db import get_db
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

MediaKind = str  # image | video | audio | subtitle | document | other
MediaStatus = str  # processing | succeeded | failed


def _json_dumps(obj: dict[str, Any]) -> str:
    return json.dumps(obj or {}, ensure_ascii=False)


def _json_loads(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _file_size_for_local_path(local_path: str | None) -> int | None:
    if not local_path:
        return None
    rel = str(local_path).strip().replace("\\", "/")
    if not rel:
        return None
    # Absolute paths only when resolvable on host; relative paths skipped here.
    try:
        p = Path(rel)
        if p.is_file():
            return p.stat().st_size
    except OSError:
        pass
    return None


def record_media_asset(
    *,
    thread_id: str | None,
    tool_name: str,
    media_kind: MediaKind,
    provider: str | None = None,
    task_id: str | None = None,
    status: MediaStatus = "processing",
    remote_url: str | None = None,
    local_path: str | None = None,
    file_size_bytes: int | None = None,
    meta: dict[str, Any] | None = None,
) -> int | None:
    """Insert a media asset row. Returns row id or None on failure."""
    now = utc_now_iso_z()
    size = file_size_bytes if file_size_bytes is not None else _file_size_for_local_path(local_path)
    try:
        cur = get_db().execute(
            """
            INSERT INTO evoflow_media_assets (
                thread_id, tool_name, media_kind, provider, task_id, status,
                remote_url, local_path, file_size_bytes, meta_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                (thread_id or "").strip() or None,
                str(tool_name or "").strip() or "unknown",
                str(media_kind or "other").strip() or "other",
                (provider or "").strip() or None,
                (task_id or "").strip() or None,
                str(status or "processing").strip() or "processing",
                (remote_url or "").strip() or None,
                (local_path or "").strip() or None,
                size,
                _json_dumps(meta or {}),
                now,
                now,
            ),
        )
        get_db().commit()
        return int(cur.lastrowid) if cur.lastrowid is not None else None
    except Exception:
        logger.debug("record_media_asset failed", exc_info=True)
        return None


def update_media_asset_by_task(
    *,
    provider: str,
    task_id: str,
    status: MediaStatus,
    remote_url: str | None = None,
    local_path: str | None = None,
    file_size_bytes: int | None = None,
    meta_patch: dict[str, Any] | None = None,
) -> bool:
    """Update the latest row matching provider+task_id."""
    prov = (provider or "").strip()
    tid = (task_id or "").strip()
    if not prov or not tid:
        return False
    now = utc_now_iso_z()
    try:
        row = get_db().execute(
            """
            SELECT id, meta_json FROM evoflow_media_assets
            WHERE provider = ? AND task_id = ?
            ORDER BY id DESC LIMIT 1
            """,
            (prov, tid),
        ).fetchone()
        if not row:
            return False
        rid = int(row[0])
        meta = _json_loads(row[1])
        if meta_patch:
            meta.update(meta_patch)
        size = file_size_bytes if file_size_bytes is not None else _file_size_for_local_path(local_path)
        get_db().execute(
            """
            UPDATE evoflow_media_assets SET
                status = ?,
                remote_url = COALESCE(?, remote_url),
                local_path = COALESCE(?, local_path),
                file_size_bytes = COALESCE(?, file_size_bytes),
                meta_json = ?,
                updated_at = ?
            WHERE id = ?
            """,
            (
                status,
                (remote_url or "").strip() or None,
                (local_path or "").strip() or None,
                size,
                _json_dumps(meta),
                now,
                rid,
            ),
        )
        get_db().commit()
        return True
    except Exception:
        logger.debug("update_media_asset_by_task failed", exc_info=True)
        return False


def list_media_assets(
    *,
    thread_id: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> list[dict[str, Any]]:
    """List assets newest first, optionally filtered by thread_id."""
    lim = max(1, min(int(limit), 500))
    off = max(0, int(offset))
    try:
        if thread_id and str(thread_id).strip():
            rows = get_db().execute(
                """
                SELECT id, thread_id, tool_name, media_kind, provider, task_id, status,
                       remote_url, local_path, file_size_bytes, meta_json, created_at, updated_at
                FROM evoflow_media_assets
                WHERE thread_id = ?
                ORDER BY id DESC
                LIMIT ? OFFSET ?
                """,
                (str(thread_id).strip(), lim, off),
            ).fetchall()
        else:
            rows = get_db().execute(
                """
                SELECT id, thread_id, tool_name, media_kind, provider, task_id, status,
                       remote_url, local_path, file_size_bytes, meta_json, created_at, updated_at
                FROM evoflow_media_assets
                ORDER BY id DESC
                LIMIT ? OFFSET ?
                """,
                (lim, off),
            ).fetchall()
    except Exception:
        logger.debug("list_media_assets failed", exc_info=True)
        return []

    out: list[dict[str, Any]] = []
    for r in rows:
        out.append(
            {
                "id": r[0],
                "thread_id": r[1],
                "tool_name": r[2],
                "media_kind": r[3],
                "provider": r[4],
                "task_id": r[5],
                "status": r[6],
                "remote_url": r[7],
                "local_path": r[8],
                "file_size_bytes": r[9],
                "meta": _json_loads(r[10]),
                "created_at": r[11],
                "updated_at": r[12],
            }
        )
    return out


def find_remote_url_for_local_path(
    *,
    thread_id: str,
    path_keys: set[str],
    media_kind: str | None = None,
) -> str | None:
    """Find https remote URL for a local outputs path from ``evoflow_media_assets``."""
    tid = (thread_id or "").strip()
    if not tid or not path_keys:
        return None
    keys = {str(k).replace("\\", "/").strip().lower() for k in path_keys if k}
    keys |= {Path(k).name.lower() for k in keys if k}

    def _matches(stored: str | None) -> bool:
        if not stored:
            return False
        norm = str(stored).replace("\\", "/").strip().lower()
        if norm in keys:
            return True
        name = Path(norm).name.lower()
        return bool(name and name in keys)

    def _pick_url(remote: str | None, meta: dict[str, Any]) -> str | None:
        r = (remote or "").strip()
        if r.startswith(("http://", "https://", "oss://")):
            return r
        for u in meta.get("urls") or []:
            us = str(u or "").strip()
            if us.startswith(("http://", "https://", "oss://")):
                return us
        u0 = meta.get("absolute_path")
        if isinstance(u0, str) and u0.startswith(("http://", "https://", "oss://")):
            return u0
        return None

    try:
        params: list[Any] = [tid]
        kind_clause = ""
        if media_kind:
            kind_clause = " AND media_kind = ?"
            params.append(str(media_kind).strip())
        params.append(500)
        rows = get_db().execute(
            f"""
            SELECT remote_url, local_path, meta_json, media_kind
            FROM evoflow_media_assets
            WHERE thread_id = ?{kind_clause}
            ORDER BY id DESC
            LIMIT ?
            """,
            tuple(params),
        ).fetchall()
    except Exception:
        logger.debug("find_remote_url_for_local_path failed", exc_info=True)
        return None

    for remote_url, local_path, meta_json, _kind in rows:
        meta = _json_loads(meta_json)
        if _matches(local_path):
            picked = _pick_url(remote_url, meta)
            if picked:
                return picked
        ap = meta.get("absolute_path")
        if _matches(str(ap or "")):
            picked = _pick_url(remote_url, meta)
            if picked:
                return picked
    return None
