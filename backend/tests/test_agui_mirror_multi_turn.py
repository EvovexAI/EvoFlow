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
    assert headers[1]["turnId"] == "run-retry"
    assert headers[1]["state"] == "running"


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
