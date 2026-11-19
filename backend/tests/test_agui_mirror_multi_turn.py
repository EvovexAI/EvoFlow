"""agui_mirror 多轮闩锁：RUN_FINISHED 后必须清 run_started，下一轮才能开 running turnHeader。"""

from __future__ import annotations

from typing import Any

import pytest

from app.gateway.v4.agui_mirror import V4Mirror
from app.gateway.v4.conversation import HUB


def _rows(session_id: str) -> list[dict[str, Any]]:
    sess = HUB.get_session(session_id)
    assert sess is not None
    return sorted(sess.rows.values(), key=lambda r: int(r["rowId"]))


def _headers(session_id: str) -> list[dict[str, Any]]:
    return [r for r in _rows(session_id) if r.get("kind") == "turnHeader"]


@pytest.fixture()
def mirror_session(monkeypatch: pytest.MonkeyPatch) -> str:
    # 确保镜像开启（环境可能在 CI 关掉）
    monkeypatch.setattr("app.gateway.v4.agui_mirror._MIRROR_DISABLED", False)
    # 单测要立刻断言占位；生产默认延后 2.5s 防「先闪未产出」
    monkeypatch.setattr("app.gateway.v4.agui_mirror._EMPTY_RUN_DEFER_SEC", 0.0)
    sid = "mirror-multi-turn-test"
    # 清掉同名会话，避免跨用例污染
    if sid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[sid]  # noqa: SLF001
    return sid


def test_empty_stream_retry_does_not_duplicate_user_input(mirror_session: str) -> None:
    """空流 auto-retry：同 message_id 再 note + RUN_STARTED 不得叠第二颗用户气泡。

    用户日志（EvoFlow-logs-20261101-180035）：模型无 SSE → empty stream auto-retry
    → RUN_STARTED while prior turn open → 界面出现两次「你好」。
    """
    tid = mirror_session + "-empty-retry"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    mirror = V4Mirror(HUB)

    mirror.note_user_input(tid, "你好", message_id="user-msg-1")
    mirror.feed_events(
        tid,
        [{"type": "RUN_STARTED", "threadId": tid, "runId": "run-first"}],
    )
    # 无 RUN_FINISHED：闩锁仍开（空流 / Failed to fetch）
    mirror.note_user_input(tid, "你好", message_id="user-msg-1")
    mirror.feed_events(
        tid,
        [{"type": "RUN_STARTED", "threadId": tid, "runId": "run-retry"}],
    )

    users = [r for r in _rows(tid) if r.get("kind") == "userInput"]
    assert len(users) == 1, users
    assert users[0]["text"] == "你好"
    assert users[0]["entityId"] == "user-msg-1"
    assert users[0]["turnId"] == "run-retry"

    headers = _headers(tid)
    assert len(headers) == 2
    assert headers[0]["turnId"] == "run-first"
    assert headers[0]["state"] == "failed"
    # 用户气泡已挂到 run-retry：旧头不得再自称 userInput（否则 !NO_USER）
    assert headers[0]["origin"] == "goalContinuation"
    assert headers[1]["turnId"] == "run-retry"
    assert headers[1]["state"] == "running"


def test_steal_user_from_completed_turn_demotes_old_header(mirror_session: str) -> None:
    """已完成轮的 userInput 被挂到新 run 后，旧头必须降成 goalContinuation。

    现场诊断：#1 turnHeader(origin=userInput)+assistant 无用户；#2 user.rowId < header。
    """
    tid = mirror_session + "-steal-completed"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    mirror = V4Mirror(HUB)

    mirror.note_user_input(tid, "欢迎一下", message_id="user-msg-welcome")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "8c5caa19-8390-4aaa-bbbb-cccccccccccc"},
            {"type": "TEXT_MESSAGE_START", "messageId": "m-welcome"},
            {
                "type": "TEXT_MESSAGE_CONTENT",
                "messageId": "m-welcome",
                "delta": "哈哈，欢迎欢迎",
            },
            {"type": "TEXT_MESSAGE_END", "messageId": "m-welcome"},
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "8c5caa19-8390-4aaa-bbbb-cccccccccccc"},
        ],
    )
    # 同 message_id 再开新 run（retry / 乱序 START）：用户气泡挂走，旧头曾变成 !NO_USER
    mirror.note_user_input(tid, "欢迎一下", message_id="user-msg-welcome")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-e0d357f6"},
            {"type": "TEXT_MESSAGE_START", "messageId": "m2"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m2", "delta": "在的，随时说。"},
            {"type": "TEXT_MESSAGE_END", "messageId": "m2"},
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-e0d357f6"},
        ],
    )

    users = [r for r in _rows(tid) if r.get("kind") == "userInput"]
    assert len(users) == 1
    assert users[0]["turnId"] == "run-e0d357f6"

    headers = {h["turnId"]: h for h in _headers(tid)}
    assert headers["8c5caa19-8390-4aaa-bbbb-cccccccccccc"]["origin"] == "goalContinuation"
    assert headers["run-e0d357f6"]["origin"] == "userInput"
    assert headers["run-e0d357f6"]["state"] == "completedSuccess"


