"""真实数据采集器 —— 从 ``evoflow.db`` 采集评测中心所需的业务数据。

所有查询均为参数化 SQL，优先基于数据库真实表（``evoflow_mission_nodes`` /
``evoflow_chat_messages`` / ``evoflow_chat_sessions`` / ``evoflow_workspaces`` 等）。

去 Mock 原则：不生成任何随机/假数据。数据为空即返回空结构（0、空列表、空字典）。

约定：
- ``days`` 表示回看天数，时间过滤以毫秒时间戳为准
  （``created_at_ms`` / ``updated_at_ms`` 等列），UTC 当前时间由 ``timeutil`` 提供。
- 当目标表不存在时，结果中加入 ``_table_missing: true``（仅用于调试，标识为何无数据）；
  表存在但没有数据时只返回空结构，不标注缺失。
- 返回值不再包含 ``_mock`` 字段。
"""

from __future__ import annotations

import json
import logging
import math
import time
from typing import Any

from evoflow.persistence.db import get_db

logger = logging.getLogger(__name__)


def _now_ms() -> int:
    """当前 UTC 毫秒时间戳。"""
    return int(time.time() * 1000)


# ---------------------------------------------------------------------------
# 表存在性探测
# ---------------------------------------------------------------------------

_TABLE_CACHE: dict[str, bool] = {}


def _table_exists(db: Any, name: str) -> bool:
    """返回指定表是否存在于当前数据库中（带进程内缓存）。"""
    if name in _TABLE_CACHE:
        return _TABLE_CACHE[name]
    try:
        row = db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            (name,),
        ).fetchone()
        exists = row is not None
    except Exception:  # noqa: BLE001 - 探测失败按不存在处理
        logger.debug("table probe failed for %s", name, exc_info=True)
        exists = False
    _TABLE_CACHE[name] = exists
    return exists


def _columns(db: Any, name: str) -> set[str]:
    """返回表的列名集合；表不存在时返回空集合。"""
    if not _table_exists(db, name):
        return set()
    try:
        rows = db.execute(f'PRAGMA table_info("{name}")').fetchall()
        return {str(r[1]) for r in rows}
    except Exception:  # noqa: BLE001
        return set()


def _row_to_dict(row: Any, cols: list[str]) -> dict[str, Any]:
    """将 sqlite3.Row / tuple 转换为 dict（按列名顺序）。"""
    if row is None:
        return {}
    out: dict[str, Any] = {}
    for i, col in enumerate(cols):
        if i < len(row):
            out[col] = row[i]
    return out


def _since_ms(days: int) -> int:
    """计算 ``days`` 天前的毫秒时间戳。"""
    return _now_ms() - int(days) * 24 * 3600 * 1000


def _missing(table: str) -> dict[str, Any]:
    """返回“表缺失”标记结果（仅用于调试）。"""
    return {"_table_missing": True, "_missing_table": table}


# ---------------------------------------------------------------------------
# 任务统计（基于 evoflow_mission_nodes 作为 work items 的落库）
# ---------------------------------------------------------------------------

_MISSION_STATUSES = ("pending", "in_progress", "done", "failed", "blocked", "cancelled")
_DONE_STATUSES = ("done", "completed", "success")
_FAILED_STATUSES = ("failed", "error", "cancelled")


def _norm_status(raw: str) -> str:
    s = str(raw or "").strip().lower()
    if s in _DONE_STATUSES:
        return "done"
    if s in _FAILED_STATUSES:
        return "failed"
    if s in ("in_progress", "running", "active"):
        return "in_progress"
    if s in ("blocked",):
        return "blocked"
    if s in ("pending", "planned", "todo", "open"):
        return "pending"
    return s or "unknown"


