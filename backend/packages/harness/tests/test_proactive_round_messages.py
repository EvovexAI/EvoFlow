"""Proactive chat messages tagged and filtered by duty ``round_id``."""

from __future__ import annotations

from evoflow.persistence import chat_message_repositories as msg_repo
from evoflow.persistence import session_repositories as sess_repo
from evoflow.persistence.chat_message_repositories import list_lead_chat_rows_for_model_hydration
from evoflow.persistence.db import reset_db_for_tests
from evoflow.proactive.chat_session import prepare_proactive_chat_session, proactive_session_key


def test_prepare_proactive_chat_session_writes_round_id(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(tmp_path / "proactive-round.db"))
    reset_db_for_tests()

    sk = prepare_proactive_chat_session(
        agent_code="ops-bot",
        role_name="运维",
        thread_id="thread-round-1",
        prompt="开始值班巡检",
        round_id="round:2026-07-16T04:00:00Z",
        kind="think",
    )
    assert sk.startswith("proactive:ops-bot:duty:")
    assert "round-2026-07-16T04-00-00Z" in sk or "round-2026-07-16" in sk

    rows = msg_repo.list_messages(sk, limit=10)
    assert len(rows) == 2
    assert rows[0]["role"] == "user"
    assert rows[0]["round_id"] == "round:2026-07-16T04:00:00Z"
    assert rows[0]["thread_id"] == "thread-round-1"
    assert rows[0]["tool_name"] == "proactive_duty_brief"
    assert rows[1]["tool_name"] == "proactive_duty_beat"
    assert "本轮值班开始" in str(rows[1].get("content_json") or "")


def test_prepare_task_session_key(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(tmp_path / "proactive-task-sess.db"))
    reset_db_for_tests()

    from evoflow.proactive.chat_session import parse_proactive_session_key

    sk = prepare_proactive_chat_session(
        agent_code="ops-bot",
        role_name="运维",
        thread_id="thread-task-1",
        prompt="推进任务",
        round_id="dispatch:2026-07-16T04:00:00Z",
        kind="execute",
        task_id="2607160040_abcd",
        task_title="修登录",
        workspace_kind="task",
    )
    assert sk == "proactive:ops-bot:task:2607160040_abcd"
    parsed = parse_proactive_session_key(sk)
    assert parsed["agent_code"] == "ops-bot"
    assert parsed["kind"] == "task"
    assert parsed["task_id"] == "2607160040_abcd"
    row = sess_repo.load_session_map().get(sk) or {}
    assert str(row.get("title") or "") == "修登录"


def test_prepare_hides_duty_brief_from_display(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(tmp_path / "proactive-hide-brief.db"))
    reset_db_for_tests()

    brief = (
        "# 值班 · 「运维」\n\n"
        "## 本岗看板 Task（可执行；``tasks(action=progress|state)`` 用这里的 id）\n\n"
        "- `t1` [pending] 0% · 例行巡检\n"
    )
    sk = prepare_proactive_chat_session(
        agent_code="ops-bot",
        role_name="运维",
        thread_id="thread-hide-1",
        prompt=brief,
        round_id="round:hide",
        kind="think",
    )
    assert sk

    shown = msg_repo.list_messages_for_display_all(sk, max_rows=50, round_id="round:hide")
    texts = []
    for m in shown["messages"]:
        payload = m.get("content_json") if isinstance(m.get("content_json"), dict) else {}
        content = payload.get("content") if isinstance(payload, dict) else None
        texts.append(str(content or ""))
    joined = "\n".join(texts)
    assert "tasks(action=" not in joined
    assert "本轮值班开始 · 运维" in joined
    assert "例行巡检" in joined

    debug = msg_repo.list_messages_for_display_all(
        sk, max_rows=50, round_id="round:hide", include_hidden=True
    )
    assert len(debug["messages"]) >= 2
    assert any("tasks(action=" in str(m.get("content_json") or "") for m in debug["messages"])

    hydrated = list_lead_chat_rows_for_model_hydration(sk, limit=20, round_id="round:hide")
    assert any(str(r.get("tool_name") or "") == "proactive_duty_brief" for r in hydrated)


