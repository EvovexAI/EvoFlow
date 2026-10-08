"""H3-B-3 T1 (D1 c6): 一次性把 EvoFlow 业务会话历史从 sqlite 投影到 v4 hub。

EvoFlow 主对话流（AG-UI）已通过 ``langgraph_v4_bridge.feed_agui_events`` 实时
投影新产生的消息；T1 解决的是**老历史**——用户用过的旧业务 session 在 v4 hub
中无任何 row。V4ChatPane 订阅老 session 时 snapshot.rows=[] 空白，正是 T1
要堵的口。

数据源：``evoflow_chat_messages``（application-owned transcript，scalar columns
+ ``content_json`` body），业务 ``session_key`` 与 v4 hub 的 ``session_id`` 同名
（对齐 H3-B-3 桥接约定）。

启用方式：``EVOFLOW_T1_PROJECT=1``（启动钩子全量跑）+ 单 session 懒加载入口
``HUB.project_history(session_key)``（subscribe 时触发）。
"""

from __future__ import annotations

import json
import logging
import os
import time
import uuid
from typing import Any, Iterable

from .conversation import HUB, _PHASE_COMPLETED, _SessionState

logger = logging.getLogger(__name__)


def _enabled() -> bool:
    return os.getenv("EVOFLOW_T1_PROJECT", "").strip() in ("1", "true", "yes")


def _parse_content_json(raw: str | None) -> dict[str, Any]:
    """content_json 是 JSON 字符串（可能为空 / 损坏）。"""
    if not raw:
        return {}
    try:
        v = json.loads(raw)
        return v if isinstance(v, dict) else {}
    except (ValueError, TypeError):
        return {}


def _row_base(db_row: tuple, *, row_id: int, turn_id: str, created_at_seq: int) -> dict[str, Any]:
    """v4 行公共字段：rowId/turnId/createdAt(ms)/createdAtSeq。"""
    created_at_iso = str(db_row[14]) if len(db_row) > 14 and db_row[14] else ""
    # created_at = ISO Z 字符串 → 毫秒；解析失败则当前时间
    try:
        from datetime import datetime
        if created_at_iso.endswith("Z"):
            dt = datetime.strptime(created_at_iso, "%Y-%m-%dT%H:%M:%S.%fZ")
        else:
            dt = datetime.fromisoformat(created_at_iso.replace("Z", "+00:00"))
        created_ms = int(dt.timestamp() * 1000)
    except Exception:
        created_ms = int(time.time() * 1000)
    return {
        "rowId": row_id,
        "turnId": turn_id,
        "createdAt": created_ms,
        "createdAtSeq": created_at_seq,
    }


def _project_user_input(
    db_row: tuple, *, row_id: int, turn_id: str, created_at_seq: int
) -> dict[str, Any]:
    body = _parse_content_json(str(db_row[5]) if len(db_row) > 5 else None)
    text = str(body.get("content") or "")
    base = _row_base(db_row, row_id=row_id, turn_id=turn_id, created_at_seq=created_at_seq)
    return {**base, "kind": "userInput", "text": text, "origin": "realUser"}


def _project_assistant_text(
    db_row: tuple, *, row_id: int, turn_id: str, created_at_seq: int
) -> dict[str, Any]:
    body = _parse_content_json(str(db_row[5]) if len(db_row) > 5 else None)
    text = str(body.get("content") or "")
    model = str(db_row[11]) if len(db_row) > 11 and db_row[11] else None
    base = _row_base(db_row, row_id=row_id, turn_id=turn_id, created_at_seq=created_at_seq)
    out = {**base, "kind": "assistantText", "text": text, "state": "complete"}
    if model:
        out["model"] = model
    return out


def _project_tool_call(
    db_row: tuple, *, row_id: int, turn_id: str, created_at_seq: int
) -> dict[str, Any]:
    body = _parse_content_json(str(db_row[5]) if len(db_row) > 5 else None)
    tool_name = str(db_row[7]) if len(db_row) > 7 and db_row[7] else "unknown"
    tool_call_id = str(db_row[6]) if len(db_row) > 6 and db_row[6] else f"tc-{uuid.uuid4().hex[:8]}"
    content_text = str(body.get("content") or "")
    base = _row_base(db_row, row_id=row_id, turn_id=turn_id, created_at_seq=created_at_seq)
    return {
        **base,
        "kind": "toolCall",
        "toolCallId": tool_call_id,
        "toolName": tool_name,
        "status": "success",
        "inputText": content_text[:512],
        "output": {"kind": "text", "text": content_text} if content_text else None,
    }


