"""V4 RUN_ERROR → lastError must expose copyable detail for user feedback."""

from __future__ import annotations

from typing import Any

import pytest

from app.gateway.agui_stream_normalizer import RUN_ERROR, AgUiEncoderState, evf_payload_to_agui_events
from app.gateway.v4.agui_mirror import (
    V4Mirror,
    _is_user_interrupt_event,
    _run_error_info,
    mirror_seal_user_stop,
)
from app.gateway.v4.conversation import HUB

# 【self-evolution-bot · 2026-11-21 · 第115轮 · 模型:deepseek-v4.1-flash-1017】
# 改了什么：为「上游只回一句通用英文错误」加回归断言（后端 lastError 文案）。
# 为什么：2026-11-21 23:26:49 文档撰写师第二轮真实失败，上游回
#   "An internal error occurred" —— 不含 timeout/限流/断连任何特征，
#   旧实现掉进最后那条纯兜底文案「本轮生成失败（可点「详情/复制」…）」，
#   用户既不知原因也不知该不该重发。实测重发一次即成功（DA14C 正常回）。
# 反证边界：带冒号细节 / 带中文 / 超长的原文不得被本档吞掉。


def test_run_error_info_generic_upstream_error_is_actionable() -> None:
    info = _run_error_info({"code": "run_error", "message": "An internal error occurred"}, now_ms=1)
    assert "临时内部错误" in info["message"]
    assert "再发一次" in info["message"]
    # 原始英文必须仍留在 detail 里，供「详情/复制」取证
    assert info["detail"] == "An internal error occurred"
    assert "An internal error occurred" not in info["message"]
    assert info["recoverable"] is True


@pytest.mark.parametrize(
    "raw",
    [
        "an internal error occurred.",
        "Internal Server Error occurred",
        "Something went wrong",
    ],
)
def test_run_error_info_generic_upstream_error_variants(raw: str) -> None:
    info = _run_error_info({"code": "run_error", "message": raw}, now_ms=1)
    assert "再发一次" in info["message"]


@pytest.mark.parametrize(
    "raw",
    [
        "an internal error occurred: tool schema invalid for knowledge",
        "An internal error occurred 请联系管理员",
        "An internal error occurred " + "x" * 200,
    ],
)
def test_run_error_info_generic_branch_does_not_swallow_detail(raw: str) -> None:
    info = _run_error_info({"code": "run_error", "message": raw}, now_ms=1)
    assert "临时内部错误" not in info["message"]


def test_run_error_info_schema_failure() -> None:
    info = _run_error_info(
        {
            "code": "PydanticInvalidForJsonSchema",
            "message": (
                "Failed to generate JSON schema for 'knowledge': "
                "Cannot generate a JsonSchema for core_schema.CallableSchema"
            ),
        },
        now_ms=1,
    )
    assert info["code"] == "PydanticInvalidForJsonSchema"
    assert "knowledge" in info["message"]
    assert "复制" in info["message"]
    assert "CallableSchema" in info["detail"]
    assert info["source"] == "runtime"


def test_run_error_info_bare_run_error_is_actionable() -> None:
    info = _run_error_info({"code": "run_error", "message": "run_error"}, now_ms=2)
    assert info["code"] == "run_error"
    assert "负载" in info["message"] or "中断" in info["message"]
    assert "开新会话" in info["message"]
    assert "上游未返回" in info["detail"]
    assert info["recoverable"] is True


def test_run_error_info_remote_disconnect() -> None:
    info = _run_error_info(
        {
            "code": "ERROR",
            "message": "httpx.RemoteProtocolError: Server disconnected without sending a response.",
        },
        now_ms=3,
    )
    assert "连接中断" in info["message"]
    assert info["recoverable"] is True


def test_agui_error_dict_extracts_message() -> None:
    state = AgUiEncoderState(thread_id="t1", run_id="r1")
    events = evf_payload_to_agui_events(
        {
            "type": "error",
            "error": {
                "error": "PydanticInvalidForJsonSchema",
                "message": "Failed to generate JSON schema for 'knowledge'",
            },
        },
        state=state,
    )
    err = next(e for e in events if e.get("type") == RUN_ERROR)
    assert err["code"] == "PydanticInvalidForJsonSchema"
    assert err["message"] == "Failed to generate JSON schema for 'knowledge'"
    assert "{" not in err["message"]