def test_prior_reset_without_user_reuses_turn_not_orphan_header(mirror_session: str) -> None:
    """漏 FINISHED 后又来 RUN_STARTED、且没有新用户输入：必须续挂同一轮。

    回归：否则会落 turnHeader(origin=userInput) 却无 userInput，左侧像 AI 回复被劈成两截
    （浮层右栏有头无气泡，左栏两段助手内容中间没有用户消息）。
    """
    tid = mirror_session + "-cont-no-user"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    mirror = V4Mirror(HUB)

    mirror.note_user_input(tid, "不行 你还是想想方案", message_id="u-cont-1")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-a"},
            {"type": "TEXT_MESSAGE_START", "messageId": "m-a"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m-a", "delta": "先拆成本"},
            {"type": "TEXT_MESSAGE_END", "messageId": "m-a"},
            # 故意不发 RUN_FINISHED
        ],
    )
    # 内部续跑 / 漏闩：新 runId，不再 note_user_input
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-b"},
            {"type": "TEXT_MESSAGE_START", "messageId": "m-b"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m-b", "delta": "找到真正优化点"},
            {"type": "TEXT_MESSAGE_END", "messageId": "m-b"},
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-b"},
        ],
    )

    headers = _headers(tid)
    assert len(headers) == 1, headers
    assert headers[0]["turnId"] == "run-a"
    assert headers[0]["state"] == "completedSuccess"

    users = [r for r in _rows(tid) if r.get("kind") == "userInput"]
    assert len(users) == 1, users
    assert users[0]["turnId"] == "run-a"

    texts = [r for r in _rows(tid) if r.get("kind") == "assistantText"]
    assert len(texts) == 2
    assert {t["turnId"] for t in texts} == {"run-a"}
    assert [t["text"] for t in texts] == ["先拆成本", "找到真正优化点"]


def test_run_started_without_user_uses_goal_continuation_origin(mirror_session: str) -> None:
    """冷启动无 note_user_input：turnHeader 不得冒充 origin=userInput。"""
    tid = mirror_session + "-no-note"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    mirror = V4Mirror(HUB)
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-orphan"},
            {"type": "TEXT_MESSAGE_START", "messageId": "m1"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": "旁观"},
            {"type": "TEXT_MESSAGE_END", "messageId": "m1"},
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-orphan"},
        ],
    )
    headers = _headers(tid)
    assert len(headers) == 1
    assert headers[0]["origin"] == "goalContinuation"
    assert [r for r in _rows(tid) if r.get("kind") == "userInput"] == []


def test_mirror_reset_then_run_without_user_reuses_hub_turn(mirror_session: str) -> None:
    """catchup/remint 会 mirror_reset 清掉 last_turn_id；无 note 的续跑仍须挂回 hub 上一轮。

    否则左栏劈成两截，右栏第二截只有 turnHeader(origin=goalContinuation)。
    """
    from app.gateway.v4.agui_mirror import mirror_reset_thread

    tid = mirror_session + "-reset-cont"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    mirror = V4Mirror(HUB)

    mirror.note_user_input(tid, "继续", message_id="u-reset-1")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-first"},
            {"type": "TEXT_MESSAGE_START", "messageId": "m1"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": "先补证据"},
            {"type": "TEXT_MESSAGE_END", "messageId": "m1"},
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-first"},
        ],
    )
    mirror_reset_thread(tid)  # 模拟 catchup 前清状态
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-01a1e755"},
            {"type": "TEXT_MESSAGE_START", "messageId": "m2"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m2", "delta": "收口。计数核对无误"},
            {"type": "TEXT_MESSAGE_END", "messageId": "m2"},
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-01a1e755"},
        ],
    )

    headers = _headers(tid)
    assert len(headers) == 1, headers
    assert headers[0]["turnId"] == "run-first"
    assert headers[0]["origin"] == "userInput"
    users = [r for r in _rows(tid) if r.get("kind") == "userInput"]
    assert len(users) == 1
    texts = [r for r in _rows(tid) if r.get("kind") == "assistantText"]
    assert [t["text"] for t in texts] == ["先补证据", "收口。计数核对无误"]
    assert {t["turnId"] for t in texts} == {"run-first"}


