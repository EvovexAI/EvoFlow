"""Persist media tool outputs (task ids, remote URLs, local paths) in ``evoflow_media_assets``.

This is the **call / artifact ledger** for image & video generation:
  - ``status``: processing | succeeded | failed
  - ``remote_url``: vendor CDN / http(s) when available
  - ``local_path``: durable local file under EVOFLOW outputs
  - ``result_url``: **canonical address** — prefer http(s) ``remote_url``, else ``local_path``
  - ``model``: model id used for the call (queryable, not only in meta_json)

Cost / metering lives in ``evoflow_usage_events`` (category=media); join via ``task_id``.
"""

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
    try:
        p = Path(rel)
        if p.is_file():
            return p.stat().st_size
    except OSError:
        pass
    return None


def canonical_result_url(
    remote_url: str | None = None,
    local_path: str | None = None,
    *,
    explicit: str | None = None,
) -> str | None:
    """Pick the address clients should use to open the media.

    Priority: explicit → http(s) remote → local_path → any non-empty remote.
    """
    ex = (explicit or "").strip()
    if ex:
        return ex
    remote = (remote_url or "").strip()
    local = (local_path or "").strip()
    low = remote.lower()
    if low.startswith("http://") or low.startswith("https://"):
        return remote
    if local:
        return local
    return remote or None


def _row_to_dict(r: Any) -> dict[str, Any]:
    """Map a SELECT row (14 cols with model/result_url) to API dict."""
    # Support both old 13-col and new 15-col shapes during rollout.
    n = len(r)
    if n >= 15:
        remote = r[8]
        local = r[9]
        result = r[10]
        return {
            "id": r[0],
            "thread_id": r[1],
            "tool_name": r[2],
            "media_kind": r[3],
            "provider": r[4],
            "model": r[5],
            "task_id": r[6],
            "status": r[7],
            "remote_url": remote,
            "local_path": local,
            "result_url": result or canonical_result_url(remote, local),
            "file_size_bytes": r[11],
            "meta": _json_loads(r[12]),
            "created_at": r[13],
            "updated_at": r[14],
        }
    # Legacy without model/result_url
    remote = r[7]
    local = r[8]
    return {
        "id": r[0],
        "thread_id": r[1],
        "tool_name": r[2],
        "media_kind": r[3],
        "provider": r[4],
        "model": None,
        "task_id": r[5],
        "status": r[6],
        "remote_url": remote,
        "local_path": local,
        "result_url": canonical_result_url(remote, local),
        "file_size_bytes": r[9],
        "meta": _json_loads(r[10]),
        "created_at": r[11],
        "updated_at": r[12],
    }


_SELECT_COLS = (
    "id, thread_id, tool_name, media_kind, provider, model, task_id, status, "
    "remote_url, local_path, result_url, file_size_bytes, meta_json, created_at, updated_at"
)