@pytest.mark.parametrize(
    "ev",
    [
        {"code": "USER_INTERRUPT", "message": "user_interrupt"},
        {"code": "ABORTED", "message": "user_interrupt"},
        {"code": "ERROR", "message": "User interrupted"},
        {"code": "user_interrupt", "message": ""},
    ],
)
def test_is_user_interrupt_event(ev: dict[str, Any]) -> None:
    assert _is_user_interrupt_event(ev) is True


def test_is_user_interrupt_event_rejects_real_errors() -> None:
    assert _is_user_interrupt_event({"code": "ERROR", "message": "timeout contacting vendor"}) is False


def _rows(session_id: str) -> list[dict[str, Any]]:
    sess = HUB.get_session(session_id)
    assert sess is not None
    return sorted(sess.rows.values(), key=lambda r: int(r["rowId"]))


def _latest_control_patch(session_id: str) -> dict[str, Any] | None:
    sess = HUB.get_session(session_id)
    assert sess is not None
    control = None
    for _seq, delta in sess.delta_log:
        if delta.get("op") != "state.updated":
            continue
        patch = delta.get("patch") or {}
        if "control" in patch and isinstance(patch["control"], dict):
            control = patch["control"]
    return control


# 【self-evolution-bot · 2026-11-22 · 第116轮 · 模型:deepseek-v4.1-flash-1017】
# 改了什么：新增回归断言——失败文案必须落进 DB transcript，不能只留在 hub 内存行。
# 为什么（本轮现网实证）：TranscriptMiddleware.after_model 只在模型成功返回时跑，
#   模型抛 RUN_ERROR 时它根本不执行 → DB 里只有 user 行、没有 assistant 行。
#   实测 DA14B（2026-11-21 23:26:49）正是如此；排除本岗位会话后全量复算，
#   含失败文案的 assistant 行 0 条 —— 这条路径从未落过库。
# 判据：落库失败时用户刷新/重开会话，整轮凭空消失，只剩一句没人回的提问。


def test_error_text_persists_to_db_transcript(monkeypatch: pytest.MonkeyPatch) -> None:
    """RUN_ERROR 无正文时，失败文案要以 assistant 行落进 evoflow_chat_messages。"""
    monkeypatch.setattr("app.gateway.v4.agui_mirror._MIRROR_DISABLED", False)
    captured: list[dict[str, Any]] = []

    # 打桩外部依赖：本测只验「接线有没有接上」，不验真实 DB。
    monkeypatch.setattr(
        "evoflow.persistence.session_repositories.find_session_key_by_thread_id",
        lambda tid: "proactive:test:chat:dept-persist",
    )
    import evoflow.persistence.chat_session_service as css

    def _fake_append(session_key, messages, **kwargs):
        captured.append({"session_key": session_key, "messages": messages, **kwargs})
        return {}

    monkeypatch.setattr(css, "append_messages_batch_and_touch_session", _fake_append)

    tid = "mirror-error-persist-test"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    mirror = V4Mirror(HUB)
    mirror.note_user_input(tid, "hi")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-err"},
            {"type": "RUN_ERROR", "code": "run_error", "message": "An internal error occurred"},
        ],
    )

    assert captured, "失败文案没有落库调用 —— 刷新后整轮会消失"
    call = captured[-1]
    assert call["session_key"] == "proactive:test:chat:dept-persist"
    rows = call["messages"]
    assert len(rows) == 1
    assert rows[0]["role"] == "assistant"
    assert rows[0]["message_id"].startswith("model-error-")
    assert "临时内部错误" in str(rows[0]["content"])
    # 幂等：确定性 message_id + skip_if_seq_exists，重试 N 次也只落 1 条
    assert call.get("skip_if_seq_exists") is True


def test_error_text_not_persisted_when_body_streamed(monkeypatch: pytest.MonkeyPatch) -> None:
    """已有正文时不得重复落错误文案（否则成功轮会多出一条假失败）。"""
    monkeypatch.setattr("app.gateway.v4.agui_mirror._MIRROR_DISABLED", False)
    captured: list[dict[str, Any]] = []
    monkeypatch.setattr(
        "evoflow.persistence.session_repositories.find_session_key_by_thread_id",
        lambda tid: "proactive:test:chat:dept-persist2",
    )
    import evoflow.persistence.chat_session_service as css

    monkeypatch.setattr(
        css,
        "append_messages_batch_and_touch_session",
        lambda sk, messages, **kw: captured.append({"sk": sk}) or {},
    )

    tid = "mirror-error-persist-body-test"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    mirror = V4Mirror(HUB)
    mirror.note_user_input(tid, "hi")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-err2"},
            {"type": "TEXT_MESSAGE_START", "messageId": "m1", "role": "assistant"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": "已完成工作"},
            {"type": "TEXT_MESSAGE_END", "messageId": "m1"},
            {"type": "RUN_ERROR", "code": "run_error", "message": "An internal error occurred"},
        ],
    )
    assert not captured, "已有正文却仍落错误文案 —— 会把成功轮标成失败"


