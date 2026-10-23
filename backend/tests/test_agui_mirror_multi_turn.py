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