def _iter_session_messages(conn, session_key: str) -> Iterable[tuple]:
    """按 seq 升序产出 (db row tuple)。schema 跟 chat_message_repositories 一致。

    SELECT 列顺序（与 db.py PRAGMA 对齐）：
      0:id 1:session_key 2:seq 3:role 4:message_id 5:content_json
      6:tool_call_id 7:tool_name 8:run_id 9:thread_id 10:parent_thread_id
      11:model_name 12:input_tokens 13:output_tokens 14:total_tokens
      15:created_at 16:updated_at 17:cache_read_tokens 18:cache_creation_tokens
      19:cache_miss_tokens 20:round_id 21:turn_started_at 22:turn_duration_ms
      23:turn_state
    """
    cur = conn.execute(
        """
        SELECT id, session_key, seq, role, message_id, content_json,
               tool_call_id, tool_name, run_id, thread_id, parent_thread_id,
               model_name, input_tokens, output_tokens, total_tokens,
               created_at, updated_at, cache_read_tokens, cache_creation_tokens,
               cache_miss_tokens, round_id, turn_started_at, turn_duration_ms,
               turn_state
        FROM evoflow_chat_messages
        WHERE session_key = ?
        ORDER BY seq ASC
        """,
        (session_key,),
    )
    return cur


def _project_session(session_key: str) -> int:
    """把单 session 历史投影进 v4 HUB；返回写入 row 数。

    跳过系统消息（v4 不显示 system）；tool_call 交互简化为 1 toolCall row
    （toolCallId 用 db tool_call_id；inputText / output 都进 content 文本）。
    多 user/assistant 配对 = 多 turn，每 userInput 之前先关上一 turn。
    """
    import sqlite3
    from evoflow.persistence.db import resolve_evolflow_db_path

    db_path = resolve_evolflow_db_path()
    if not db_path.exists():
        logger.warning("[t1] evoflow db 不存在: %s", db_path)
        return 0

    # 已在 hub 的 session 跳过（避免重复投影）
    if HUB.get_session(session_key) is not None and HUB.get_session(session_key).rows:
        logger.info("[t1] session=%s 已在 hub，跳过", session_key)
        return 0

    conn = sqlite3.connect(str(db_path))
    try:
        rows = list(_iter_session_messages(conn, session_key))
    finally:
        conn.close()
    if not rows:
        return 0

    sess = HUB._get_or_create_session(session_key)
    sess.external = True  # 标记为业务会话；sendText 走 read-only 分支

    # 决定起始 rowId / seq：取当前 hub 内最大值 + 1
    next_row_id = max(sess.rows.keys(), default=0) + 1
    next_seq = sess.seq + 1

    current_turn_id: str | None = None
    current_turn_started_ms: int | None = None
    current_turn_header_rid: int | None = None

    written = 0

    def _alloc_row_id() -> int:
        nonlocal next_row_id
        rid = next_row_id
        next_row_id += 1
        return rid

    def _alloc_seq() -> int:
        """单调递增的 seq（每行一次；先取后增）。"""
        sess.seq += 1
        return sess.seq

    def _append_row(row: dict[str, Any]) -> None:
        """sess.rows + revision + delta 广播。"""
        sess.revision += 1
        sess.rows[int(row["rowId"])] = row
        HUB._enqueue_deltas(sess, [{"op": "row.appended", "row": row}])

    def _open_turn(base_ms: int) -> None:
        """开新 turn：写 turnHeader。turnHeader.rowId = 上一 turn 末 + 1 之前是 user_rid - 1，
        实际 _alloc_row_id 拿一个独立 rowId（v4 _run_turn 是 turnHeader → userInput）"""
        nonlocal current_turn_id, current_turn_started_ms, current_turn_header_rid
        current_turn_id = f"turn-t1-{uuid.uuid4().hex[:10]}"
        current_turn_started_ms = base_ms
        current_turn_header_rid = _alloc_row_id()
        # createdAtSeq = 取下一个 seq（_alloc_seq 内部先 sess.seq += 1 再返回）
        cs = _alloc_seq()
        header = {
            "kind": "turnHeader",
            "rowId": current_turn_header_rid,
            "turnId": current_turn_id,
            "createdAt": base_ms,
            "createdAtSeq": cs,
            "origin": "userInput",
            "state": "completedSuccess",
            "startedAt": base_ms,
        }
        _append_row(header)
        written_local = 1
        return  # no-op to keep closure readability
        _ = written_local

    for db_row in rows:
        role = str(db_row[3] or "")
        if role == "system":
            continue  # v4 不显示

        db_seq = int(db_row[2] or 0)
        # 把 hub 的 seq 跟 db 的 seq 同步推进（不重不漏）
        if db_seq > sess.seq:
            sess.seq = db_seq

        if role == "user":
            base = _row_base(db_row, row_id=0, turn_id="", created_at_seq=0)
            _open_turn(base["createdAt"])
            # 在 turnHeader 之后写 userInput（沿用 v4 _run_turn 顺序：header → userInput → assistant）
            user_rid = _alloc_row_id()
            cs = _alloc_seq()
            user_row = _project_user_input(
                db_row, row_id=user_rid, turn_id=current_turn_id, created_at_seq=cs
            )
            _append_row(user_row)
            written += 2
            last_turn_user_text = str(user_row.get("text") or "")[:24]
            if not sess.title and last_turn_user_text:
                sess.title = last_turn_user_text
        elif role == "assistant":
            if current_turn_id is None:
                # 孤立的 assistant —— 跳过
                continue
            cs = _alloc_seq()
            rid = _alloc_row_id()
            a_row = _project_assistant_text(
                db_row, row_id=rid, turn_id=current_turn_id, created_at_seq=cs
            )
            _append_row(a_row)
            written += 1
        elif role == "tool":
            if current_turn_id is None:
                continue
            cs = _alloc_seq()
            rid = _alloc_row_id()
            t_row = _project_tool_call(
                db_row, row_id=rid, turn_id=current_turn_id, created_at_seq=cs
            )
            _append_row(t_row)
            written += 1
        else:
            continue

    # phase 收敛：老历史直接 completedSuccess
    sess.phase = _PHASE_COMPLETED
    logger.info("[t1] session=%s 投影完成 written=%d rows=%d", session_key, written, len(sess.rows))
    return written


