"""v4 快照尾部窗口化：rowsWindowSchema 截断语义落地。

背景：协议（zcode-protocol-v4/snapshot.ts）与前端投影层从一开始就按
「window=尾部窗口、totalCount=全序行数、firstRowId=全序首行」设计，前端
loadOlder 沿 rows/range 游标补拉更早行（含纪元/游标失效保护与 prepend
滚动锚位）。旧 _build_snapshot 从未截断，176 行会话一次推 ~598KiB 帧。

契约：
- 短会话（≤ tail rows）快照 window 与全量等价；
- 长会话 window 只含尾部窗口，totalCount/firstRowId 仍指向全序；
- delta/订阅记账与窗口内容解耦：快照帧 toSeq == sess.seq；
- 窗口首行 ≠ firstRowId ⇔ hasOlderRows（前端游标补拉判定）成立；
- rows/range 沿窗口首行可补齐全部更早行（hasMore 终止）；
- 字节预算超限对半收缩窗口（下限 20 行），尾部行保证在窗口内。
"""

from __future__ import annotations

import json

import pytest

from app.gateway.v4 import conversation as conv
from app.gateway.v4.conversation import V4ConversationHub


def _row(rid: int, text: str = "body") -> dict:
    return {"rowId": rid, "kind": "message", "turnId": f"t{rid}", "text": text}


def _seed_rows(hub: V4ConversationHub, session_id: str, count: int) -> dict:
    sess = hub._get_or_create_session(session_id)
    for rid in range(1, count + 1):
        sess.rows[rid] = _row(rid)
    return sess


def test_short_session_snapshot_window_equals_full_rows():
    hub = V4ConversationHub()
    sess = _seed_rows(hub, "s-short", 10)

    snap = hub._build_snapshot(sess)

    assert snap["rows"]["totalCount"] == 10
    assert snap["rows"]["firstRowId"] == 1
    assert [r["rowId"] for r in snap["rows"]["window"]] == list(range(1, 11))
    # 已到顶：窗口首行 == 全序首行 ⇔ 前端无更早行可补拉。
    assert snap["rows"]["window"][0]["rowId"] == snap["rows"]["firstRowId"]


def test_long_session_snapshot_window_is_tail_and_bookkeeping_is_full():
    hub = V4ConversationHub()
    sess = _seed_rows(hub, "s-long", 176)

    snap = hub._build_snapshot(sess)
    window = snap["rows"]["window"]

    assert len(window) == conv._SNAPSHOT_TAIL_ROWS
    assert [r["rowId"] for r in window] == list(range(176 - conv._SNAPSHOT_TAIL_ROWS + 1, 177))
    assert snap["rows"]["totalCount"] == 176
    assert snap["rows"]["firstRowId"] == 1
    # hasOlderRows 判定：窗口首行 > 全序首行 ⇔ 存在可补拉的更早行。
    assert window[0]["rowId"] > snap["rows"]["firstRowId"]


def test_rows_range_backfills_everything_above_tail_window():
    hub = V4ConversationHub()
    sess = _seed_rows(hub, "s-backfill", 176)
    snap = hub._build_snapshot(sess)
    cursor = snap["rows"]["window"][0]["rowId"]

    page = hub.rows_range("s-backfill", before_row_id=cursor, limit=200)

    assert [r["rowId"] for r in page["rows"]] == list(range(1, cursor))
    assert page["hasMore"] is False
    assert page["atLogEpoch"] == sess.log_epoch


@pytest.mark.asyncio
async def test_subscribe_snapshot_frame_seq_accounting_independent_of_window():
    hub = V4ConversationHub()
    sess = _seed_rows(hub, "s-sub", 176)

    ack = await hub.subscribe(connection_id="conn-1", session_id="s-sub")
    assert ack["ack"]["mode"] == "snapshot"

    sub = hub._subscriptions[ack["ack"]["subscriptionId"]]
    assert len(sub.queue) == 1
    frame = sub.queue[0]["frame"]
    snap = frame["payload"]["snapshot"]
    # 记账解耦：快照帧水位始终是全序 seq，与窗口行数无关。
    assert frame["fromSeq"] == 0
    assert frame["toSeq"] == sess.seq
    assert len(snap["rows"]["window"]) == conv._SNAPSHOT_TAIL_ROWS


@pytest.mark.asyncio
async def test_resume_replay_unaffected_by_window_truncation():
    hub = V4ConversationHub()
    sess = _seed_rows(hub, "s-resume", 176)
    # 先发一帧 delta 产生保留窗记录，再以 base=旧水位 重订阅 → resume 而非 snapshot。
    hub.author_append_row("s-resume", {"rowId": 999, "kind": "message", "turnId": "t999"})

    base = {"logEpoch": sess.log_epoch, "seq": sess.seq - 1}
    ack = await hub.subscribe(connection_id="conn-2", session_id="s-resume", base=base)

    assert ack["ack"]["mode"] == "resume"
    sub = hub._subscriptions[ack["ack"]["subscriptionId"]]
    frame = sub.queue[0]["frame"]
    assert frame["fromSeq"] == sess.seq - 1
    assert frame["toSeq"] == sess.seq


def test_byte_budget_shrinks_window_to_floor():
    hub = V4ConversationHub()
    sess = _seed_rows(hub, "s-fat", 176)
    # 单行 1.2×预算：任何含它的窗口都超限 → 一路收缩到下限 20 行仍超限也照发。
    giant = "x" * int(conv._SNAPSHOT_MAX_BYTES * 1.2)
    sess.rows[176] = _row(176, giant)

    window = hub._build_snapshot(sess)["rows"]["window"]

    assert len(window) == conv._SNAPSHOT_MIN_TAIL_ROWS
    assert window[-1]["rowId"] == 176
    assert len(json.dumps(window, ensure_ascii=False)) > conv._SNAPSHOT_MAX_BYTES


def test_byte_budget_within_limit_keeps_tail_rows():
    hub = V4ConversationHub()
    sess = _seed_rows(hub, "s-thin", 176)

    window = hub._build_snapshot(sess)["rows"]["window"]

    assert len(window) == conv._SNAPSHOT_TAIL_ROWS
