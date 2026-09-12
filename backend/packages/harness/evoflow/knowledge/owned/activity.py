"""Owned KB user-facing activity trail (local SQLite, no Redis)."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from evoflow.knowledge.owned.db import db
from evoflow.knowledge.owned.ids import new_id, utc_now

logger = logging.getLogger(__name__)

RETENTION_DAYS = 90
MAX_PER_KB = 5000
QUERY_PREVIEW_LEN = 80

# Stable action ids (panel maps to Chinese labels).
ACTIONS = frozenset(
    {
        "base.create",
        "base.delete",
        "doc.upload",
        "doc.manual",
        "doc.save",
        "doc.delete",
        "doc.move",
        "folder.create",
        "folder.rename",
        "folder.delete",
        "folder.move",
        "import.folder",
        "import.vault",
        "sync.resync",
        "summary.generate",
        "wiki.rebuild",
        "kg.rebuild",
        "ask",
        "search",
    }
)


def _preview(text: str, limit: int = QUERY_PREVIEW_LEN) -> str:
    s = " ".join(str(text or "").split())
    if len(s) <= limit:
        return s
    return s[: max(0, limit - 1)] + "…"


def _row(r: Any) -> dict[str, Any]:
    detail_raw = r["detail_json"] if isinstance(r, dict) or hasattr(r, "keys") else "{}"
    try:
        detail = json.loads(detail_raw or "{}")
    except Exception:
        detail = {}
    if not isinstance(detail, dict):
        detail = {}
    return {
        "id": r["id"],
        "kbId": r["kb_id"] or "",
        "docId": r["doc_id"] or "",
        "action": r["action"],
        "actor": r["actor"] or "local",
        "title": r["title"] or "",
        "detail": detail,
        "createdAt": r["created_at"],
    }


def record(
    kb_id: str | None,
    action: str,
    *,
    doc_id: str | None = None,
    title: str = "",
    detail: dict[str, Any] | None = None,
    actor: str = "local",
) -> dict[str, Any] | None:
    """Insert one activity row. Never raises to callers (logs on failure)."""
    act = str(action or "").strip()
    if act not in ACTIONS:
        logger.warning("owned activity: unknown action %r", act)
        return None
    aid = new_id("act_")
    now = utc_now()
    payload = dict(detail or {})
    if "query" in payload:
        payload["queryPreview"] = _preview(str(payload.pop("query") or ""))
    if "queryPreview" in payload:
        payload["queryPreview"] = _preview(str(payload.get("queryPreview") or ""))
    try:
        with db() as conn:
            conn.execute(
                """
                INSERT INTO kb_activity(
                  id, kb_id, doc_id, action, actor, title, detail_json, created_at
                ) VALUES (?,?,?,?,?,?,?,?)
                """,
                (
                    aid,
                    kb_id or None,
                    doc_id or None,
                    act,
                    str(actor or "local")[:64] or "local",
                    str(title or "")[:240],
                    json.dumps(payload, ensure_ascii=False),
                    now,
                ),
            )
        if kb_id:
            try:
                prune(kb_id)
            except Exception:
                logger.debug("owned activity prune failed", exc_info=True)
        return {
            "id": aid,
            "kbId": kb_id or "",
            "docId": doc_id or "",
            "action": act,
            "actor": actor or "local",
            "title": str(title or "")[:240],
            "detail": payload,
            "createdAt": now,
        }
    except Exception:
        logger.exception("owned activity record failed action=%s kb=%s", act, kb_id)
        return None


def list_activities(
    *,
    kb_id: str | None = None,
    doc_id: str | None = None,
    limit: int = 50,
    before: str | None = None,
) -> list[dict[str, Any]]:
    lim = max(1, min(int(limit or 50), 200))
    clauses: list[str] = []
    args: list[Any] = []
    if doc_id:
        clauses.append("doc_id=?")
        args.append(doc_id)
    elif kb_id:
        clauses.append("kb_id=?")
        args.append(kb_id)
    if before:
        clauses.append("created_at < ?")
        args.append(str(before))
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with db() as conn:
        rows = conn.execute(
            f"""
            SELECT * FROM kb_activity
            {where}
            ORDER BY created_at DESC, id DESC
            LIMIT ?
            """,
            (*args, lim),
        ).fetchall()
    return [_row(r) for r in rows]


def prune(kb_id: str | None = None) -> int:
    """Drop rows older than retention or exceeding per-KB cap. Returns deleted count."""
    cutoff_dt = datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS)
    cutoff = cutoff_dt.replace(microsecond=0).isoformat().replace("+00:00", "Z")
    deleted = 0
    with db() as conn:
        if kb_id:
            cur = conn.execute(
                "DELETE FROM kb_activity WHERE kb_id=? AND created_at < ?",
                (kb_id, cutoff),
            )
            deleted += int(cur.rowcount or 0)
            # Cap: keep newest MAX_PER_KB
            excess = conn.execute(
                """
                SELECT id FROM (
                  SELECT id FROM kb_activity
                  WHERE kb_id=?
                  ORDER BY created_at DESC, id DESC
                  LIMIT 100000 OFFSET ?
                )
                """,
                (kb_id, MAX_PER_KB),
            ).fetchall()
            if excess:
                ids = [r["id"] for r in excess]
                # sqlite parameter limit — batch
                for i in range(0, len(ids), 400):
                    chunk = ids[i : i + 400]
                    placeholders = ",".join("?" * len(chunk))
                    cur2 = conn.execute(
                        f"DELETE FROM kb_activity WHERE id IN ({placeholders})",
                        chunk,
                    )
                    deleted += int(cur2.rowcount or 0)
        else:
            cur = conn.execute(
                "DELETE FROM kb_activity WHERE created_at < ?",
                (cutoff,),
            )
            deleted += int(cur.rowcount or 0)
    return deleted