def get_task_stats(days: int = 7) -> dict[str, Any]:
    """任务统计：总数、完成数、失败数、各状态数量。

    优先从 ``evoflow_collab_tasks`` 聚合；也兼容旧表
    ``evoflow_mission_nodes``。表不存在返回 ``_table_missing``，
    存在但为空返回空结构（0）。
    """
    db = get_db()
    since_ms = _since_ms(days)

    # 优先：evoflow_collab_tasks（真实协作任务表）
    if _table_exists(db, "evoflow_collab_tasks"):
        try:
            all_rows = db.execute(
                "SELECT status, created_at FROM evoflow_collab_tasks"
            ).fetchall()
            total = 0
            status_map: dict[str, int] = {}
            for r in all_rows:
                ts = _parse_iso_ms(r["created_at"])
                if ts and ts < since_ms:
                    continue
                total += 1
                st = _norm_status(r["status"])
                status_map[st] = status_map.get(st, 0) + 1

            if total > 0:
                done = sum(status_map.get(s, 0) for s in _DONE_STATUSES)
                failed = sum(status_map.get(s, 0) for s in _FAILED_STATUSES)
                return {
                    "total": total,
                    "done": done,
                    "failed": failed,
                    "completion_rate": round(done / total, 4) if total else 0.0,
                    "status_counts": status_map,
                }
            # collab_tasks 存在但为空 → 继续回退到 mission_nodes
        except Exception:  # noqa: BLE001
            logger.debug("evoflow_collab_tasks query failed", exc_info=True)
            # 查询失败也回退

    # 回退：evoflow_mission_nodes
    if _table_exists(db, "evoflow_mission_nodes"):
        cols = _columns(db, "evoflow_mission_nodes")
        status_col = "status" if "status" in cols else None
        ts_col = None
        for c in ("updated_at", "created_at"):
            if c in cols:
                ts_col = c
                break
        if status_col:
            try:
                if ts_col:
                    rows = db.execute(
                        f"SELECT {status_col} AS status, {ts_col} AS ts_raw "
                        f"FROM evoflow_mission_nodes"
                    ).fetchall()
                    total = 0
                    status_map: dict[str, int] = {}
                    for r in rows:
                        ts = _parse_iso_ms(r["ts_raw"])
                        if ts and ts < since_ms:
                            continue
                        total += 1
                        st = _norm_status(r["status"])
                        status_map[st] = status_map.get(st, 0) + 1
                else:
                    rows = db.execute(
                        f"""
                        SELECT {status_col} AS status, COUNT(*) AS cnt
                        FROM evoflow_mission_nodes
                        GROUP BY {status_col}
                        """
                    ).fetchall()
                    total = int(sum(int(r["cnt"]) for r in rows))
                    status_map = {}
                    for r in rows:
                        st = _norm_status(r["status"])
                        status_map[st] = status_map.get(st, 0) + int(r["cnt"])

                if total > 0:
                    done = sum(status_map.get(s, 0) for s in _DONE_STATUSES)
                    failed = sum(status_map.get(s, 0) for s in ("failed",))
                    return {
                        "total": total,
                        "done": done,
                        "failed": failed,
                        "completion_rate": round(done / total, 4) if total else 0.0,
                        "status_counts": status_map,
                    }
                return {
                    "total": 0, "done": 0, "failed": 0,
                    "completion_rate": 0.0, "status_counts": {},
                }
            except Exception:  # noqa: BLE001
                logger.debug("mission_nodes task stats query failed", exc_info=True)
        return {
            "total": 0, "done": 0, "failed": 0,
            "completion_rate": 0.0, "status_counts": {},
        }

    # 回退：任务事件数量
    if _table_exists(db, "evoflow_task_events"):
        try:
            row = db.execute("SELECT COUNT(*) AS c FROM evoflow_task_events").fetchone()
            n = int(row["c"]) if row else 0
            if n > 0:
                return {
                    "total": n, "done": 0, "failed": 0,
                    "completion_rate": 0.0,
                    "status_counts": {"pending": n},
                }
        except Exception:  # noqa: BLE001
            pass
        return {
            "total": 0, "done": 0, "failed": 0,
            "completion_rate": 0.0, "status_counts": {},
        }

    return _missing("evoflow_collab_tasks")