def test_finished_then_run_without_user_reuses_turn(mirror_session: str) -> None:
    """RUN_FINISHED 清闩后若再来无 note 的 RUN_STARTED：必须续挂同一轮。

    浮层实锤：#6 有用户气泡，#7 仅 turnHeader(origin=userInput)+reasoning/tools，
    左栏被劈成两截。根因是 FINISHED 后内部续跑又开了假新轮。
    """
    tid = mirror_session + "-finished-cont"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    mirror = V4Mirror(HUB)

    mirror.note_user_input(tid, "OK，我已经重新重启了，你再试试", message_id="u-fin-1")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-15a19511"},
            {"type": "TEXT_MESSAGE_START", "messageId": "m-mid"},
            {
                "type": "TEXT_MESSAGE_CONTENT",
                "messageId": "m-mid",
                "delta": "现在已经查清。",
            },
            {"type": "TEXT_MESSAGE_END", "messageId": "m-mid"},
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-15a19511"},
        ],
    )
    # 正常收口后再内部续跑，且没有 note_user_input
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-01a1e8c1"},
            {"type": "TEXT_MESSAGE_START", "messageId": "m-final"},
            {
                "type": "TEXT_MESSAGE_CONTENT",
                "messageId": "m-final",
                "delta": "1. 结论 这次重启后检索确实正常",
            },
            {"type": "TEXT_MESSAGE_END", "messageId": "m-final"},
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-01a1e8c1"},
        ],
    )

    headers = _headers(tid)
    assert len(headers) == 1, headers
    assert headers[0]["turnId"] == "run-15a19511"
    assert headers[0]["origin"] == "userInput"

    users = [r for r in _rows(tid) if r.get("kind") == "userInput"]
    assert len(users) == 1, users
    assert users[0]["turnId"] == "run-15a19511"

    texts = [r for r in _rows(tid) if r.get("kind") == "assistantText"]
    assert len(texts) == 2
    assert {t["turnId"] for t in texts} == {"run-15a19511"}
    assert [t["text"] for t in texts] == [
        "现在已经查清。",
        "1. 结论 这次重启后检索确实正常",
    ]



def test_text_after_early_finished_reattaches_to_user_turn(mirror_session: str) -> None:
    """中途 RUN_FINISHED 清 turn_id 后，迟到 TEXT_* 必须挂回用户轮，不能写成空 turnId 孤儿。

    浮层实锤：turnHeader(completedSuccess)+userInput「重启好了」，无 assistantText——
    AI 已回复但投影/页面都看不到。
    """
    tid = mirror_session + "-late-text"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    mirror = V4Mirror(HUB)

    mirror.note_user_input(tid, "重启好了", message_id="u-late-1")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-early-finish"},
            # 工具循环中间误发 FINISHED：闩锁清掉，尚无正文
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-early-finish"},
        ],
    )
    headers = _headers(tid)
    assert len(headers) == 1
    assert headers[0]["state"] == "completedSuccess"
    assert headers[0]["turnId"] == "run-early-finish"
    # 空跑 FINISHED 必须落可见占位，不能只剩用户气泡
    notices = [
        r
        for r in _rows(tid)
        if r.get("kind") == "assistantText"
        and str(r.get("entityId") or "").startswith("empty-run-")
    ]
    assert len(notices) == 1, notices

    # 无新 RUN_STARTED：迟到正文仍应挂回同一用户轮，并撤掉空跑占位
    mirror.feed_events(
        tid,
        [
            {"type": "TEXT_MESSAGE_START", "messageId": "m-late"},
            {
                "type": "TEXT_MESSAGE_CONTENT",
                "messageId": "m-late",
                "delta": "收到，继续。",
            },
            {"type": "TEXT_MESSAGE_END", "messageId": "m-late"},
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-late-seal"},
        ],
    )

    texts = [
        r
        for r in _rows(tid)
        if r.get("kind") == "assistantText"
        and not str(r.get("entityId") or "").startswith("empty-run-")
        and str(r.get("text") or "").strip()
    ]
    assert len(texts) == 1, texts
    assert texts[0]["turnId"] == "run-early-finish"
    assert texts[0]["text"] == "收到，继续。"
    assert texts[0]["state"] == "complete"
    assert all(str(r.get("turnId") or "").strip() for r in texts)

    users = [r for r in _rows(tid) if r.get("kind") == "userInput"]
    assert len(users) == 1
    assert users[0]["turnId"] == "run-early-finish"
    assert _headers(tid)[0]["state"] == "completedSuccess"


def test_empty_finished_writes_visible_notice(mirror_session: str) -> None:
    """用户发了消息但空流 FINISHED：必须有助手占位，禁止 !EMPTY_ASSISTANT 静默成功。"""
    tid = mirror_session + "-empty-notice"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    mirror = V4Mirror(HUB)
    mirror.note_user_input(tid, "太慢了", message_id="u-empty-1")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-empty"},
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-empty"},
        ],
    )
    texts = [r for r in _rows(tid) if r.get("kind") == "assistantText"]
    assert len(texts) == 1
    assert str(texts[0].get("entityId") or "").startswith("empty-run-")
    assert "未产出可见回复" in str(texts[0].get("text") or "")
    assert texts[0]["turnId"] == "run-empty"


