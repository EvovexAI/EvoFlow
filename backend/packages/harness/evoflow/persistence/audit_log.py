"""Append-only operation audit log (enterprise governance).

记录「谁在什么时候对什么资源做了什么」——发布/改定义/删除/运行/密钥等管理动作。
设计约束：

- **append-only**：业务代码只写不删不改；没有 delete/UPDATE API。
- **绝不阻断主操作**：``record_action`` 内部吞掉一切异常（只 log）。审计写失败
  不允许把一次 publish/run 变成 500。
- **单表 JSON detail**：不同动作的细节形状不同，不过度建模；查询走
  ``resource_type`` / ``resource_id`` / ``action`` / ``actor_id`` 过滤。
"""

from __future__ import annotations

import json
import logging
from typing import Any

from evoflow.persistence.db import get_db, run_db_with_retry
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS evoflow_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    actor_id TEXT DEFAULT '',
    actor_label TEXT DEFAULT '',
    org_id TEXT DEFAULT '',
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    detail_json TEXT DEFAULT '{}'
)
"""

_INDEX_SQL = (
    "CREATE INDEX IF NOT EXISTS idx_audit_resource ON evoflow_audit_log (resource_type, resource_id, id)",
    "CREATE INDEX IF NOT EXISTS idx_audit_actor ON evoflow_audit_log (actor_id, id)",
)

_table_ready = False


def _ensure_table(conn: Any) -> None:
    global _table_ready
    if _table_ready:
        return
    conn.execute(_TABLE_SQL)
    for stmt in _INDEX_SQL:
        try:
            conn.execute(stmt)
        except Exception:
            pass  # index is best-effort; table presence is what matters
    _table_ready = True


def record_action(
    action: str,
    resource_type: str,
    resource_id: str,
    *,
    actor: dict[str, Any] | None = None,
    detail: dict[str, Any] | None = None,
) -> None:
    """Append one audit row. Never raises.

    ``actor``: ``{actor_id, actor_label, org_id}`` — resolved by the caller from
    the request (audit module stays decoupled from authz context).
    ``detail``: JSON-serializable dict; non-serializable values are coerced to str.
    """
    actor = actor if isinstance(actor, dict) else {}
    try:
        safe_detail: dict[str, Any] = {}
        for key, val in (detail or {}).items():
            try:
                json.dumps(val, ensure_ascii=False)
                safe_detail[str(key)] = val
            except (TypeError, ValueError):
                safe_detail[str(key)] = str(val)

        def _write() -> None:
            conn = get_db()
            _ensure_table(conn)
            conn.execute(
                """
                INSERT INTO evoflow_audit_log
                    (created_at, actor_id, actor_label, org_id, action, resource_type, resource_id, detail_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    utc_now_iso_z(),
                    str(actor.get("actor_id") or ""),
                    str(actor.get("actor_label") or ""),
                    str(actor.get("org_id") or ""),
                    str(action or ""),
                    str(resource_type or ""),
                    str(resource_id or ""),
                    json.dumps(safe_detail, ensure_ascii=False),
                ),
            )
            conn.commit()

        run_db_with_retry(_write)
    except Exception:
        logger.warning(
            "audit_log: failed to record %s/%s — operation continues without audit",
            resource_type,
            resource_id,
            exc_info=True,
        )


def list_actions(
    *,
    resource_type: str | None = None,
    resource_id: str | None = None,
    action: str | None = None,
    actor_id: str | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    """Newest-first audit rows with optional filters. Read failures return []."""
    limit = max(1, min(int(limit or 100), 500))
    where: list[str] = []
    params: list[Any] = []
    if resource_type:
        where.append("resource_type = ?")
        params.append(resource_type)
    if resource_id:
        where.append("resource_id = ?")
        params.append(resource_id)
    if action:
        where.append("action = ?")
        params.append(action)
    if actor_id:
        where.append("actor_id = ?")
        params.append(actor_id)
    sql = (
        "SELECT id, created_at, actor_id, actor_label, org_id, action, resource_type, resource_id, detail_json "
        f"FROM evoflow_audit_log {'WHERE ' + ' AND '.join(where) if where else ''} "
        "ORDER BY id DESC LIMIT ?"
    )
    params.append(limit)
    try:
        conn = get_db()
        try:
            _ensure_table(conn)
        except Exception:
            pass
        cur = conn.execute(sql, params)
        cols = [d[0] for d in cur.description]
        rows = []
        for row in cur.fetchall():
            doc = dict(zip(cols, row, strict=False))
            try:
                doc["detail"] = json.loads(doc.pop("detail_json") or "{}")
            except Exception:
                doc["detail"] = {}
            rows.append(doc)
        return rows
    except Exception:
        logger.warning("audit_log: list_actions failed", exc_info=True)
        return []


__all__ = ["record_action", "list_actions"]