def _iter_mission_updated_ms(db: Any) -> list[int]:
    """从 mission_nodes 抽取更新时间（毫秒）。若无法解析，返回空列表。"""
    cols = _columns(db, "evoflow_mission_nodes")
    if "updated_at" not in cols:
        return []
    try:
        rows = db.execute(
            "SELECT updated_at FROM evoflow_mission_nodes WHERE updated_at IS NOT NULL"
        ).fetchall()
    except Exception:  # noqa: BLE001
        return []
    out: list[int] = []
    for r in rows:
        ts = _parse_iso_ms(r["updated_at"])
        if ts is not None:
            out.append(ts)
    return out


def _parse_iso_ms(value: Any) -> int | None:
    """把 ISO8601 时间字符串或毫秒数字解析为毫秒时间戳；失败返回 None。"""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        v = int(value)
        # 秒级 vs 毫秒级启发式
        return v * 1000 if v < 10_000_000_000 else v
    s = str(value).strip()
    if not s:
        return None
    if s.isdigit():
        v = int(s)
        return v * 1000 if v < 10_000_000_000 else v
    for fmt in ("%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
        try:
            return int(time.mktime(time.strptime(s[:23], fmt)) * 1000)
        except (ValueError, TypeError):
            continue
    return None


def get_task_duration_distribution(days: int = 7) -> dict[str, Any]:
    """任务耗时分布（P50 / P95 / P99 / 平均）。

    当任务表缺少明确的开始/结束时间列时，以 mission_nodes 的 ``updated_at``
    与 ``created_at`` 差值近似；数据不足返回空分布。
    """
    db = get_db()
    durations: list[float] = []

    if _table_exists(db, "evoflow_mission_nodes"):
        cols = _columns(db, "evoflow_mission_nodes")
        end_col = "updated_at" if "updated_at" in cols else None
        start_col = "created_at" if "created_at" in cols else None
        if end_col:
            try:
                if start_col:
                    rows = db.execute(
                        f"SELECT {start_col} AS s, {end_col} AS e FROM evoflow_mission_nodes"
                    ).fetchall()
                    for r in rows:
                        s = _parse_iso_ms(r["s"])
                        e = _parse_iso_ms(r["e"])
                        if s and e and e >= s:
                            durations.append((e - s) / 1000.0)
            except Exception:  # noqa: BLE001
                pass

    if durations:
        return _percentiles(durations)
    if not _table_exists(db, "evoflow_mission_nodes"):
        return _missing("evoflow_mission_nodes")
    return _percentiles([])


def _percentiles(values: list[float]) -> dict[str, Any]:
    if not values:
        return {"p50": 0.0, "p95": 0.0, "p99": 0.0, "avg": 0.0, "count": 0}
    vals = sorted(values)
    n = len(vals)

    def pct(p: float) -> float:
        idx = max(0, min(n - 1, int(math.ceil(p * n) - 1)))
        return round(vals[idx], 2)

    return {
        "p50": pct(0.50),
        "p95": pct(0.95),
        "p99": pct(0.99),
        "avg": round(sum(vals) / n, 2),
        "count": n,
    }


def get_task_trend(days: int = 7) -> dict[str, Any]:
    """每日任务数 / 完成率趋势（返回最近 ``days`` 天的序列）。"""
    db = get_db()
    since = _since_ms(days)
    day_map: dict[str, dict[str, Any]] = {}
    for i in range(days - 1, -1, -1):
        day_map[_day_key(i)] = {"total": 0, "done": 0, "date": _day_key(i)}

    if _table_exists(db, "evoflow_mission_nodes"):
        cols = _columns(db, "evoflow_mission_nodes")
        if "updated_at" in cols:
            try:
                rows = db.execute(
                    "SELECT status, updated_at FROM evoflow_mission_nodes WHERE updated_at IS NOT NULL"
                ).fetchall()
                for r in rows:
                    ts = _parse_iso_ms(r["updated_at"])
                    if ts is None or ts < since:
                        continue
                    key = _day_key_for_ms(ts)
                    if key not in day_map:
                        continue
                    day_map[key]["total"] += 1
                    if _norm_status(r["status"]) in _DONE_STATUSES:
                        day_map[key]["done"] += 1
            except Exception:  # noqa: BLE001
                pass

    series = []
    for key in sorted(day_map.keys()):
        d = day_map[key]
        series.append(
            {
                "date": d["date"],
                "total": d["total"],
                "done": d["done"],
                "completion_rate": round(d["done"] / d["total"], 4) if d["total"] else 0.0,
            }
        )
    if not _table_exists(db, "evoflow_mission_nodes"):
        return {"days": days, "series": series, **_missing("evoflow_mission_nodes")}
    return {"days": days, "series": series}


def _day_key(offset: int) -> str:
    """返回距今 ``offset`` 天的日期字符串 YYYY-MM-DD（本地时区）。"""
    lt = time.localtime(_now_ms() / 1000.0 - offset * 86400)
    return time.strftime("%Y-%m-%d", lt)


def _day_key_for_ms(ts: int) -> str:
    lt = time.localtime(ts / 1000.0)
    return time.strftime("%Y-%m-%d", lt)


# ---------------------------------------------------------------------------
# 工具调用统计（基于 evoflow_chat_messages.tool_name / tool_calls_json）
# ---------------------------------------------------------------------------

def _extract_tool_names_from_json(raw: Any) -> list[str]:
    """从 tool_calls_json 或 content_json 中尽力抽取工具名列表。"""
    if not raw:
        return []
    if isinstance(raw, list):
        out = []
        for item in raw:
            if isinstance(item, dict):
                nm = item.get("name") or item.get("tool_name") or item.get("function", {}).get("name")
                if nm:
                    out.append(str(nm))
        return out
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except (ValueError, TypeError):
            return []
        return _extract_tool_names_from_json(parsed)
    if isinstance(raw, dict):
        nm = raw.get("name") or raw.get("tool_name")
        if nm:
            return [str(nm)]
        func = raw.get("function")
        if isinstance(func, dict) and func.get("name"):
            return [str(func["name"])]
    return []


def _iter_tool_calls(db: Any, since_ms: int) -> list[dict[str, Any]]:
    """遍历聊天消息中的工具调用，返回 {name, success, duration_ms, ts} 列表。"""
    out: list[dict[str, Any]] = []
    if not _table_exists(db, "evoflow_chat_messages"):
        return out
    cols = _columns(db, "evoflow_chat_messages")
    # 确定时间字段名
    ts_col = None
    if "created_at_ms" in cols:
        ts_col = "created_at_ms"
    elif "created_at" in cols:
        ts_col = "created_at"
    if not ts_col or "tool_name" not in cols:
        return out

    try:
        rows = db.execute(
            f"""
            SELECT tool_name, role, {ts_col} AS ts_raw,
                   content_json, id, session_key
            FROM evoflow_chat_messages
            WHERE tool_name IS NOT NULL AND tool_name <> ''
            """
        ).fetchall()
    except Exception:  # noqa: BLE001
        logger.debug("_iter_tool_calls query failed", exc_info=True)
        return out

    # 用 message_id / tool_call_id 关联成功失败：
    # role='tool' 的消息是工具返回结果，content_json 里如果有 error 就是失败
    # role='assistant' 的消息是发起工具调用，暂时记为 pending（按成功算）
    for r in rows:
        ts = 0
        ts_raw = r["ts_raw"]
        if isinstance(ts_raw, (int, float)) and ts_raw > 1e12:  # 毫秒级时间戳
            ts = int(ts_raw)
        else:
            parsed = _parse_iso_ms(ts_raw)
            if parsed:
                ts = parsed
        if ts and ts < since_ms:
            continue

        name = str(r["tool_name"]).strip()
        if not name:
            continue

        # 判断成功/失败：role=tool 且 content_json 里有 error 键视为失败
        success = True
        if r["role"] == "tool":
            content_raw = r["content_json"]
            if content_raw:
                try:
                    content = json.loads(content_raw) if isinstance(content_raw, str) else content_raw
                    if isinstance(content, dict) and ("error" in content or "error_code" in content):
                        success = False
                except (ValueError, TypeError):
                    pass

        out.append(
            {
                "name": name,
                "success": 1 if success else 0,
                "duration_ms": None,
                "ts": ts,
            }
        )
    return out


def get_tool_call_stats(days: int = 7) -> dict[str, Any]:
    """工具调用统计：按工具名分组的调用量、成功率、平均耗时。"""
    db = get_db()
    since = _since_ms(days)
    calls = _iter_tool_calls(db, since)

    if calls:
        groups: dict[str, dict[str, Any]] = {}
        for c in calls:
            g = groups.setdefault(
                c["name"],
                {"tool": c["name"], "calls": 0, "success": 0, "fail": 0, "total_duration_ms": 0, "duration_count": 0},
            )
            g["calls"] += 1
            if c["success"]:
                g["success"] += 1
            else:
                g["fail"] += 1
            if c["duration_ms"] is not None:
                g["total_duration_ms"] += int(c["duration_ms"])
                g["duration_count"] += 1
        items = []
        for g in groups.values():
            avg = round(g["total_duration_ms"] / g["duration_count"], 2) if g["duration_count"] else None
            items.append(
                {
                    "tool": g["tool"],
                    "calls": g["calls"],
                    "success": g["success"],
                    "fail": g["fail"],
                    "success_rate": round(g["success"] / g["calls"], 4) if g["calls"] else 0.0,
                    "avg_duration_ms": avg,
                }
            )
        items.sort(key=lambda x: x["calls"], reverse=True)
        return {
            "days": days,
            "total_calls": sum(i["calls"] for i in items),
            "tools": items,
        }
    if not _table_exists(db, "evoflow_chat_messages"):
        return {"days": days, "total_calls": 0, "tools": [], **_missing("evoflow_chat_messages")}
    return {"days": days, "total_calls": 0, "tools": []}


def get_tool_trend(days: int = 7) -> dict[str, Any]:
    """工具调用每日趋势（按天汇总调用量）。"""
    db = get_db()
    since = _since_ms(days)
    calls = _iter_tool_calls(db, since)
    day_map: dict[str, int] = {}
    for i in range(days - 1, -1, -1):
        day_map[_day_key(i)] = 0
    for c in calls:
        if c["ts"] and c["ts"] >= since:
            key = _day_key_for_ms(c["ts"])
            if key in day_map:
                day_map[key] += 1
    series = [{"date": k, "calls": day_map[k]} for k in sorted(day_map.keys())]
    if not _table_exists(db, "evoflow_chat_messages"):
        return {"days": days, "series": series, **_missing("evoflow_chat_messages")}
    return {"days": days, "series": series}


# ---------------------------------------------------------------------------
# 对话 / 知识库统计
# ---------------------------------------------------------------------------

def get_conversation_stats(days: int = 7) -> dict[str, Any]:
    """对话统计：会话数、消息数、活跃用户（会话）数。"""
    db = get_db()
    since_ms = _since_ms(days)

    sessions = 0
    messages = 0
    active_users = 0

    if _table_exists(db, "evoflow_chat_sessions"):
        cols = _columns(db, "evoflow_chat_sessions")
        ts_col = "created_at_ms" if "created_at_ms" in cols else ("created_at" if "created_at" in cols else None)
        del_col = "is_deleted" if "is_deleted" in cols else None
        try:
            if ts_col:
                rows = db.execute(
                    f"SELECT {ts_col} AS ts_raw, is_deleted FROM evoflow_chat_sessions"
                ).fetchall() if del_col else db.execute(
                    f"SELECT {ts_col} AS ts_raw FROM evoflow_chat_sessions"
                ).fetchall()
                count = 0
                for r in rows:
                    ts_raw = r["ts_raw"]
                    ts = 0
                    if isinstance(ts_raw, (int, float)) and ts_raw > 1e12:
                        ts = int(ts_raw)
                    else:
                        parsed = _parse_iso_ms(ts_raw)
                        if parsed:
                            ts = parsed
                    if ts and ts >= since_ms:
                        if del_col and str(r["is_deleted"]) == "1":
                            continue
                        count += 1
                sessions = count
            else:
                row = db.execute("SELECT COUNT(*) AS c FROM evoflow_chat_sessions").fetchone()
                sessions = int(row["c"]) if row else 0
        except Exception:  # noqa: BLE001
            sessions = 0

    if _table_exists(db, "evoflow_chat_messages"):
        cols = _columns(db, "evoflow_chat_messages")
        ts_col = "created_at_ms" if "created_at_ms" in cols else ("created_at" if "created_at" in cols else None)
        try:
            if ts_col:
                rows = db.execute(f"SELECT {ts_col} AS ts_raw FROM evoflow_chat_messages").fetchall()
                count = 0
                for r in rows:
                    ts_raw = r["ts_raw"]
                    ts = 0
                    if isinstance(ts_raw, (int, float)) and ts_raw > 1e12:
                        ts = int(ts_raw)
                    else:
                        parsed = _parse_iso_ms(ts_raw)
                        if parsed:
                            ts = parsed
                    if ts and ts >= since_ms:
                        count += 1
                messages = count
            else:
                row = db.execute("SELECT COUNT(*) AS c FROM evoflow_chat_messages").fetchone()
                messages = int(row["c"]) if row else 0
        except Exception:  # noqa: BLE001
            messages = 0

    if _table_exists(db, "evoflow_workspaces"):
        try:
            row = db.execute("SELECT COUNT(*) AS c FROM evoflow_workspaces").fetchone()
            active_users = int(row["c"]) if row else 0
        except Exception:  # noqa: BLE001
            active_users = 0

    result = {
        "days": days,
        "sessions": sessions,
        "messages": messages,
        "active_users": active_users or sessions,
    }
    if not (_table_exists(db, "evoflow_chat_sessions") or _table_exists(db, "evoflow_chat_messages")):
        result.update(_missing("evoflow_chat_messages"))
    return result


def get_knowledge_stats(days: int = 7) -> dict[str, Any]:
    """知识库统计：vault 数、文档抽样、全文可检索抽检。

    优先统计已配置 vault + 文件系统笔记数；并对首个可写 vault 做一次
    轻量 fulltext 抽检（命中记为 sample_hit），替代假的 retrievals=0。
    """
    db = get_db()
    docs = 0
    vaults = 0
    sample_hit = False
    sample_detail = ""

    # Vault configs via admin/store
    try:
        from evoflow.admin import knowledge as knowledge_admin

        listed = knowledge_admin.list_vaults()
        items = listed.get("vaults") or listed.get("items") or []
        vaults = int(listed.get("count") or len(items) or 0)
        # Count notes in first few vaults (list API name varies)
        for v in items[:5]:
            vid = str(v.get("id") or "").strip()
            if not vid:
                continue
            try:
                notes = knowledge_admin.list_knowledge(vault_id=vid, limit=200)
                note_items = notes.get("entries") or notes.get("items") or []
                docs += int(notes.get("total") or len(note_items) or 0)
            except Exception:  # noqa: BLE001
                pass
        # Fulltext sample on first vault
        if items:
            vid0 = str(items[0].get("id") or "").strip()
            try:
                probe = knowledge_admin.recall("a", vault_id=vid0 or None, mode="fulltext", limit=3)
                total = int(probe.get("total") or 0)
                entries = probe.get("entries") or probe.get("results") or []
                sample_hit = total > 0 or bool(entries)
                sample_detail = f"vault={vid0} total={total}"
            except Exception as exc:  # noqa: BLE001
                sample_detail = f"sample_error:{exc}"[:120]
    except Exception as exc:  # noqa: BLE001
        logger.debug("vault knowledge stats failed: %s", exc)

    # Fallback artifact/todo counts
    if docs == 0:
        if _table_exists(db, "evoflow_todos"):
            try:
                row = db.execute("SELECT COUNT(*) AS c FROM evoflow_todos").fetchone()
                if row:
                    docs += int(row["c"])
            except Exception:  # noqa: BLE001
                pass
        if _table_exists(db, "evoflow_artifacts"):
            try:
                row = db.execute("SELECT COUNT(*) AS c FROM evoflow_artifacts").fetchone()
                if row:
                    docs += int(row["c"])
            except Exception:  # noqa: BLE001
                pass

    # Score: vaults present + docs + sample hit
    score = 0.0
    if vaults > 0:
        score += 40.0
    if docs > 0:
        score += 40.0
    if sample_hit:
        score += 20.0

    return {
        "days": days,
        "knowledge_bases": vaults,
        "documents": docs,
        "retrievals": 1 if sample_hit else 0,
        "sample_hit": sample_hit,
        "sample_detail": sample_detail,
        "score": round(score, 1),
    }


# ---------------------------------------------------------------------------
# 列表接口
# ---------------------------------------------------------------------------

def list_task_rows(limit: int = 50, offset: int = 0, status: str | None = None) -> dict[str, Any]:
    """任务列表（基于 evoflow_mission_nodes）。"""
    db = get_db()
    limit = max(1, min(int(limit), 200))
    offset = max(0, int(offset))

    if _table_exists(db, "evoflow_mission_nodes"):
        cols = _columns(db, "evoflow_mission_nodes")
        where = ""
        params: list[Any] = []
        if status:
            where = "WHERE LOWER(status) = ?"
            params.append(str(status).strip().lower())
        sel_cols = [c for c in ("id", "thread_id", "kind", "title", "status", "priority", "updated_at") if c in cols]
        try:
            rows = db.execute(
                f"SELECT {', '.join(sel_cols)} FROM evoflow_mission_nodes {where} "
                f"ORDER BY id DESC LIMIT ? OFFSET ?",
                (*params, limit, offset),
            ).fetchall()
            items = [_row_to_dict(r, sel_cols) for r in rows]
            return {"total": len(items), "items": items}
        except Exception:  # noqa: BLE001
            return {"total": 0, "items": [], **_missing("evoflow_mission_nodes")}
    return {"total": 0, "items": [], **_missing("evoflow_mission_nodes")}


def list_tool_call_rows(limit: int = 50, tool_name: str | None = None) -> dict[str, Any]:
    """工具调用列表（基于 evoflow_chat_messages）。"""
    db = get_db()
    limit = max(1, min(int(limit), 200))

    if _table_exists(db, "evoflow_chat_messages"):
        cols = _columns(db, "evoflow_chat_messages")
        sel = [c for c in ("id", "session_key", "tool_name", "role", "model_name", "created_at_ms") if c in cols]
        if not sel:
            sel = ["id"]
        where = ""
        params: list[Any] = []
        if tool_name:
            where = "WHERE tool_name = ?"
            params.append(str(tool_name))
        if "tool_name" in cols:
            cond = where if where else "WHERE (tool_name IS NOT NULL AND tool_name <> '')"
            params2 = [*params, limit]
            try:
                rows = db.execute(
                    f"SELECT {', '.join(sel)} FROM evoflow_chat_messages {cond} "
                    f"ORDER BY id DESC LIMIT ?",
                    params2,
                ).fetchall()
                items = [_row_to_dict(r, sel) for r in rows]
                return {"total": len(items), "items": items}
            except Exception:  # noqa: BLE001
                return {"total": 0, "items": [], **_missing("evoflow_chat_messages")}
    return {"total": 0, "items": [], **_missing("evoflow_chat_messages")}