def test_deferred_empty_run_cancelled_by_late_text(
    mirror_session: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """过早 FINISHED 后马上迟到 TEXT：延时占位必须取消，禁止先闪「未产出」。"""
    import time

    monkeypatch.setattr("app.gateway.v4.agui_mirror._EMPTY_RUN_DEFER_SEC", 0.35)
    tid = mirror_session + "-defer-cancel"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    mirror = V4Mirror(HUB)
    mirror.note_user_input(tid, "hi", message_id="u-defer-1")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-defer"},
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-defer"},
        ],
    )
    # 延时期间尚无占位
    assert not [
        r
        for r in _rows(tid)
        if r.get("kind") == "assistantText"
        and str(r.get("entityId") or "").startswith("empty-run-")
    ]
    mirror.feed_events(
        tid,
        [
            {"type": "TEXT_MESSAGE_START", "messageId": "m-defer"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m-defer", "delta": "在的"},
            {"type": "TEXT_MESSAGE_END", "messageId": "m-defer"},
        ],
    )
    time.sleep(0.45)
    notices = [
        r
        for r in _rows(tid)
        if r.get("kind") == "assistantText"
        and str(r.get("entityId") or "").startswith("empty-run-")
        and not str(r.get("entityId") or "").startswith("empty-run-cleared-")
    ]
    assert notices == []
    texts = [
        r
        for r in _rows(tid)
        if r.get("kind") == "assistantText" and str(r.get("text") or "").strip() == "在的"
    ]
    assert len(texts) == 1


def test_second_run_gets_fresh_running_turn_header(mirror_session: str) -> None:
    tid = mirror_session
    mirror = V4Mirror(HUB)

    mirror.note_user_input(tid, "第一问")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-1"},
            {"type": "TEXT_MESSAGE_START", "messageId": "m1"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": "答一"},
            {"type": "TEXT_MESSAGE_END", "messageId": "m1"},
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-1"},
        ],
    )
    h1 = _headers(tid)
    assert len(h1) == 1
    assert h1[0]["state"] == "completedSuccess"
    assert h1[0]["turnId"] == "run-1"

    mirror.note_user_input(tid, "第二问")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-2"},
            {"type": "TEXT_MESSAGE_START", "messageId": "m2"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m2", "delta": "答"},
        ],
    )
    headers = _headers(tid)
    assert len(headers) == 2, "第二轮必须新建 turnHeader，不能挂在旧 completed 头上"
    live = headers[-1]
    assert live["turnId"] == "run-2"
    assert live["state"] == "running", live

    texts = [r for r in _rows(tid) if r.get("kind") == "assistantText" and r.get("turnId") == "run-2"]
    assert len(texts) == 1
    assert texts[0]["state"] == "streaming"
    # row.delta 不回写 sess.rows；END 才用 text_acc 全量 upsert。
    mirror.feed_events(
        tid,
        [
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m2", "delta": "二"},
            {"type": "TEXT_MESSAGE_END", "messageId": "m2"},
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-2"},
        ],
    )
    texts_done = [r for r in _rows(tid) if r.get("kind") == "assistantText" and r.get("turnId") == "run-2"]
    assert texts_done[0]["text"] == "答二"
    assert texts_done[0]["state"] == "complete"
    assert _headers(tid)[-1]["state"] == "completedSuccess"

    users = [r for r in _rows(tid) if r.get("kind") == "userInput"]
    assert [u["text"] for u in users] == ["第一问", "第二问"]
    assert users[1]["turnId"] == "run-2"


def test_tool_name_preserved_on_result_without_name(mirror_session: str) -> None:
    tid = mirror_session + "-tool"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    mirror = V4Mirror(HUB)
    mirror.note_user_input(tid, "写文件")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-t"},
            {
                "type": "TOOL_CALL_START",
                "toolCallId": "tc1",
                "toolCallName": "write",
            },
            {"type": "TOOL_CALL_ARGS", "toolCallId": "tc1", "delta": '{"path":"a.md"}'},
            {"type": "TOOL_CALL_END", "toolCallId": "tc1"},
            {
                "type": "TOOL_CALL_RESULT",
                "toolCallId": "tc1",
                "content": "OK",
                "status": "success",
            },
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-t"},
        ],
    )
    tool = next(r for r in _rows(tid) if r.get("kind") == "toolCall")
    assert tool["toolName"] == "write", tool
    assert tool["status"] == "success"


