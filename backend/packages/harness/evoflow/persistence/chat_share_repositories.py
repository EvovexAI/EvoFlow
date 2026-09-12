"""CRUD for evoflow_chat_shares (immutable transcript snapshots)."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from evoflow.persistence.db import get_db

logger = logging.getLogger(__name__)

_MAX_SNAPSHOT_MESSAGES = 5000
_MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024  # 8 MiB


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _parse_iso(value: str | None) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        dt = datetime.fromisoformat(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def _extract_text_from_content(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                t = block.strip()
                if t:
                    parts.append(t)
            elif isinstance(block, dict):
                btype = str(block.get("type") or "").strip().lower()
                if btype in {"text", "input_text", "output_text"} or "text" in block:
                    t = str(block.get("text") or block.get("content") or "").strip()
                    if t:
                        parts.append(t)
        return "\n".join(parts).strip()
    if isinstance(content, dict):
        if "text" in content:
            return str(content.get("text") or "").strip()
        if "content" in content:
            return _extract_text_from_content(content.get("content"))
    return ""


def build_share_snapshot_messages(
    display_messages: list[dict[str, Any]],
    *,
    include_tools: bool = False,
) -> list[dict[str, Any]]:
    """Sanitize display rows into a lean share snapshot."""
    out: list[dict[str, Any]] = []
    for msg in display_messages or []:
        if not isinstance(msg, dict):
            continue
        role = str(msg.get("role") or "").strip().lower()
        mtype = str(msg.get("type") or "").strip().lower()
        if role in {"system"} or mtype in {"system"}:
            continue
        if role == "tool" or mtype == "tool":
            if not include_tools:
                continue
            name = str(msg.get("name") or msg.get("tool_name") or "tool").strip() or "tool"
            payload = msg.get("content_json")
            text = _extract_text_from_content(payload)
            if not text and isinstance(payload, dict):
                text = str(payload.get("summary") or payload.get("result") or "")[:800]
            if not text:
                text = f"[tool:{name}]"
            out.append(
                {
                    "role": "tool",
                    "type": "tool",
                    "name": name,
                    "content": text[:2000],
                }
            )
            continue
        if role not in {"user", "assistant", "human", "ai"} and mtype not in {
            "human",
            "ai",
            "user",
            "assistant",
        }:
            continue
        payload = msg.get("content_json")
        text = _extract_text_from_content(payload)
        if not text:
            continue
        norm_role = "user" if role in {"user", "human"} or mtype == "human" else "assistant"
        out.append(
            {
                "role": norm_role,
                "type": "human" if norm_role == "user" else "ai",
                "content": text,
            }
        )
        if len(out) >= _MAX_SNAPSHOT_MESSAGES:
            break
    return out


def create_share(
    *,
    token: str,
    session_key: str,
    title: str,
    messages: list[dict[str, Any]],
    include_tools: bool = False,
    expires_in_days: int | None = 7,
    created_by: str | None = None,
) -> dict[str, Any]:
    sk = str(session_key or "").strip()
    tok = str(token or "").strip()
    if not sk or not tok:
        raise ValueError("session_key and token are required")
    snapshot = {
        "title": str(title or "").strip() or "未命名会话",
        "messages": messages,
    }
    snapshot_json = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"))
    if len(snapshot_json.encode("utf-8")) > _MAX_SNAPSHOT_BYTES:
        raise ValueError("会话内容过大，无法生成分享快照")
    created = _utc_now_iso()
    expires_at: str | None = None
    if expires_in_days is not None:
        days = max(1, min(int(expires_in_days), 365))
        expires_at = (
            datetime.now(timezone.utc).replace(microsecond=0) + timedelta(days=days)
        ).isoformat()
    cols = {
        str(r[1])
        for r in get_db().execute("PRAGMA table_info(evoflow_chat_shares)").fetchall()
    }
    creator = str(created_by or "").strip() or None
    if "created_by" in cols and creator:
        get_db().execute(
            """
            INSERT INTO evoflow_chat_shares (
                token, session_key, title, snapshot_json, created_at, expires_at,
                revoked_at, include_tools, created_by
            ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
            """,
            (
                tok,
                sk,
                snapshot["title"],
                snapshot_json,
                created,
                expires_at,
                1 if include_tools else 0,
                creator,
            ),
        )
    else:
        get_db().execute(
            """
            INSERT INTO evoflow_chat_shares (
                token, session_key, title, snapshot_json, created_at, expires_at, revoked_at, include_tools
            ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
            """,
            (
                tok,
                sk,
                snapshot["title"],
                snapshot_json,
                created,
                expires_at,
                1 if include_tools else 0,
            ),
        )
    get_db().commit()
    return {
        "token": tok,
        "session_key": sk,
        "title": snapshot["title"],
        "created_at": created,
        "expires_at": expires_at,
        "include_tools": bool(include_tools),
        "message_count": len(messages),
    }


def get_share_row(token: str) -> dict[str, Any] | None:
    tok = str(token or "").strip()
    if not tok:
        return None
    row = (
        get_db()
        .execute(
            """
            SELECT token, session_key, title, snapshot_json, created_at, expires_at, revoked_at, include_tools
            FROM evoflow_chat_shares
            WHERE token = ?
            """,
            (tok,),
        )
        .fetchone()
    )
    if not row:
        return None
    return {
        "token": row[0],
        "session_key": row[1],
        "title": row[2],
        "snapshot_json": row[3],
        "created_at": row[4],
        "expires_at": row[5],
        "revoked_at": row[6],
        "include_tools": int(row[7] or 0),
    }


def share_is_active(row: dict[str, Any]) -> tuple[bool, str]:
    if str(row.get("revoked_at") or "").strip():
        return False, "revoked"
    expires = _parse_iso(str(row.get("expires_at") or ""))
    if expires is not None and expires <= datetime.now(timezone.utc):
        return False, "expired"
    return True, "ok"


def get_public_share(token: str) -> dict[str, Any] | None:
    row = get_share_row(token)
    if not row:
        return None
    ok, reason = share_is_active(row)
    if not ok:
        return {"ok": False, "reason": reason}
    try:
        snapshot = json.loads(str(row.get("snapshot_json") or "{}"))
    except Exception:
        snapshot = {}
    messages = snapshot.get("messages") if isinstance(snapshot, dict) else []
    if not isinstance(messages, list):
        messages = []
    return {
        "ok": True,
        "token": row["token"],
        "title": str(snapshot.get("title") or row.get("title") or "未命名会话"),
        "created_at": row.get("created_at"),
        "expires_at": row.get("expires_at"),
        "include_tools": bool(row.get("include_tools")),
        "messages": messages,
        "message_count": len(messages),
    }


def revoke_share(token: str) -> bool:
    tok = str(token or "").strip()
    if not tok:
        return False
    row = get_share_row(tok)
    if not row:
        return False
    if str(row.get("revoked_at") or "").strip():
        return True
    get_db().execute(
        "UPDATE evoflow_chat_shares SET revoked_at = ? WHERE token = ?",
        (_utc_now_iso(), tok),
    )
    get_db().commit()
    return True


def latest_share_for_session(session_key: str) -> dict[str, Any] | None:
    sk = str(session_key or "").strip()
    if not sk:
        return None
    row = (
        get_db()
        .execute(
            """
            SELECT token, session_key, title, created_at, expires_at, revoked_at, include_tools
            FROM evoflow_chat_shares
            WHERE session_key = ?
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (sk,),
        )
        .fetchone()
    )
    if not row:
        return None
    data = {
        "token": row[0],
        "session_key": row[1],
        "title": row[2],
        "created_at": row[3],
        "expires_at": row[4],
        "revoked_at": row[5],
        "include_tools": int(row[6] or 0),
    }
    ok, reason = share_is_active(data)
    data["active"] = ok
    data["status"] = reason if not ok else "active"
    return data
