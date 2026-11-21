"""v4 冷订阅 durable 尾差重放（对齐 ZCode durable 语义的读回侧）。

背景：投影的权威历史有两级——transcript（语义内容，重启后水合重建）与
``evoflow_v4_event_log``（逐条 delta 档案）。水合只覆盖 transcript 里落库过的
消息；镜像 authored 但 transcript 不含的行（空流占位修正、迟到正文、断流瞬态、
下一轮的开头）会在网关重启/清投影后消失。

这里在水合之后做**尾差补齐**：

1. 边界 = 档案里最后一次「turnHeader 终态 upsert」（completedSuccess/failed/…）
   的 seq——其前的行已由 transcript 覆盖（轮收口即落库），其后是未落库尾差；
2. 尾差事件按 (epoch, seq) 顺序重放：``row.appended``/``row.upserted`` 分配新
   rowId 写入（旧 rowId 空间随 hub 生命周期作废，不可复用）；``row.delta`` 按
   重放映射追加；``state.updated`` 跳过（phase 由 catchup 收口管）；
3. 身份去重：``(kind, entityId)`` 或 ``(kind, text)`` 与水合行相同 → 跳过
   （防 transcript 已覆盖又重放一份）；
4. 收尾：仍在 running 的 turnHeader 封为 failed（网关重启轮次中断），
   ``next_row_id`` 接续重放后的最大 rowId。

守卫：镜像仍在本线程活写（``mirror_thread_is_live``）时禁止重放——会与 live
mirror 对打（同 catchup 的 reset_mirror=False 理由）。
"""

from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger(__name__)

_TERMINAL_HEADER_STATES = {"completedSuccess", "failed", "completedInterrupted", "error"}


def read_durable_head(hub: Any, tid: str) -> dict[str, Any] | None:
    """读事件档案的续接点：该会话最新 epoch 与其最大 seq（跨进程重启续写用）。

    返回 None = 档案无该会话记录（新会话/档案被清），调用方维持默认纪元。
    """
    tid = str(tid or "").strip()
    if not tid:
        return None
    try:
        from evoflow.persistence.v4_event_log_repositories import list_v4_event_log

        events = list_v4_event_log(tid, after_seq=0, limit=5000)
    except Exception:
        logger.warning("[v4.durable-replay] head read failed session=%s", tid, exc_info=True)
        return None
    if not events:
        return None
    best: dict[str, Any] | None = None
    for ev in events:
        epoch = str(ev.get("logEpoch") or ev.get("log_epoch") or "").strip()
        seq = int(ev.get("seq") or 0)
        try:
            epoch_num = int(epoch) if epoch.isdigit() else 0
        except ValueError:
            epoch_num = 0
        if best is None or epoch_num > int(best.get("_epoch_num") or 0) or (
            epoch == best.get("epoch") and seq > int(best.get("seq") or 0)
        ):
            best = {"epoch": epoch, "seq": seq, "_epoch_num": epoch_num}
    if best is not None:
        best.pop("_epoch_num", None)
    return best


def _row_identity(row: dict[str, Any]) -> tuple[str, str] | None:
    kind = str(row.get("kind") or "").strip()
    if not kind:
        return None
    eid = str(row.get("entityId") or "").strip()
    if eid:
        return (kind, f"eid:{eid}")
    text = str(row.get("text") or "").strip()
    if text:
        return (kind, f"text:{text[:200]}")
    return None


