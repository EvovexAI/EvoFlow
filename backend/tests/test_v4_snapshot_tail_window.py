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


def test_snapshot_tail_aligns_to_turn_boundary():
    """尾窗不得从上一轮半截 assistantText 开头——否则窗顶会挂旧结论。"""
    hub = V4ConversationHub()
    rows: list[dict] = []
    # 旧轮：header + user + 若干正文；新轮完整。
    rows.append({"rowId": 1, "kind": "turnHeader", "turnId": "old", "origin": "userInput"})
    rows.append(
        {
            "rowId": 2,
            "kind": "userInput",
            "turnId": "old",
            "text": "旧问",
            "origin": "realUser",
        }
    )
    for rid in range(3, 50):
        rows.append(
            {
                "rowId": rid,
                "kind": "assistantText",
                "turnId": "old",
                "text": f"old-{rid}",
                "state": "complete",
            }
        )
    rows.append({"rowId": 50, "kind": "turnHeader", "turnId": "new", "origin": "userInput"})
    rows.append(
        {
            "rowId": 51,
            "kind": "userInput",
            "turnId": "new",
            "text": "新问",
            "origin": "realUser",
        }
    )
    for rid in range(52, 52 + conv._SNAPSHOT_TAIL_ROWS):
        rows.append(
            {
                "rowId": rid,
                "kind": "toolCall",
                "turnId": "new",
                "toolName": f"t-{rid}",
            }
        )
    # 裸截断会落在 old 轮中部；对齐后必须从 turnHeader/new 起。
    window = V4ConversationHub._snapshot_tail_window(rows, pin_live_turn=False)
    assert window[0]["kind"] == "turnHeader"
    assert window[0]["turnId"] == "new"
    assert all(r.get("turnId") == "new" for r in window)


def test_live_turn_pin_keeps_early_assistant_text():
    """直播轮被尾窗截断时，不能只钉 header+user而丢掉已流出的 assistantText。"""
    hub = V4ConversationHub()
    rows: list[dict] = []
    rows.append({"rowId": 1, "kind": "turnHeader", "turnId": "live", "origin": "userInput"})
    rows.append(
        {
            "rowId": 2,
            "kind": "userInput",
            "turnId": "live",
            "text": "请继续",
            "origin": "realUser",
        }
    )
    rows.append(
        {
            "rowId": 3,
            "kind": "assistantText",
            "turnId": "live",
            "text": "先说一半",
            "state": "complete",
        }
    )
    for rid in range(4, 4 + conv._SNAPSHOT_TAIL_ROWS + 30):
        rows.append({"rowId": rid, "kind": "toolCall", "turnId": "live", "toolName": f"t{rid}"})
    rows.append(
        {
            "rowId": 1000,
            "kind": "assistantText",
            "turnId": "live",
            "text": "轮尾",
            "state": "streaming",
        }
    )
    # 模拟已被裁成「只剩工具尾」的窗口
    raw_tail = rows[-(conv._SNAPSHOT_TAIL_ROWS) :]
    pinned = V4ConversationHub._pin_live_turn_into_window(
        rows, raw_tail, soft_cap=conv._SNAPSHOT_TAIL_ROWS
    )
    texts = [str(r.get("text") or "") for r in pinned if r.get("kind") == "assistantText"]
    kinds = [str(r.get("kind") or "") for r in pinned]
    assert "userInput" in kinds
    assert "请继续" in [str(r.get("text") or "") for r in pinned]
    assert "轮尾" in texts
    # 头+尾模式下中段「先说一半」可能被挤掉；用户与轮尾不能丢
    assert pinned[0]["kind"] == "turnHeader"


def test_live_turn_pins_user_input_squeezed_out_of_tail():
    """流式长回合把 userInput 挤出尾窗后，切会话重订阅仍须看见本轮用户气泡。

    turnHeader 须落在对齐回看窗（40 行）之外，否则 idle 对齐也会把整轮头带回来——
    那是预期；本用例专测 pin_live_turn 在「头已被裁掉」时的钉回。
    """
    hub = V4ConversationHub()
    sess = hub._get_or_create_session("s-live-pin")
    # header/user 之后铺足够多工具，使 raw 尾窗与对齐回看都够不着它们。
    sess.rows[1] = {
        "rowId": 1,
        "kind": "turnHeader",
        "turnId": "turn-live",
        "origin": "userInput",
    }
    sess.rows[2] = {
        "rowId": 2,
        "kind": "userInput",
        "turnId": "turn-live",
        "text": "请继续排查切换丢气泡",
        "origin": "realUser",
    }
    tool_start = 3
    tool_end = tool_start + conv._SNAPSHOT_TAIL_ROWS + 50
    for rid in range(tool_start, tool_end):
        sess.rows[rid] = {
            "rowId": rid,
            "kind": "toolCall",
            "turnId": "turn-live",
            "toolName": f"tool-{rid}",
        }
    sess.phase = "running"
    sess.control_override = {
        "phase": "running",
        "sessionEnded": False,
        "canStop": True,
        "stopState": "stoppable",
        "stopTargetKind": "assistant",
        "activeWorks": [{"kind": "primaryTurn", "startedAt": 1}],
        "lastError": None,
        "apiRetry": None,
    }

    window = hub._build_snapshot(sess)["rows"]["window"]
    kinds = [str(r.get("kind") or "") for r in window]
    texts = [str(r.get("text") or "") for r in window if str(r.get("kind") or "") == "userInput"]

    assert "userInput" in kinds
    assert "请继续排查切换丢气泡" in texts
    # idle：头已在对齐回看之外 → 不得靠 pin 留下用户气泡
    sess.phase = "completed"
    sess.control_override = None
    idle_window = hub._build_snapshot(sess)["rows"]["window"]
    idle_texts = [
        str(r.get("text") or "")
        for r in idle_window
        if str(r.get("kind") or "") == "userInput"
    ]
    assert "请继续排查切换丢气泡" not in idle_texts
    assert idle_window[0]["kind"] != "turnHeader" or idle_window[0].get("rowId") != 1