def test_list_messages_for_display_all_filters_by_round_id(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(tmp_path / "proactive-round-filter.db"))
    reset_db_for_tests()

    sk = proactive_session_key("ops-bot")
    tid_a = "thread-a"
    tid_b = "thread-b"
    sess_repo.upsert_session_row(
        sk,
        thread_id=tid_b,
        created_at_ms=1,
        updated_at_ms=1,
        message_count=0,
        context={"source": "proactive", "proactive_round_id": "round:b"},
        title="t",
    )
    msg_repo.append_message(
        sk,
        role="user",
        content="round a prompt",
        thread_id=tid_a,
        round_id="round:a",
        message_id="u-a",
    )
    msg_repo.append_message(
        sk,
        role="assistant",
        content="round a reply",
        thread_id=tid_a,
        round_id="round:a",
        message_id="a-a",
    )
    msg_repo.append_message(
        sk,
        role="user",
        content="round b prompt",
        thread_id=tid_b,
        round_id="round:b",
        message_id="u-b",
    )
    msg_repo.append_message(
        sk,
        role="assistant",
        content="round b reply",
        thread_id=tid_b,
        round_id="round:b",
        message_id="a-b",
    )

    all_rows = msg_repo.list_messages_for_display_all(sk, max_rows=50)
    assert len(all_rows["messages"]) == 4

    only_a = msg_repo.list_messages_for_display_all(sk, max_rows=50, round_id="round:a")
    assert only_a["round_id"] == "round:a"
    texts = []
    for m in only_a["messages"]:
        payload = m.get("content_json") if isinstance(m.get("content_json"), dict) else {}
        content = payload.get("content") if isinstance(payload, dict) else None
        if content is None:
            content = m.get("content")
        texts.append(str(content or ""))
    joined = "\n".join(texts)
    assert "round a" in joined
    assert "round b" not in joined
    assert all(m.get("round_id") == "round:a" for m in only_a["messages"])


def test_model_hydration_ignores_round_id_includes_full_tail(tmp_path, monkeypatch) -> None:
    """Model hydration no longer scopes by round_id — full session tail (or summary stitch)."""
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(tmp_path / "proactive-hydrate-chat.db"))
    reset_db_for_tests()

    sk = proactive_session_key("fe-bot")
    sess_repo.upsert_session_row(
        sk,
        thread_id="t-chat",
        created_at_ms=1,
        updated_at_ms=1,
        message_count=0,
        context={
            "source": "proactive",
            "employee_talk_mode": "chat",
            "proactive_round_id": "chat:2026-08-15T12:00:00Z",
        },
        title="t",
    )
    msg_repo.append_message(
        sk,
        role="user",
        content="旧值班",
        thread_id="t-duty",
        round_id="round:old",
        message_id="u-old",
    )
    msg_repo.append_message(
        sk,
        role="assistant",
        content="旧回复",
        thread_id="t-duty",
        round_id="round:old",
        message_id="a-old",
    )
    msg_repo.append_message(
        sk,
        role="user",
        content="闲聊你好",
        thread_id="t-chat",
        round_id="chat:2026-08-15T12:00:00Z",
        message_id="u-chat",
    )

    hydrated = list_lead_chat_rows_for_model_hydration(
        sk, limit=20, round_id="chat:2026-08-15T12:00:00Z"
    )
    texts = [str(r.get("content_json") or r.get("content") or "") for r in hydrated]
    joined = "\n".join(texts)
    assert "闲聊你好" in joined
    assert "旧值班" in joined  # round_id no longer filters model context


def test_model_hydration_ignores_duty_round_id(tmp_path, monkeypatch) -> None:
    """``round_id`` arg is ignored; hydration returns the full lead tail."""
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(tmp_path / "proactive-hydrate-round.db"))
    reset_db_for_tests()

    sk = proactive_session_key("fe-bot")
    sess_repo.upsert_session_row(
        sk,
        thread_id="t-b",
        created_at_ms=1,
        updated_at_ms=1,
        message_count=0,
        context={"source": "proactive", "proactive_round_id": "round:b"},
        title="t",
    )
    for i in range(5):
        msg_repo.append_message(
            sk,
            role="tool",
            content=f"old-{i}",
            thread_id="t-a",
            round_id="round:a",
            tool_call_id=f"old-{i}",
            tool_name="read",
            message_id=f"old-{i}",
        )
    msg_repo.append_message(
        sk,
        role="user",
        content="本轮值班",
        thread_id="t-b",
        round_id="round:b",
        message_id="u-b",
    )
    msg_repo.append_message(
        sk,
        role="assistant",
        content="开工探测",
        thread_id="t-b",
        round_id="round:b",
        message_id="a-b",
    )

    all_rows = list_lead_chat_rows_for_model_hydration(sk, limit=50)
    assert len(all_rows) >= 6

    scoped = list_lead_chat_rows_for_model_hydration(sk, limit=50, round_id="round:b")
    # round_id ignored — same as unscoped full tail
    assert len(scoped) == len(all_rows)