def replay_durable_tail(hub: Any, tid: str) -> int:
    """冷订阅水合后，从事件档案补放 transcript 之后的镜像行。返回补放行数。"""
    tid = str(tid or "").strip()
    if not tid:
        return 0
    try:
        from app.gateway.v4.agui_mirror import mirror_thread_is_live

        if mirror_thread_is_live(tid):
            return 0
    except Exception:
        pass

    from app.gateway.v4.conversation import HUB
    from evoflow.persistence.v4_event_log_repositories import list_v4_event_log

    sess = hub.get_session(tid)
    if sess is None:
        return 0

    try:
        events = list_v4_event_log(tid, after_seq=0, limit=5000)
    except Exception:
        logger.warning("[v4.durable-replay] list failed session=%s", tid, exc_info=True)
        return 0
    if not events:
        return 0

    # 边界：最后一次 turnHeader 终态 upsert 的档案 seq。其前 = transcript 已覆盖。
    # payload 形状：author_deltas 逐条落库 → 单 delta 字典；兼容 {deltas:[...]} 包装
    # 与「仓库层已解析成 dict / 仍是 JSON 字符串」两种返回形态。
    def _iter_deltas(payload_raw: Any):
        payload = payload_raw
        if isinstance(payload, (str, bytes)):
            try:
                payload = json.loads(payload or "{}")
            except Exception:
                return
        if isinstance(payload, dict) and isinstance(payload.get("deltas"), list):
            yield from payload["deltas"]
            return
        if isinstance(payload, dict):
            yield payload

    boundary_seq = 0
    for ev in events:
        for d in _iter_deltas(ev.get("payload") or ""):
            row = d.get("row") or {}
            if (
                d.get("op") in ("row.appended", "row.upserted")
                and str(row.get("kind") or "") == "turnHeader"
                and str(row.get("state") or "") in _TERMINAL_HEADER_STATES
            ):
                boundary_seq = int(ev.get("seq") or 0)
    tail = [ev for ev in events if int(ev.get("seq") or 0) > boundary_seq]
    if not tail:
        return 0

    applied = 0
    remap: dict[int, int] = {}
    identities: set[tuple[str, str]] = set()
    max_row_id = 0
    try:
        with hub._write_lock:  # noqa: SLF001 — 同包协作单例
            for row in sess.rows.values():
                rid = int(row.get("rowId") or 0)
                if rid > max_row_id:
                    max_row_id = rid
                ident = _row_identity(row)
                if ident:
                    identities.add(ident)
            for ev in tail:
                for d in _iter_deltas(ev.get("payload") or ""):
                    op = str(d.get("op") or "")
                    if op in ("row.appended", "row.upserted"):
                        row = d.get("row") or {}
                        if not isinstance(row, dict) or not str(row.get("kind") or ""):
                            continue
                        ident = _row_identity(row)
                        if ident and ident in identities:
                            continue
                        old_rid = int(row.get("rowId") or 0)
                        new_rid = sess.next_row_id
                        sess.next_row_id += 1
                        row["rowId"] = new_rid
                        sess.rows[new_rid] = row
                        sess.seq += 1
                        sess.delta_log.append(
                            (sess.seq, {"op": "row.appended", "row": row})
                        )
                        if old_rid:
                            remap[old_rid] = new_rid
                        if ident:
                            identities.add(ident)
                        max_row_id = max(max_row_id, new_rid)
                        applied += 1
                    elif op == "row.delta":
                        rid = int(d.get("rowId") or 0)
                        target = remap.get(rid)
                        if target is None or target not in sess.rows:
                            continue
                        append_text = str(d.get("append") or "")
                        if d.get("path") == "text" and append_text:
                            row = sess.rows[target]
                            row["text"] = str(row.get("text") or "") + append_text
                            sess.seq += 1
                            sess.delta_log.append(
                                (sess.seq, {"op": "row.delta", "rowId": target, "path": "text", "append": append_text})
                            )
                            applied += 1
                    elif op == "row.removed":
                        rid = int(d.get("fromRowId") or d.get("rowId") or 0)
                        target = remap.get(rid)
                        if target is not None and target in sess.rows:
                            sess.rows.pop(target, None)
                            sess.seq += 1
                            sess.delta_log.append((sess.seq, {"op": "row.removed", "fromRowId": target}))
                            applied += 1
                    # state.updated：phase 归 catchup 收口管，重放不碰。
            # 收尾：重放进来的 running 轮已经没有活写手，封为中断。
            for row in sess.rows.values():
                if (
                    str(row.get("kind") or "") == "turnHeader"
                    and str(row.get("state") or "") == "running"
                ):
                    row["state"] = "failed"
                    row["errorMessage"] = "网关重启，轮次中断"
                    sess.seq += 1
                    sess.delta_log.append(
                        (sess.seq, {"op": "row.upserted", "row": dict(row)})
                    )
                    applied += 1
            if sess.rows:
                sess.next_row_id = max(
                    sess.next_row_id,
                    max(int(r.get("rowId") or 0) for r in sess.rows.values()) + 1,
                )
    except Exception:
        logger.exception("[v4.durable-replay] replay failed session=%s", tid)
        return applied

    if applied:
        logger.info(
            "[v4.durable-replay] tail replayed session=%s applied=%s boundary_seq=%s",
            tid,
            applied,
            boundary_seq,
        )
    return applied