def test_user_interrupt_run_error_is_interrupted_not_error_banner(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.gateway.v4.agui_mirror._MIRROR_DISABLED", False)
    tid = "mirror-user-interrupt-test"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    mirror = V4Mirror(HUB)
    mirror.note_user_input(tid, "hi")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-stop"},
            {"type": "RUN_ERROR", "code": "USER_INTERRUPT", "message": "user_interrupt"},
        ],
    )
    headers = [r for r in _rows(tid) if r.get("kind") == "turnHeader"]
    assert headers
    assert headers[-1]["state"] == "completedInterrupted"
    texts = [r for r in _rows(tid) if r.get("kind") == "assistantText"]
    assert not any("详情" in str(r.get("text") or "") for r in texts)
    assert not any("user_interrupt" in str(r.get("text") or "") for r in texts)
    ctrl = _latest_control_patch(tid)
    assert ctrl is not None
    assert ctrl["phase"] == "completedInterrupted"
    assert ctrl["lastError"] is None


def test_late_user_interrupt_does_not_downgrade_completed_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Queue auto-send / send_prep race must not rewrite success →「用户停止」."""
    monkeypatch.setattr("app.gateway.v4.agui_mirror._MIRROR_DISABLED", False)
    tid = "mirror-late-interrupt-after-success"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    mirror = V4Mirror(HUB)
    mirror.note_user_input(tid, "hi")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-ok"},
            {"type": "TEXT_MESSAGE_START", "messageId": "m1", "role": "assistant"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": "done"},
            {"type": "TEXT_MESSAGE_END", "messageId": "m1"},
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-ok"},
        ],
    )
    headers = [r for r in _rows(tid) if r.get("kind") == "turnHeader"]
    assert headers
    assert headers[-1]["state"] == "completedSuccess"
    sealed_header_id = int(headers[-1]["rowId"])
    # FINISHED 会 reset ephemeral；模拟迟到 interrupt 仍指向已成功 header。
    st = mirror._states[tid]  # noqa: SLF001
    st.run_started = True
    st.turn_header_row_id = sealed_header_id
    mirror.feed_events(
        tid,
        [
            {
                "type": "RUN_ERROR",
                "code": "USER_INTERRUPT",
                "message": "user_interrupt",
                "threadId": tid,
                "runId": "run-ok",
            },
        ],
    )
    sealed = next(r for r in _rows(tid) if int(r["rowId"]) == sealed_header_id)
    assert sealed["state"] == "completedSuccess"


def test_run_finished_seals_open_tool_calls(monkeypatch: pytest.MonkeyPatch) -> None:
    """TOOL_CALL_END→running 后若无 RESULT，FINISHED 必须封掉，否则画布永久转圈。"""
    monkeypatch.setattr("app.gateway.v4.agui_mirror._MIRROR_DISABLED", False)
    tid = "mirror-seal-open-tools"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    mirror = V4Mirror(HUB)
    mirror.note_user_input(tid, "hi")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-seal"},
            {
                "type": "TOOL_CALL_START",
                "toolCallId": "tc-open",
                "toolCallName": "web_search",
            },
            {"type": "TOOL_CALL_ARGS", "toolCallId": "tc-open", "delta": "{}"},
            {"type": "TOOL_CALL_END", "toolCallId": "tc-open"},
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-seal"},
        ],
    )
    tools = [r for r in _rows(tid) if r.get("kind") == "toolCall"]
    assert tools
    assert tools[-1]["status"] == "cancelled"
    headers = [r for r in _rows(tid) if r.get("kind") == "turnHeader"]
    assert headers[-1]["state"] == "completedSuccess"


def test_mirror_seal_user_stop_seals_tools_and_reasoning(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """点停不经在途 RUN_ERROR：mirror_seal_user_stop 必须立刻封工具/思考。"""
    monkeypatch.setattr("app.gateway.v4.agui_mirror._MIRROR_DISABLED", False)
    tid = "mirror-seal-user-stop-live"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    # 走全局镜像入口（与 stop_session_execution 同路径）
    import app.gateway.v4.agui_mirror as mirror_mod

    mirror_mod._MIRROR = V4Mirror(HUB)  # noqa: SLF001
    mirror = mirror_mod._MIRROR
    mirror.note_user_input(tid, "改全屏")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-stop-live"},
            {"type": "REASONING_MESSAGE_START", "messageId": "r1"},
            {"type": "REASONING_MESSAGE_CONTENT", "messageId": "r1", "delta": "找源码"},
            {
                "type": "TOOL_CALL_START",
                "toolCallId": "tc-bash",
                "toolCallName": "bash",
            },
            {"type": "TOOL_CALL_END", "toolCallId": "tc-bash"},
            {
                "type": "TEXT_MESSAGE_START",
                "messageId": "a1",
                "role": "assistant",
            },
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "a1", "delta": "半截"},
        ],
    )
    mirror_seal_user_stop(tid)
    headers = [r for r in _rows(tid) if r.get("kind") == "turnHeader"]
    assert headers[-1]["state"] == "completedInterrupted"
    tools = [r for r in _rows(tid) if r.get("kind") == "toolCall"]
    assert tools and tools[-1]["status"] == "cancelled"
    reasoning = [r for r in _rows(tid) if r.get("kind") == "reasoning"]
    assert reasoning and reasoning[-1]["state"] == "interrupted"
    texts = [r for r in _rows(tid) if r.get("kind") == "assistantText"]
    assert texts and texts[-1]["state"] == "interrupted"
    st = mirror._states[tid]  # noqa: SLF001
    assert st.run_started is False


def test_run_started_after_open_prior_seals_orphan_tools(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """上一轮漏 FINISHED 时，新 RUN_STARTED 也要封掉孤儿工具卡。"""
    monkeypatch.setattr("app.gateway.v4.agui_mirror._MIRROR_DISABLED", False)
    tid = "mirror-prior-reset-seal-tools"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    mirror = V4Mirror(HUB)
    mirror.note_user_input(tid, "first")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-old"},
            {
                "type": "TOOL_CALL_START",
                "toolCallId": "tc-orphan",
                "toolCallName": "bash",
            },
            {"type": "TOOL_CALL_END", "toolCallId": "tc-orphan"},
        ],
    )
    mirror.note_user_input(tid, "second")
    mirror.feed_events(
        tid,
        [{"type": "RUN_STARTED", "threadId": tid, "runId": "run-new"}],
    )
    tools = [r for r in _rows(tid) if r.get("kind") == "toolCall"]
    assert tools
    assert tools[0]["status"] == "cancelled"
    headers = [r for r in _rows(tid) if r.get("kind") == "turnHeader"]
    assert any(h.get("state") == "failed" for h in headers)
    assert headers[-1]["state"] == "running"


# 【self-evolution-bot · 2026-11-22 · 第118轮 · 模型:deepseek-v4.1-flash-1017】
# 改了什么：把「空跑占位」也纳入落库断言（与 RUN_ERROR 文案同一落库方法）。
# 为什么：全量复算现网 `message_id LIKE 'empty-run-%'` = 0 条、`content_json` 严格含
#   `"content":"本轮没有可展示的回复` 的 assistant 行 = 0 条 —— 空跑说明一直只活在
#   hub 内存与前端 EMPTY_TURN_NOTICE 里。刷新后靠 hydration 合成才勉强可见，
#   但库里没有任何实体说明「这一轮为什么没回复」，事后无从查证。
# 边界：只有真的命中空跑（无正文/无工具）才落；已流正文的轮不得多出一条假空跑。


def test_empty_run_notice_persists_to_db_transcript(monkeypatch: pytest.MonkeyPatch) -> None:
    """空跑占位要以 assistant 行落库（message_id = empty-run-<turn_id>）。"""
    monkeypatch.setattr("app.gateway.v4.agui_mirror._MIRROR_DISABLED", False)
    monkeypatch.setattr("app.gateway.v4.agui_mirror._EMPTY_RUN_DEFER_SEC", 0.0)
    captured: list[dict[str, Any]] = []
    monkeypatch.setattr(
        "evoflow.persistence.session_repositories.find_session_key_by_thread_id",
        lambda tid: "proactive:test:chat:dept-empty",
    )
    import evoflow.persistence.chat_session_service as css

    monkeypatch.setattr(
        css,
        "append_messages_batch_and_touch_session",
        lambda sk, messages, **kw: captured.append({"sk": sk, "messages": messages, **kw}) or {},
    )

    tid = "mirror-empty-run-persist-test"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    mirror = V4Mirror(HUB)
    mirror.note_user_input(tid, "hi")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-empty"},
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-empty"},
        ],
    )

    assert captured, "空跑占位没有落库调用 —— 刷新后这轮无任何实体说明"
    rows = captured[-1]["messages"]
    assert len(rows) == 1
    assert rows[0]["role"] == "assistant"
    assert rows[0]["message_id"] == "empty-run-run-empty"
    assert "本轮未产出可见回复" in str(rows[0]["content"])
    assert captured[-1].get("skip_if_seq_exists") is True


def test_empty_run_notice_not_persisted_when_body_streamed(monkeypatch: pytest.MonkeyPatch) -> None:
    """已流出正文的轮不得再落空跑说明（否则成功轮多一条假空跑）。"""
    monkeypatch.setattr("app.gateway.v4.agui_mirror._MIRROR_DISABLED", False)
    monkeypatch.setattr("app.gateway.v4.agui_mirror._EMPTY_RUN_DEFER_SEC", 0.0)
    captured: list[dict[str, Any]] = []
    monkeypatch.setattr(
        "evoflow.persistence.session_repositories.find_session_key_by_thread_id",
        lambda tid: "proactive:test:chat:dept-empty2",
    )
    import evoflow.persistence.chat_session_service as css

    monkeypatch.setattr(
        css,
        "append_messages_batch_and_touch_session",
        lambda sk, messages, **kw: captured.append({"sk": sk, "messages": messages, **kw}) or {},
    )

    tid = "mirror-empty-run-persist-body-test"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    mirror = V4Mirror(HUB)
    mirror.note_user_input(tid, "hi")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-body"},
            {"type": "TEXT_MESSAGE_START", "messageId": "m-body"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m-body", "delta": "真正的回答"},
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-body"},
        ],
    )

    mids = [
        str(m.get("message_id") or "")
        for c in captured
        for m in c.get("messages", [])
        if isinstance(m, dict)
    ]
    assert not [m for m in mids if m.startswith("empty-run-")], mids


# 【self-evolution-bot · 2026-11-22 · 第118轮 · 模型:deepseek-v4.1-flash-1017】
# 改了什么：补第三层断言 —— 空跑占位落库后，迟到正文到达必须把 DB 那条也删掉。
# 为什么：只加落库不加撤库，会造成更糟的状态：刷新后同一轮里既显示真回复、
#   又显示「本轮未产出可见回复」。这类「写了不删」的洞，单测只测写就永远抓不到。


def test_empty_run_notice_row_deleted_when_late_body_arrives(monkeypatch: pytest.MonkeyPatch) -> None:
    """先落空跑占位，迟到正文到达后 DB 占位行必须被删（否则刷新后真回复与空跑并存）。"""
    monkeypatch.setattr("app.gateway.v4.agui_mirror._MIRROR_DISABLED", False)
    monkeypatch.setattr("app.gateway.v4.agui_mirror._EMPTY_RUN_DEFER_SEC", 0.0)
    appended: list[dict[str, Any]] = []
    deleted: list[tuple[str, str]] = []
    monkeypatch.setattr(
        "evoflow.persistence.session_repositories.find_session_key_by_thread_id",
        lambda tid: "proactive:test:chat:dept-clear",
    )
    import evoflow.persistence.chat_session_service as css
    import evoflow.persistence.chat_message_repositories as cmr

    monkeypatch.setattr(
        css,
        "append_messages_batch_and_touch_session",
        lambda sk, messages, **kw: appended.append({"sk": sk, "messages": messages}) or {},
    )
    monkeypatch.setattr(
        cmr,
        "delete_message_by_message_id",
        lambda sk, mid, **kw: deleted.append((sk, mid)) or 1,
    )

    tid = "mirror-empty-run-clear-test"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    mirror = V4Mirror(HUB)
    mirror.note_user_input(tid, "hi")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-clear"},
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-clear"},
        ],
    )
    wrote = [
        str(m.get("message_id") or "")
        for c in appended
        for m in c.get("messages", [])
        if isinstance(m, dict)
    ]
    assert "empty-run-run-clear" in wrote, wrote

    # 迟到正文：同一 turn 内补发 TEXT_*，占位必须退场
    mirror.feed_events(
        tid,
        [
            {"type": "TEXT_MESSAGE_START", "messageId": "m-late-2"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m-late-2", "delta": "迟到的真正回答"},
        ],
    )
    assert ("proactive:test:chat:dept-clear", "empty-run-run-clear") in deleted, deleted