def test_pending_approval_underscore_maps_to_pendingApproval(mirror_session: str) -> None:
    """AG-UI 发 pending_approval（下划线）；镜像必须落成 pendingApproval，否则面板不弹授权。"""
    tid = mirror_session + "-pending-approval"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    mirror = V4Mirror(HUB)
    mirror.note_user_input(tid, "跑命令")
    content = (
        '{"_evoflow_tool":{"status":"pending_approval"},'
        '"message":"[pending_approval] bash",'
        '"approval":{"title":"需要您的授权","tool_name":"bash","summary":"{\\"command\\":\\"ls\\"}","risk":"confirm"}}'
    )
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-pa"},
            {
                "type": "TOOL_CALL_START",
                "toolCallId": "tc-bash",
                "toolCallName": "bash",
            },
            {
                "type": "TOOL_CALL_ARGS",
                "toolCallId": "tc-bash",
                "delta": '{"command":"ls"}',
            },
            {"type": "TOOL_CALL_END", "toolCallId": "tc-bash"},
            {
                "type": "TOOL_CALL_RESULT",
                "toolCallId": "tc-bash",
                "content": content,
                "status": "pending_approval",
            },
        ],
    )
    tool = next(r for r in _rows(tid) if r.get("kind") == "toolCall")
    assert tool["status"] == "pendingApproval", tool
    assert tool["toolName"] == "bash"


def test_hidden_tool_approval_user_text_not_mirrored(mirror_session: str) -> None:
    """批准/续流内部标记不得落成可见 userInput（旧面板也不展示）。"""
    tid = mirror_session + "-hidden-approval"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    mirror = V4Mirror(HUB)
    mirror.note_user_input(
        tid,
        '__evf_tool_approval_v1__: {"action":"approve","tool_call_id":"tc1"}',
    )
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-ha"},
            {"type": "TEXT_MESSAGE_START", "messageId": "m1"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": "继续"},
            {"type": "TEXT_MESSAGE_END", "messageId": "m1"},
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-ha"},
        ],
    )
    users = [r for r in _rows(tid) if r.get("kind") == "userInput"]
    assert users == [], users
    texts = [r for r in _rows(tid) if r.get("kind") == "assistantText"]
    assert len(texts) == 1
    assert texts[0]["text"] == "继续"


def test_pending_approval_from_envelope_when_wire_status_ok(mirror_session: str) -> None:
    """wire status 误标 success/ok 时，信封 _evoflow_tool.status 仍应强制 pendingApproval。"""
    tid = mirror_session + "-pending-envelope"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    mirror = V4Mirror(HUB)
    mirror.note_user_input(tid, "跑命令")
    content = '{"_evoflow_tool":{"status":"pending_approval"},"message":"wait","approval":{"tool_name":"bash"}}'
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-pe"},
            {
                "type": "TOOL_CALL_START",
                "toolCallId": "tc-e",
                "toolCallName": "bash",
            },
            {"type": "TOOL_CALL_END", "toolCallId": "tc-e"},
            {
                "type": "TOOL_CALL_RESULT",
                "toolCallId": "tc-e",
                "content": content,
                "status": "ok",
            },
        ],
    )
    tool = next(r for r in _rows(tid) if r.get("kind") == "toolCall")
    assert tool["status"] == "pendingApproval", tool


def test_run_finished_soft_pauses_when_pending_approval(mirror_session: str) -> None:
    """待授权时 RUN_FINISHED 不得 completedSuccess / 不得把工具卡封成 success。

    浏览器插件轮现场：末两卡仍是 pending_approval，审批表 pending，但轮次被标成功 →
    页面像「自己停了」。
    """
    tid = mirror_session + "-pa-soft-pause"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    mirror = V4Mirror(HUB)
    mirror.note_user_input(tid, "查 browser-client roleSelector")
    content = (
        '{"_evoflow_tool":{"status":"pending_approval"},'
        '"message":"[pending_approval] mcp__node_repl__js",'
        '"approval":{"title":"需要您的授权","tool_name":"mcp__node_repl__js","risk":"confirm"}}'
    )
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-pa-pause"},
            {
                "type": "TOOL_CALL_START",
                "toolCallId": "tc-mcp",
                "toolCallName": "mcp__node_repl__js",
            },
            {"type": "TOOL_CALL_END", "toolCallId": "tc-mcp"},
            {
                "type": "TOOL_CALL_RESULT",
                "toolCallId": "tc-mcp",
                "content": content,
                "status": "pending_approval",
            },
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-pa-pause"},
        ],
    )
    headers = _headers(tid)
    assert len(headers) == 1
    assert headers[0]["state"] == "running", headers[0]
    tool = next(r for r in _rows(tid) if r.get("kind") == "toolCall")
    assert tool["status"] == "pendingApproval", tool
    sess = HUB.get_session(tid)
    assert sess is not None
    assert sess.phase == "running"
    ctrl = dict(sess.control_override) if sess.control_override else sess.control()
    assert ctrl.get("canStop") is True
    assert ctrl.get("phase") == "running"
    # 闩锁仍开，便于批准后续跑同一轮
    st = mirror._states.get(tid)  # noqa: SLF001
    assert st is not None and st.run_started is True


