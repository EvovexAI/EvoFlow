"""右栏两张表：实时态 + 操作轨迹。

- ``evoflow_right_stage_current``：每个会话一份当前签表（含 ``__live__`` = 用户此刻 UI）
- ``evoflow_right_stage_trail``：打开/关闭/切签/收起/撑开/重排 的追加轨迹

由 ``POST /api/stage/right-stage/state`` 写入；失败静默，绝不拖垮右栏接口。
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
from datetime import UTC, datetime, timedelta
from typing import Any

logger = logging.getLogger(__name__)

LIVE_SCOPE = "__live__"

# 后台落库：单 worker + 只保留最新一份，避免堵 POST /state，也避免堆积写队列。
_persist_lock = threading.Lock()
_persist_pending: dict[str, Any] | None = None
_persist_worker: threading.Thread | None = None
_persist_wake = threading.Event()

_DDL = """
CREATE TABLE IF NOT EXISTS evoflow_right_stage_current (
    scope_key TEXT PRIMARY KEY,
    session_key TEXT NOT NULL DEFAULT '',
    active_key TEXT,
    active_kind TEXT,
    active_title TEXT,
    collapsed INTEGER NOT NULL DEFAULT 0,
    tab_order_json TEXT NOT NULL DEFAULT '[]',
    tabs_json TEXT NOT NULL DEFAULT '[]',
    rev INTEGER NOT NULL DEFAULT 0,
    reported_at TEXT,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evo_right_stage_current_session
    ON evoflow_right_stage_current(session_key, updated_at DESC);

CREATE TABLE IF NOT EXISTS evoflow_right_stage_trail (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    session_key TEXT NOT NULL DEFAULT '',
    event TEXT NOT NULL,
    tab_key TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    opened_by TEXT NOT NULL DEFAULT '',
    active_key_before TEXT,
    active_key_after TEXT,
    detail_json TEXT NOT NULL DEFAULT '{}',
    rev INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_evo_right_stage_trail_session_time
    ON evoflow_right_stage_trail(session_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evo_right_stage_trail_time
    ON evoflow_right_stage_trail(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evo_right_stage_trail_event
    ON evoflow_right_stage_trail(event, created_at DESC);
"""


def ensure_right_stage_tables(conn: sqlite3.Connection) -> None:
    """Idempotent create (post-baseline installs never re-run baseline DDL)."""
    try:
        row = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='evoflow_right_stage_current'"
        ).fetchone()
        if row:
            return
        conn.executescript(_DDL)
        conn.commit()
        logger.info("schema: created evoflow_right_stage_current + evoflow_right_stage_trail")
    except sqlite3.DatabaseError:
        logger.debug("schema: ensure right_stage tables failed", exc_info=True)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _tab_map(tabs: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for i, t in enumerate(tabs):
        if not isinstance(t, dict):
            continue
        key = str(t.get("key") or "").strip()
        if not key:
            kind = str(t.get("kind") or "").strip()
            ident = str(t.get("id") or "").strip()
            if kind and ident:
                key = f"{kind}:{ident}"
        if not key:
            continue
        row = dict(t)
        row["key"] = key
        row["ord"] = int(t.get("ord") if t.get("ord") is not None else i)
        out[key] = row
    return out


def _order(tabs: list[dict[str, Any]]) -> list[str]:
    keys: list[str] = []
    for i, t in enumerate(tabs):
        if not isinstance(t, dict):
            continue
        key = str(t.get("key") or "").strip()
        if not key:
            kind = str(t.get("kind") or "").strip()
            ident = str(t.get("id") or "").strip()
            if kind and ident:
                key = f"{kind}:{ident}"
        if key:
            keys.append(key)
        else:
            keys.append(f"__anon__:{i}")
    return keys


def _load_prev(conn: sqlite3.Connection, scope_key: str) -> dict[str, Any] | None:
    try:
        row = conn.execute(
            """
            SELECT session_key, active_key, active_kind, active_title, collapsed,
                   tab_order_json, tabs_json, rev, reported_at
            FROM evoflow_right_stage_current WHERE scope_key = ?
            """,
            (scope_key,),
        ).fetchone()
    except sqlite3.DatabaseError:
        return None
    if not row:
        return None
    try:
        tabs = json.loads(row[6] or "[]")
    except (TypeError, json.JSONDecodeError):
        tabs = []
    if not isinstance(tabs, list):
        tabs = []
    try:
        order = json.loads(row[5] or "[]")
    except (TypeError, json.JSONDecodeError):
        order = []
    if not isinstance(order, list):
        order = []
    return {
        "session_key": str(row[0] or ""),
        "active_key": str(row[1] or "") or None,
        "active_kind": str(row[2] or "") or None,
        "active_title": str(row[3] or "") or None,
        "collapsed": bool(row[4]),
        "tab_order": [str(x) for x in order],
        "tabs": [t for t in tabs if isinstance(t, dict)],
        "rev": int(row[7] or 0),
        "reported_at": str(row[8] or "") or None,
    }


def _append_trail(
    conn: sqlite3.Connection,
    *,
    session_key: str,
    event: str,
    tab: dict[str, Any] | None = None,
    active_before: str | None = None,
    active_after: str | None = None,
    detail: dict[str, Any] | None = None,
    rev: int = 0,
    created_at: str,
) -> None:
    t = tab or {}
    conn.execute(
        """
        INSERT INTO evoflow_right_stage_trail (
            created_at, session_key, event, tab_key, kind, title, opened_by,
            active_key_before, active_key_after, detail_json, rev
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            created_at,
            session_key,
            event,
            str(t.get("key") or ""),
            str(t.get("kind") or ""),
            str(t.get("title") or ""),
            str(t.get("openedBy") or t.get("opened_by") or ""),
            active_before,
            active_after,
            json.dumps(detail or {}, ensure_ascii=False),
            int(rev or 0),
        ),
    )


def _diff_and_trail(
    conn: sqlite3.Connection,
    *,
    session_key: str,
    prev: dict[str, Any] | None,
    next_tabs: list[dict[str, Any]],
    next_active: str | None,
    next_collapsed: bool,
    rev: int,
    created_at: str,
) -> None:
    prev_tabs = _tab_map(list(prev.get("tabs") or []) if prev else [])
    next_map = _tab_map(next_tabs)
    prev_keys = set(prev_tabs)
    next_keys = set(next_map)

    for key in sorted(next_keys - prev_keys):
        _append_trail(
            conn,
            session_key=session_key,
            event="open",
            tab=next_map[key],
            active_before=str((prev or {}).get("active_key") or "") or None,
            active_after=next_active,
            rev=rev,
            created_at=created_at,
        )
    for key in sorted(prev_keys - next_keys):
        _append_trail(
            conn,
            session_key=session_key,
            event="close",
            tab=prev_tabs[key],
            active_before=str((prev or {}).get("active_key") or "") or None,
            active_after=next_active,
            rev=rev,
            created_at=created_at,
        )

    prev_active = str((prev or {}).get("active_key") or "") or None
    if prev_active != next_active:
        hit = next_map.get(next_active or "") or prev_tabs.get(prev_active or "") or {}
        _append_trail(
            conn,
            session_key=session_key,
            event="activate",
            tab=hit,
            active_before=prev_active,
            active_after=next_active,
            rev=rev,
            created_at=created_at,
        )

    prev_collapsed = bool((prev or {}).get("collapsed")) if prev else False
    if prev and prev_collapsed != next_collapsed:
        _append_trail(
            conn,
            session_key=session_key,
            event="collapse" if next_collapsed else "expand",
            active_before=prev_active,
            active_after=next_active,
            detail={"collapsed": next_collapsed},
            rev=rev,
            created_at=created_at,
        )

    prev_order = [str(x) for x in (prev.get("tab_order") if prev else []) or _order(list(prev_tabs.values()))]
    next_order = _order(next_tabs)
    if prev and prev_keys == next_keys and prev_order != next_order and next_order:
        _append_trail(
            conn,
            session_key=session_key,
            event="reorder",
            active_before=prev_active,
            active_after=next_active,
            detail={"before": prev_order, "after": next_order},
            rev=rev,
            created_at=created_at,
        )


def _upsert_scope(
    conn: sqlite3.Connection,
    *,
    scope_key: str,
    session_key: str,
    payload: dict[str, Any],
    created_at: str,
    write_trail: bool = True,
) -> None:
    tabs = [t for t in (payload.get("tabs") or []) if isinstance(t, dict)]
    # normalize ord
    slim_tabs: list[dict[str, Any]] = []
    for i, t in enumerate(tabs):
        key = str(t.get("key") or "").strip()
        if not key:
            kind = str(t.get("kind") or "").strip()
            ident = str(t.get("id") or "").strip()
            if kind and ident:
                key = f"{kind}:{ident}"
        slim_tabs.append(
            {
                "key": key,
                "id": str(t.get("id") or (key.split(":", 1)[1] if ":" in key else "")),
                "kind": str(t.get("kind") or (key.split(":", 1)[0] if ":" in key else "")),
                "title": str(t.get("title") or ""),
                "ord": int(t.get("ord") if t.get("ord") is not None else i),
                **({"sessionKey": str(t["sessionKey"])} if t.get("sessionKey") else {}),
                **({"openedBy": str(t["openedBy"])} if t.get("openedBy") else {}),
                **({"data": t["data"]} if isinstance(t.get("data"), dict) else {}),
            }
        )
    order = [str(t["key"]) for t in slim_tabs if t.get("key")]
    active_key = str(payload.get("activeKey") or "") or None
    active_kind = str(payload.get("activeKind") or "") or None
    active_title = str(payload.get("activeTitle") or "") or None
    collapsed = payload.get("collapsed") is True
    rev = int(payload.get("rev") or 0)
    reported_at = str(payload.get("reportedAt") or "") or created_at

    prev = _load_prev(conn, scope_key)
    if write_trail:
        _diff_and_trail(
            conn,
            session_key=session_key or scope_key,
            prev=prev,
            next_tabs=slim_tabs,
            next_active=active_key,
            next_collapsed=collapsed,
            rev=rev,
            created_at=created_at,
        )

    conn.execute(
        """
        INSERT INTO evoflow_right_stage_current (
            scope_key, session_key, active_key, active_kind, active_title,
            collapsed, tab_order_json, tabs_json, rev, reported_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_key) DO UPDATE SET
            session_key=excluded.session_key,
            active_key=excluded.active_key,
            active_kind=excluded.active_kind,
            active_title=excluded.active_title,
            collapsed=excluded.collapsed,
            tab_order_json=excluded.tab_order_json,
            tabs_json=excluded.tabs_json,
            rev=excluded.rev,
            reported_at=excluded.reported_at,
            updated_at=excluded.updated_at
        """,
        (
            scope_key,
            session_key,
            active_key,
            active_kind,
            active_title,
            1 if collapsed else 0,
            json.dumps(order, ensure_ascii=False),
            json.dumps(slim_tabs, ensure_ascii=False),
            rev,
            reported_at,
            created_at,
        ),
    )


def persist_right_stage_report(payload: dict[str, Any]) -> None:
    """Upsert 实时表 + 按 diff 追加轨迹。失败静默（同步；测试/后台 worker 用）。"""
    if not isinstance(payload, dict):
        return
    try:
        from evoflow.persistence.db import get_db

        conn = get_db()
        ensure_right_stage_tables(conn)
        created_at = _now_iso()
        session_key = str(payload.get("sessionKey") or "").strip()
        # 会话维度 + 全局「此刻 UI」各写一份
        if session_key:
            _upsert_scope(
                conn,
                scope_key=session_key,
                session_key=session_key,
                payload=payload,
                created_at=created_at,
                write_trail=True,
            )
        # __live__ 只镜像「此刻 UI」，轨迹记在会话维度，避免同一操作写两遍
        _upsert_scope(
            conn,
            scope_key=LIVE_SCOPE,
            session_key=session_key,
            payload=payload,
            created_at=created_at,
            write_trail=not bool(session_key),
        )
        conn.commit()
    except Exception:  # noqa: BLE001 - 落库失败绝不拖垮右栏
        logger.debug("persist_right_stage_report failed", exc_info=True)


def _persist_worker_loop() -> None:
    global _persist_pending
    while True:
        _persist_wake.wait(timeout=2.0)
        _persist_wake.clear()
        while True:
            with _persist_lock:
                payload = _persist_pending
                _persist_pending = None
            if payload is None:
                break
            persist_right_stage_report(payload)


def schedule_persist_right_stage_report(payload: dict[str, Any]) -> None:
    """把落库丢到后台线程；连续上报只保留最新一份（与前端 400ms 节流配套）。

    调用方（``POST /state``）立刻返回，不碰 ``get_db()``。
    """
    global _persist_worker, _persist_pending
    if not isinstance(payload, dict):
        return
    # 浅拷贝，避免调用方随后改 dict 污染队列
    snap = dict(payload)
    if isinstance(snap.get("tabs"), list):
        snap["tabs"] = list(snap["tabs"])
    if isinstance(snap.get("tabOrder"), list):
        snap["tabOrder"] = list(snap["tabOrder"])
    with _persist_lock:
        _persist_pending = snap
        if _persist_worker is None or not _persist_worker.is_alive():
            _persist_worker = threading.Thread(
                target=_persist_worker_loop,
                name="evoflow-right-stage-persist",
                daemon=True,
            )
            _persist_worker.start()
    _persist_wake.set()


def flush_persist_right_stage_for_tests(timeout_s: float = 2.0) -> bool:
    """测试用：等到后台队列清空（或超时）。返回是否已空。"""
    import time

    _persist_wake.set()
    deadline = time.time() + max(0.1, float(timeout_s))
    while time.time() < deadline:
        with _persist_lock:
            empty = _persist_pending is None
        if empty:
            # 再给 worker 一点时间把刚取走的那份写完
            time.sleep(0.05)
            with _persist_lock:
                if _persist_pending is None:
                    return True
        time.sleep(0.02)
    return False


def read_right_stage_current(scope_key: str | None = None) -> dict[str, Any] | None:
    """读实时表。默认 ``__live__``（用户此刻）。"""
    key = str(scope_key or LIVE_SCOPE).strip() or LIVE_SCOPE
    try:
        from evoflow.persistence.db import get_db

        conn = get_db()
        ensure_right_stage_tables(conn)
        prev = _load_prev(conn, key)
        if not prev:
            return None
        return {
            "scopeKey": key,
            "sessionKey": prev.get("session_key") or None,
            "activeKey": prev.get("active_key"),
            "activeKind": prev.get("active_kind"),
            "activeTitle": prev.get("active_title"),
            "collapsed": bool(prev.get("collapsed")),
            "tabOrder": prev.get("tab_order") or [],
            "tabs": prev.get("tabs") or [],
            "rev": int(prev.get("rev") or 0),
            "reportedAt": prev.get("reported_at"),
        }
    except Exception:  # noqa: BLE001
        logger.debug("read_right_stage_current failed", exc_info=True)
        return None


def prune_right_stage_trail(*, days: int = 2) -> int:
    """删除早于 *days* 天的轨迹行（默认保留今天+昨天，清两天前）。

    走独立短连接，不长期占共享写锁；表不存在时返回 0。
    """
    keep_days = max(1, int(days))
    cutoff = (datetime.now(UTC) - timedelta(days=keep_days)).strftime("%Y-%m-%d")
    try:
        from evoflow.persistence.db import resolve_evolflow_db_path

        path = resolve_evolflow_db_path()
        if not path.is_file():
            return 0
        conn = sqlite3.connect(str(path), timeout=60.0)
        try:
            row = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' "
                "AND name='evoflow_right_stage_trail' LIMIT 1"
            ).fetchone()
            if not row:
                return 0
            # created_at 是 ISO；用日期前缀比较，兼容带 Z / 时区的写法
            cur = conn.execute(
                "DELETE FROM evoflow_right_stage_trail WHERE created_at < ?",
                (cutoff,),
            )
            conn.commit()
            deleted = int(cur.rowcount or 0)
            if deleted:
                logger.info(
                    "right_stage_trail prune: deleted=%s keep_days=%s cutoff=%s",
                    deleted,
                    keep_days,
                    cutoff,
                )
            return deleted
        finally:
            conn.close()
    except Exception:
        logger.debug("right_stage_trail prune failed days=%s", keep_days, exc_info=True)
        return 0


def read_right_stage_trail(
    *,
    session_key: str | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    """读轨迹（新→旧）。"""
    lim = max(1, min(int(limit or 100), 1000))
    sk = str(session_key or "").strip()
    try:
        from evoflow.persistence.db import get_db

        conn = get_db()
        ensure_right_stage_tables(conn)
        if sk:
            rows = conn.execute(
                """
                SELECT id, created_at, session_key, event, tab_key, kind, title, opened_by,
                       active_key_before, active_key_after, detail_json, rev
                FROM evoflow_right_stage_trail
                WHERE session_key = ?
                ORDER BY id DESC LIMIT ?
                """,
                (sk, lim),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT id, created_at, session_key, event, tab_key, kind, title, opened_by,
                       active_key_before, active_key_after, detail_json, rev
                FROM evoflow_right_stage_trail
                ORDER BY id DESC LIMIT ?
                """,
                (lim,),
            ).fetchall()
        out: list[dict[str, Any]] = []
        for r in rows:
            try:
                detail = json.loads(r[10] or "{}")
            except (TypeError, json.JSONDecodeError):
                detail = {}
            out.append(
                {
                    "id": int(r[0]),
                    "createdAt": str(r[1] or ""),
                    "sessionKey": str(r[2] or ""),
                    "event": str(r[3] or ""),
                    "tabKey": str(r[4] or ""),
                    "kind": str(r[5] or ""),
                    "title": str(r[6] or ""),
                    "openedBy": str(r[7] or ""),
                    "activeKeyBefore": str(r[8] or "") or None,
                    "activeKeyAfter": str(r[9] or "") or None,
                    "detail": detail if isinstance(detail, dict) else {},
                    "rev": int(r[11] or 0),
                }
            )
        return out
    except Exception:  # noqa: BLE001
        logger.debug("read_right_stage_trail failed", exc_info=True)
        return []