def project_session_lazy(session_key: str) -> int:
    """单 session 懒加载入口（subscribe 时触发，已加载则秒返 0）。"""
    return _project_session(session_key)


def project_all_sessions() -> dict[str, int]:
    """启动钩子：全量扫 5,068 个 session 投影。返回 {session_key: written}。

    启动后第一次跑预计 3-5 分钟（5000 session × 34 平均 × 0.4ms = 1.5-2 分钟，
    含 sqlite read + JSON parse + v4 row 构造）。
    """
    import sqlite3
    from evoflow.persistence.db import resolve_evolflow_db_path

    db_path = resolve_evolflow_db_path()
    if not db_path.exists():
        logger.warning("[t1] evoflow db 不存在: %s", db_path)
        return {}

    conn = sqlite3.connect(str(db_path))
    try:
        cur = conn.execute(
            "SELECT DISTINCT session_key FROM evoflow_chat_sessions ORDER BY created_at"
        )
        keys = [r[0] for r in cur.fetchall()]
    finally:
        conn.close()
    logger.info("[t1] 全量开始: %d sessions", len(keys))

    results: dict[str, int] = {}
    t0 = time.time()
    for i, sk in enumerate(keys):
        try:
            written = _project_session(sk)
            results[sk] = written
        except Exception as exc:
            logger.exception("[t1] session=%s 投影失败", sk)
            results[sk] = 0
        if (i + 1) % 100 == 0:
            elapsed = time.time() - t0
            logger.info("[t1] 进度 %d/%d (%.1fs)", i + 1, len(keys), elapsed)
    logger.info("[t1] 全量完成: %d sessions, %.1fs", len(keys), time.time() - t0)
    return results