def test_node_repl_cua_display_field_becomes_output_display(mirror_session: str) -> None:
    """TOOL_CALL_RESULT.cua_display（标记已被剥）必须投影到 output.display，供 V4 图标/截图。"""
    tid = mirror_session + "-cua-display"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    mirror = V4Mirror(HUB)
    mirror.note_user_input(tid, "打开飞书并截图")
    shot = "/api/threads/t1/browser-snapshots/abc123def456"
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-cua"},
            {
                "type": "TOOL_CALL_START",
                "toolCallId": "tc-cua",
                "toolCallName": "mcp__node_repl__js",
            },
            {"type": "TOOL_CALL_END", "toolCallId": "tc-cua"},
            {
                "type": "TOOL_CALL_RESULT",
                "toolCallId": "tc-cua",
                "toolName": "mcp__node_repl__js",
                "content": f"[Screenshot captured: {shot} (40KB) — already shown on the tool card]",
                "status": "success",
                "cua_display": {
                    "status": "success",
                    "images": [{"url": shot, "kb": 40}],
                    "target_app": {
                        "app_key": "windows-exe:d:\\app\\feishu\\app\\feishu.exe",
                        "display_name": "飞书",
                    },
                },
            },
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-cua"},
        ],
    )
    tool = next(r for r in _rows(tid) if r.get("kind") == "toolCall")
    assert tool["status"] == "success", tool
    display = (tool.get("output") or {}).get("display")
    assert isinstance(display, dict), tool
    assert display.get("kind") == "cua"
    media = display.get("media") or []
    assert media and media[0].get("artifactUri") == shot
    target = display.get("targetApp") or {}
    assert target.get("displayName") == "飞书"
    locs = target.get("iconLocators") or []
    assert locs and locs[0].get("kind") == "windows-executable-path"
    assert "feishu.exe" in str(locs[0].get("value") or "").lower()


def test_late_tool_result_after_run_finished_recovers_cancelled_row(
    mirror_session: str,
) -> None:
    """RUN_FINISHED 先 seal 成 cancelled 后，迟到的 TOOL_CALL_RESULT 必须回写 output。

    现场：search_code_index 慢路径下 RESULT 偶发晚于 FINISHED；V4 卡面永久 cancelled、
    展开无结果，索引时效性（[index] age=…）也看不见。模型侧其实已经拿到 ToolMessage。
    """
    tid = mirror_session + "-late-result"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    mirror = V4Mirror(HUB)
    mirror.note_user_input(tid, "再调用一次")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-late"},
            {
                "type": "TOOL_CALL_START",
                "toolCallId": "tc-sci",
                "toolCallName": "search_code_index",
            },
            {
                "type": "TOOL_CALL_ARGS",
                "toolCallId": "tc-sci",
                "delta": '{"query":"source_drift"}',
            },
            {"type": "TOOL_CALL_END", "toolCallId": "tc-sci"},
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-late"},
        ],
    )
    sealed = next(r for r in _rows(tid) if r.get("kind") == "toolCall")
    assert sealed["status"] == "cancelled", sealed
    assert not (sealed.get("output") or {}).get("text")

    # RESULT 迟到：map 已清，必须按 toolCallId 找回行并升级为 success + output。
    mirror.feed_events(
        tid,
        [
            {
                "type": "TOOL_CALL_RESULT",
                "toolCallId": "tc-sci",
                "toolCallName": "search_code_index",
                "content": "[index] last updated 8m ago (age=481s)\n\nSymbols:\n  - function source_drift",
                "status": "success",
            },
        ],
    )
    tools = [r for r in _rows(tid) if r.get("kind") == "toolCall"]
    assert len(tools) == 1, tools
    tool = tools[0]
    assert tool["status"] == "success", tool
    assert tool["toolName"] == "search_code_index"
    assert tool["inputText"] == '{"query":"source_drift"}'
    out = (tool.get("output") or {}).get("text") or ""
    assert "[index] last updated" in out
    assert "source_drift" in out
    # startedAt 不得被 RESULT 重置成结束时刻（否则耗时恒为 0）。
    assert int(tool.get("startedAt") or 0) <= int(tool.get("endedAt") or 0)
    assert int(tool.get("startedAt") or 0) == int(sealed.get("startedAt") or sealed.get("createdAt") or 0)