def record_media_asset(
    *,
    thread_id: str | None,
    tool_name: str,
    media_kind: MediaKind,
    provider: str | None = None,
    model: str | None = None,
    task_id: str | None = None,
    status: MediaStatus = "processing",
    remote_url: str | None = None,
    local_path: str | None = None,
    result_url: str | None = None,
    file_size_bytes: int | None = None,
    meta: dict[str, Any] | None = None,
) -> int | None:
    """Insert a media asset / call row. Returns row id or None on failure."""
    now = utc_now_iso_z()
    size = file_size_bytes if file_size_bytes is not None else _file_size_for_local_path(local_path)
    remote = (remote_url or "").strip() or None
    local = (local_path or "").strip() or None
    result = canonical_result_url(remote, local, explicit=result_url)
    model_s = (model or "").strip() or None
    if model_s is None and isinstance(meta, dict):
        model_s = str(meta.get("model") or meta.get("model_id") or "").strip() or None
    try:
        cur = get_db().execute(
            """
            INSERT INTO evoflow_media_assets (
                thread_id, tool_name, media_kind, provider, model, task_id, status,
                remote_url, local_path, result_url, file_size_bytes, meta_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                (thread_id or "").strip() or None,
                str(tool_name or "").strip() or "unknown",
                str(media_kind or "other").strip() or "other",
                (provider or "").strip() or None,
                model_s,
                (task_id or "").strip() or None,
                str(status or "processing").strip() or "processing",
                remote,
                local,
                result,
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


def get_media_asset_by_task(*, provider: str, task_id: str) -> dict[str, Any] | None:
    """Latest asset row for provider+task_id, or None."""
    prov = (provider or "").strip()
    tid = (task_id or "").strip()
    if not prov or not tid:
        return None
    try:
        row = (
            get_db()
            .execute(
                f"""
            SELECT {_SELECT_COLS}
            FROM evoflow_media_assets
            WHERE provider = ? AND task_id = ?
            ORDER BY id DESC LIMIT 1
            """,
                (prov, tid),
            )
            .fetchone()
        )
    except Exception:
        logger.debug("get_media_asset_by_task failed", exc_info=True)
        return None
    if not row:
        return None
    return _row_to_dict(row)


def update_media_asset_by_task(
    *,
    provider: str,
    task_id: str,
    status: MediaStatus,
    remote_url: str | None = None,
    local_path: str | None = None,
    result_url: str | None = None,
    model: str | None = None,
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
        row = (
            get_db()
            .execute(
                """
            SELECT id, meta_json, remote_url, local_path, model FROM evoflow_media_assets
            WHERE provider = ? AND task_id = ?
            ORDER BY id DESC LIMIT 1
            """,
                (prov, tid),
            )
            .fetchone()
        )
        if not row:
            return False
        rid = int(row[0])
        meta = _json_loads(row[1])
        if meta_patch:
            meta.update(meta_patch)
        prev_remote = row[2]
        prev_local = row[3]
        prev_model = row[4]
        remote = (remote_url or "").strip() or prev_remote
        local = (local_path or "").strip() or prev_local
        result = canonical_result_url(remote, local, explicit=result_url)
        model_s = (model or "").strip() or prev_model
        if not model_s and isinstance(meta, dict):
            model_s = str(meta.get("model") or meta.get("model_id") or "").strip() or None
        size = file_size_bytes if file_size_bytes is not None else _file_size_for_local_path(local)
        get_db().execute(
            """
            UPDATE evoflow_media_assets SET
                status = ?,
                remote_url = COALESCE(?, remote_url),
                local_path = COALESCE(?, local_path),
                result_url = COALESCE(?, result_url),
                model = COALESCE(?, model),
                file_size_bytes = COALESCE(?, file_size_bytes),
                meta_json = ?,
                updated_at = ?
            WHERE id = ?
            """,
            (
                status,
                (remote_url or "").strip() or None,
                (local_path or "").strip() or None,
                result,
                model_s,
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
            rows = (
                get_db()
                .execute(
                    f"""
                SELECT {_SELECT_COLS}
                FROM evoflow_media_assets
                WHERE thread_id = ?
                ORDER BY id DESC
                LIMIT ? OFFSET ?
                """,
                    (str(thread_id).strip(), lim, off),
                )
                .fetchall()
            )
        else:
            rows = (
                get_db()
                .execute(
                    f"""
                SELECT {_SELECT_COLS}
                FROM evoflow_media_assets
                ORDER BY id DESC
                LIMIT ? OFFSET ?
                """,
                    (lim, off),
                )
                .fetchall()
            )
    except Exception:
        logger.debug("list_media_assets failed", exc_info=True)
        return []

    return [_row_to_dict(r) for r in rows]


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

    try:
        rows = (
            get_db()
            .execute(
                """
            SELECT remote_url, local_path, result_url, media_kind
            FROM evoflow_media_assets
            WHERE thread_id = ?
            ORDER BY id DESC
            LIMIT 200
            """,
                (tid,),
            )
            .fetchall()
        )
    except Exception:
        logger.debug("find_remote_url_for_local_path failed", exc_info=True)
        return None

    want = (media_kind or "").strip().lower() or None
    for remote, local, result, kind in rows:
        if want and str(kind or "").strip().lower() != want:
            continue
        if not (_matches(local) or _matches(remote) or _matches(result)):
            continue
        for candidate in (remote, result):
            s = str(candidate or "").strip()
            if s.lower().startswith("http://") or s.lower().startswith("https://"):
                return s
    return None