def test_seal_backfills_output_from_transcript_when_result_missing(
    mirror_session: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """wire RESULT 丢失时，RUN_FINISHED seal 必须从 transcript 回填 success+output。

    现网：search_code_index 工具正文已在 evoflow_chat_messages，V4 卡却 cancelled。
    """
    tid = mirror_session + "-seal-backfill"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001

    monkeypatch.setattr(
        "app.gateway.v4.agui_mirror._transcript_tool_result_text",
        lambda _tid, tcid: (
            (
                "search_code_index",
                "[index] last updated 7s ago (age=7s)\n\nSymbols:\n  - function zzq_heal",
            )
            if tcid == "tc-bf"
            else None
        ),
    )

    mirror = V4Mirror(HUB)
    mirror.note_user_input(tid, "搜一下")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-bf"},
            {
                "type": "TOOL_CALL_START",
                "toolCallId": "tc-bf",
                "toolCallName": "search_code_index",
            },
            {
                "type": "TOOL_CALL_ARGS",
                "toolCallId": "tc-bf",
                "delta": '{"query":"zzq_heal"}',
            },
            {"type": "TOOL_CALL_END", "toolCallId": "tc-bf"},
            # 无 TOOL_CALL_RESULT —— 模拟 SSE 丢结果
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-bf"},
        ],
    )
    tool = next(r for r in _rows(tid) if r.get("kind") == "toolCall")
    assert tool["status"] == "success", tool
    assert tool["toolName"] == "search_code_index"
    out = (tool.get("output") or {}).get("text") or ""
    assert "[index] last updated" in out
    assert "zzq_heal" in out


def test_empty_tool_result_content_backfills_from_transcript(
    mirror_session: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """SSE slim 把 search_code_index content 置空时，RESULT 必须从 transcript 回填。

    现网：工具已成功落库 13KB+，V4 卡却「已执行 / 暂无检索结果」。
    """
    tid = mirror_session + "-empty-result-body"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001

    monkeypatch.setattr(
        "app.gateway.v4.agui_mirror._transcript_tool_result_text",
        lambda _tid, tcid: (
            (
                "search_code_index",
                "[index] last updated 53m ago (age=3180s)\n\n"
                "Code index results for 'v4 conversation projection':\n\n"
                "Symbols:\n  - function ConversationTurnGroup @ ConversationTurnGroup.tsx:1",
            )
            if tcid == "tc-empty-body"
            else None
        ),
    )

    mirror = V4Mirror(HUB)
    mirror.note_user_input(tid, "查投影")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-empty-body"},
            {
                "type": "TOOL_CALL_START",
                "toolCallId": "tc-empty-body",
                "toolCallName": "search_code_index",
            },
            {
                "type": "TOOL_CALL_ARGS",
                "toolCallId": "tc-empty-body",
                "delta": '{"queries":["v4 conversation projection turnHeader rowId window"]}',
            },
            {"type": "TOOL_CALL_END", "toolCallId": "tc-empty-body"},
            {
                "type": "TOOL_CALL_RESULT",
                "toolCallId": "tc-empty-body",
                "toolCallName": "search_code_index",
                # slim_content_for_ui lazy-empty：wire 正文被掏空
                "content": "",
                "status": "success",
            },
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-empty-body"},
        ],
    )
    tool = next(r for r in _rows(tid) if r.get("kind") == "toolCall")
    assert tool["status"] == "success", tool
    out = (tool.get("output") or {}).get("text") or ""
    assert "ConversationTurnGroup" in out
    assert "[index] last updated" in out


def test_seal_heals_orphan_open_tool_when_map_cleared(
    mirror_session: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """tool_row_ids 中途被清掉后，RUN_FINISHED 仍须扫 HUB 孤儿行并回填。

    现网：search_code_index 卡永久 inputStreaming（「等待中」/「检索中…」），
    transcript 已有正文，但 seal 因 map 空直接 return。
    """
    tid = mirror_session + "-orphan-heal"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001

    monkeypatch.setattr(
        "app.gateway.v4.agui_mirror._transcript_tool_result_text",
        lambda _tid, tcid: (
            (
                "search_code_index",
                "[index] last updated 3s ago (age=3s)\n\nSymbols:\n  - function orphan_heal",
            )
            if tcid == "tc-orphan"
            else None
        ),
    )

    mirror = V4Mirror(HUB)
    mirror.note_user_input(tid, "搜孤儿")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-orphan-heal"},
            {
                "type": "TOOL_CALL_START",
                "toolCallId": "tc-orphan",
                "toolCallName": "search_code_index",
            },
            {
                "type": "TOOL_CALL_ARGS",
                "toolCallId": "tc-orphan",
                "delta": '{"query":"orphan_heal"}',
            },
        ],
    )
    stuck = next(r for r in _rows(tid) if r.get("kind") == "toolCall")
    assert stuck["status"] == "inputStreaming", stuck

    # 模拟流式 map 中途清空（保留 turn_id，否则 FINISHED 无法对上本轮行）。
    st = mirror._states[tid]  # noqa: SLF001
    st.tool_row_ids.clear()
    st.tool_acc.clear()
    st.tool_names.clear()

    mirror.feed_events(
        tid,
        [{"type": "RUN_FINISHED", "threadId": tid, "runId": "run-orphan-heal"}],
    )
    tool = next(r for r in _rows(tid) if r.get("kind") == "toolCall")
    assert tool["status"] == "success", tool
    out = (tool.get("output") or {}).get("text") or ""
    assert "orphan_heal" in out
    assert "[index] last updated" in out


def test_reasoning_end_writes_duration_ms(mirror_session: str) -> None:
    """思考行完成时必须带 durationMs，否则 V4 只显示「几秒」而不是真实秒数。"""
    tid = mirror_session + "-reasoning-dur"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    mirror = V4Mirror(HUB)
    mirror.note_user_input(tid, "想一下")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-r"},
            {"type": "REASONING_MESSAGE_START", "messageId": "think-1"},
        ],
    )
    rows = _rows(tid)
    reasoning = next(r for r in rows if r.get("kind") == "reasoning")
    started = int(reasoning.get("startedAt") or reasoning.get("createdAt") or 0)
    assert started > 0

    # 模拟思考持续约 3 秒后再 END（直接改 createdAt/startedAt）。
    reasoning["createdAt"] = started - 3200
    reasoning["startedAt"] = started - 3200
    HUB.get_session(tid).rows[int(reasoning["rowId"])] = reasoning  # noqa: SLF001

    mirror.feed_events(
        tid,
        [
            {
                "type": "REASONING_MESSAGE_CONTENT",
                "messageId": "think-1",
                "delta": "thinking…",
            },
            {"type": "REASONING_MESSAGE_END", "messageId": "think-1"},
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-r"},
        ],
    )
    done = next(r for r in _rows(tid) if r.get("kind") == "reasoning")
    assert done["state"] == "complete"
    assert isinstance(done.get("durationMs"), int)
    assert done["durationMs"] >= 3000


def test_reasoning_restart_same_message_id_opens_new_row(mirror_session: str) -> None:
    """工具轮后再用同一 messageId START：必须新开思考行，不能灌进已完成的第一张。"""
    tid = mirror_session + "-reasoning-reopen"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    mirror = V4Mirror(HUB)
    mirror.note_user_input(tid, "多轮工具")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-rr"},
            {"type": "REASONING_MESSAGE_START", "messageId": "think-reuse"},
            {
                "type": "REASONING_MESSAGE_CONTENT",
                "messageId": "think-reuse",
                "delta": "第一段思考",
            },
            {"type": "REASONING_MESSAGE_END", "messageId": "think-reuse"},
            {
                "type": "TOOL_CALL_START",
                "toolCallId": "tc-1",
                "toolCallName": "bash",
            },
            {"type": "TOOL_CALL_END", "toolCallId": "tc-1"},
            {
                "type": "TOOL_CALL_RESULT",
                "toolCallId": "tc-1",
                "content": "ok",
                "status": "success",
            },
            {"type": "REASONING_MESSAGE_START", "messageId": "think-reuse"},
            {
                "type": "REASONING_MESSAGE_CONTENT",
                "messageId": "think-reuse",
                "delta": "工具后的第二段思考",
            },
            {"type": "REASONING_MESSAGE_END", "messageId": "think-reuse"},
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-rr"},
        ],
    )
    reasonings = [r for r in _rows(tid) if r.get("kind") == "reasoning"]
    assert len(reasonings) == 2, reasonings
    assert reasonings[0]["text"] == "第一段思考"
    assert reasonings[1]["text"] == "工具后的第二段思考"
    assert reasonings[0]["rowId"] != reasonings[1]["rowId"]


def test_tool_call_start_does_not_duplicate_prior_turn_tcid(mirror_session: str) -> None:
    """失败轮重放上一轮 toolCallId 时，不得再开一张空 error 卡。"""
    tid = mirror_session + "-no-dup-tcid"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    mirror = V4Mirror(HUB)
    mirror.note_user_input(tid, "第一问")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-1"},
            {
                "type": "TOOL_CALL_START",
                "toolCallId": "tc-same",
                "toolCallName": "search_code_index",
            },
            {
                "type": "TOOL_CALL_ARGS",
                "toolCallId": "tc-same",
                "delta": '{"query":"x"}',
            },
            {"type": "TOOL_CALL_END", "toolCallId": "tc-same"},
            {
                "type": "TOOL_CALL_RESULT",
                "toolCallId": "tc-same",
                "content": "hit",
                "status": "success",
            },
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-1"},
        ],
    )
    mirror.note_user_input(tid, "那你有优化吧")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-2"},
            {
                "type": "TOOL_CALL_START",
                "toolCallId": "tc-same",
                "toolCallName": "search_code_index",
            },
            {"type": "RUN_ERROR", "threadId": tid, "runId": "run-2", "message": "boom"},
        ],
    )
    tools = [r for r in _rows(tid) if r.get("kind") == "toolCall"]
    assert len(tools) == 1, tools
    assert tools[0]["status"] == "success"
    assert tools[0]["turnId"] == "run-1"
