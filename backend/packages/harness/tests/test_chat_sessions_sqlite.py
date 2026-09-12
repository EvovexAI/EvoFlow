"""Chat session index in evoflow.db."""

from __future__ import annotations

import tempfile

import pytest

from evoflow.persistence import session_repositories as sess_repo
from evoflow.persistence.db import get_db, reset_db_for_tests


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_db_for_tests()
        get_db()
        yield
        reset_db_for_tests()


def test_chat_sessions_table_exists(sqlite_tmp: None) -> None:
    del sqlite_tmp
    cols = {r[1] for r in get_db().execute("PRAGMA table_info(evoflow_chat_sessions)").fetchall()}
    assert "session_key" in cols
    assert "thread_id" in cols
    assert "is_deleted" in cols
    assert "local_workspace_root" in cols
    assert "model_name" in cols
    assert "primary_model_name" in cols
    assert "session_status" in cols
    assert "hidden_from_list" in cols


def test_prewarmed_hidden_from_sidebar(sqlite_tmp: None) -> None:
    del sqlite_tmp
    sk = "agent:main:new-prewarm01"
    sess_repo.upsert_session_row(
        sk,
        thread_id="t-pw",
        title="新对话",
        updated_at_ms=9_999_999,
        session_status=sess_repo.SESSION_STATUS_PREWARMED,
        agent_id="main",
    )
    listed = sess_repo.list_sessions_for_ui(limit=20)
    assert not any(r["sessionKey"] == sk for r in listed)
    assert sk not in sess_repo.load_session_map()


def test_session_map_roundtrip(sqlite_tmp: None) -> None:
    del sqlite_tmp
    sess_repo.upsert_session_row(
        "agent:test:demo",
        thread_id="thread-abc",
        created_at_ms=1000,
        updated_at_ms=2000,
        message_count=3,
        context={
            "model_name": "gpt-4",
            "local_workspace_root": "D:/work/demo",
            "use_virtual_paths": False,
        },
    )
    m = sess_repo.load_session_map()
    assert "agent:test:demo" in m
    assert m["agent:test:demo"]["threadId"] == "thread-abc"
    assert m["agent:test:demo"]["messageCount"] == 3
    assert m["agent:test:demo"]["context"]["model_name"] == "gpt-4"
    assert m["agent:test:demo"]["context"]["local_workspace_root"] == "D:/work/demo"

    listed = sess_repo.list_sessions_for_ui(limit=10)
    row = next(s for s in listed if s["sessionKey"] == "agent:test:demo")
    assert row["threadId"] == "thread-abc"
    assert row["messageCount"] == 3
    assert row["modelName"] == "gpt-4"
    assert row["localWorkspaceRoot"] == "D:/work/demo"
    assert row["agentId"] == "test"

    sess_repo.mark_session_deleted("agent:test:demo")
    assert "agent:test:demo" not in sess_repo.load_session_map()
    assert "agent:test:demo" in sess_repo.list_tombstone_keys()


def test_upsert_does_not_overwrite_llm_title_with_placeholder(sqlite_tmp: None) -> None:
    del sqlite_tmp
    sk = "agent:main:new-deadbeef"
    formal = "季度复盘与下周计划"
    clipped = sess_repo.clip_session_sidebar_title(formal)
    sess_repo.upsert_session_row(sk, thread_id="t-title", title="新对话", updated_at_ms=1000)
    sess_repo.upsert_session_row(sk, thread_id="t-title", title=formal, updated_at_ms=2000)
    row = sess_repo.get_session_row_for_ui(sk)
    assert row is not None
    assert row["title"] == clipped
    sess_repo.upsert_session_row(sk, thread_id="t-title", title="新对话", updated_at_ms=3000)
    row2 = sess_repo.get_session_row_for_ui(sk)
    assert row2 is not None
    assert row2["title"] == clipped


def test_provisional_session_title_helpers(sqlite_tmp: None) -> None:
    del sqlite_tmp
    assert sess_repo.is_provisional_session_title("帮我写个脚本...")
    assert not sess_repo.is_provisional_session_title("季度复盘")
    assert sess_repo.is_replaceable_session_title("新对话")
    assert sess_repo.is_replaceable_session_title("短标题...")
    assert not sess_repo.is_replaceable_session_title("正式标题")
    assert sess_repo.provisional_session_title_from_user_text("hello") == "hello"
    assert sess_repo.provisional_session_title_from_user_text("hello world") == "hello world"
    cap = sess_repo.SESSION_SIDEBAR_TITLE_MAX_CHARS
    assert sess_repo.provisional_session_title_from_user_text("abcdefghijklmnop") == "abcdefghijklmnop"
    long_msg = "这是一段比较长的用户首条消息内容" + ("续" * cap)
    assert (
        sess_repo.provisional_session_title_from_user_text(long_msg)
        == long_msg[:cap].rstrip() + "..."
    )


def test_upsert_llm_title_overwrites_provisional(sqlite_tmp: None) -> None:
    del sqlite_tmp
    sk = "agent:main:new-provisional"
    sess_repo.upsert_session_row(sk, thread_id="t-prov", title="新对话", updated_at_ms=1000)
    sess_repo.upsert_session_row(sk, thread_id="t-prov", title="用户首条消息...", updated_at_ms=1500)
    row = sess_repo.get_session_row_for_ui(sk)
    assert row is not None
    assert row["title"] == "用户首条消息..."
    sess_repo.upsert_session_row(sk, thread_id="t-prov", title="LLM 生成的正式标题", updated_at_ms=2000)
    row2 = sess_repo.get_session_row_for_ui(sk)
    assert row2 is not None
    assert row2["title"] == sess_repo.clip_session_sidebar_title("LLM 生成的正式标题")


def test_append_first_user_message_sets_provisional_title(sqlite_tmp: None) -> None:
    del sqlite_tmp
    from evoflow.persistence.chat_session_service import append_message_and_touch_session

    sk = "agent:main:new-firstmsg"
    sess_repo.upsert_session_row(sk, thread_id="t-first", title="新对话", updated_at_ms=1000)
    user_text = "请帮我整理本周工作计划"
    expected_title = sess_repo.provisional_session_title_from_user_text(user_text)
    append_message_and_touch_session(
        sk,
        role="user",
        content=user_text,
        thread_id="t-first",
    )
    row = sess_repo.get_session_row_for_ui(sk)
    assert row is not None
    assert row["title"] == expected_title
    append_message_and_touch_session(
        sk,
        role="user",
        content="第二条不应改标题",
        thread_id="t-first",
    )
    row2 = sess_repo.get_session_row_for_ui(sk)
    assert row2 is not None
    assert row2["title"] == expected_title


def test_resolve_titles_by_thread_ids(sqlite_tmp: None) -> None:
    del sqlite_tmp
    sk1 = "agent:main:new-aaa111"
    sk2 = "agent:main:new-bbb222"
    sess_repo.upsert_session_row(sk1, thread_id="tid-alpha", title="Alpha 会话", updated_at_ms=1000)
    sess_repo.upsert_session_row(sk2, thread_id="tid-beta", title="新对话", updated_at_ms=1000)
    out = sess_repo.resolve_titles_by_thread_ids(["tid-alpha", "tid-beta", "tid-missing"])
    assert out == {"tid-alpha": "Alpha 会话"}


def test_upsert_new_session_without_existing_row_defaults_active_status(sqlite_tmp: None) -> None:
    """Regression: ensure-thread path inserts before any DB row (session_status omitted)."""
    del sqlite_tmp
    sk = "agent:main:new-4e5c7521"
    sess_repo.upsert_session_row(
        sk,
        thread_id="e0a20346-d447-438c-8dc6-7323eceb85ba",
        created_at_ms=1_700_000_000_000,
        updated_at_ms=1_700_000_000_000,
        message_count=0,
        context={},
        title="新对话",
    )
    row = sess_repo.get_session_row_for_ui(sk)
    assert row is not None
    assert row["threadId"] == "e0a20346-d447-438c-8dc6-7323eceb85ba"
    db_row = (
        get_db()
        .execute(
            "SELECT session_status FROM evoflow_chat_sessions WHERE session_key = ?",
            (sk,),
        )
        .fetchone()
    )
    assert db_row is not None
    assert db_row[0] == sess_repo.SESSION_STATUS_ACTIVE


def test_merge_session_map_keeps_extra_rows(sqlite_tmp: None) -> None:
    del sqlite_tmp
    sess_repo.upsert_session_row("agent:a:1", thread_id="t1", updated_at_ms=1000)
    sess_repo.upsert_session_row("agent:a:2", thread_id="t2", updated_at_ms=2000)
    sess_repo.merge_session_map({"agent:a:1": {"threadId": "t1", "updatedAt": 3000, "messageCount": 1}})
    m = sess_repo.load_session_map()
    assert "agent:a:1" in m and "agent:a:2" in m
    # Client clock must not overwrite DB activity time (would batch restart stamps).
    assert m["agent:a:1"]["updatedAt"] == 1000


def test_metadata_upsert_preserves_updated_at(sqlite_tmp: None) -> None:
    del sqlite_tmp
    sk = "agent:main:meta-preserve-updated"
    sess_repo.upsert_session_row(sk, thread_id="t-meta", updated_at_ms=1_700_000_000_000)
    before = sess_repo.get_session_row_for_ui(sk)["updatedAt"]
    sess_repo.upsert_session_row(sk, context={"memory_enabled": True}, updated_at_ms=0)
    after = sess_repo.get_session_row_for_ui(sk)["updatedAt"]
    assert after == before == 1_700_000_000_000


def test_summarize_sessions_by_workspace(sqlite_tmp: None) -> None:
    del sqlite_tmp
    from evoflow.persistence import workspace_repositories as ws_repo

    ws_repo.set_global_workspace_paths(["D:/work/project-a"])
    for i, root in enumerate(["D:/work/project-a", "D:/work/project-a", ""]):
        sess_repo.upsert_session_row(
            f"agent:main:ws-{i}",
            thread_id=f"t-ws-{i}",
            updated_at_ms=1000 + i,
            context={
                "local_workspace_root": root,
                "use_virtual_paths": False,
            },
        )
    sess_repo.upsert_session_row(
        "agent:main:virtual-1",
        thread_id="t-virtual",
        updated_at_ms=5000,
        context={"use_virtual_paths": True},
    )

    summaries = sess_repo.summarize_sessions_by_workspace_for_ui()
    by_key = {s["workspaceKey"]: s["sessionCount"] for s in summaries}
    assert by_key.get("d:/work/project-a") == 2
    assert by_key.get(sess_repo.WORKSPACE_GROUP_UNBOUND) == 1
    assert by_key.get(sess_repo.WORKSPACE_GROUP_VIRTUAL) == 1

    merged = sess_repo.merge_workspace_group_summaries_for_ui(
        summaries,
        ["D:/work/empty-folder"],
    )
    keys = [g["workspaceKey"] for g in merged]
    assert "d:/work/empty-folder" in keys
    empty = next(g for g in merged if g["workspaceKey"] == "d:/work/empty-folder")
    assert empty["sessionCount"] == 0


def test_list_sessions_filtered_by_workspace(sqlite_tmp: None) -> None:
    del sqlite_tmp
    sess_repo.upsert_session_row(
        "agent:main:bound-1",
        thread_id="t-bound-1",
        updated_at_ms=2000,
        context={"local_workspace_root": "D:/work/demo", "use_virtual_paths": False},
    )
    sess_repo.upsert_session_row(
        "agent:main:unbound-1",
        thread_id="t-unbound-1",
        updated_at_ms=3000,
        context={"local_workspace_root": "", "use_virtual_paths": False},
    )
    sess_repo.upsert_session_row(
        "proactive:frontend_architect",
        thread_id="t-proactive-1",
        updated_at_ms=4000,
        context={
            "source": "proactive",
            "proactive_agent_code": "frontend_architect",
            "local_workspace_root": "",
            "use_virtual_paths": False,
        },
    )

    bound = sess_repo.list_sessions_for_ui(limit=20, workspace_key="d:/work/demo")
    assert [r["sessionKey"] for r in bound] == ["agent:main:bound-1"]

    unbound = sess_repo.list_sessions_for_ui(limit=20, workspace_key=sess_repo.WORKSPACE_GROUP_UNBOUND)
    assert [r["sessionKey"] for r in unbound] == ["agent:main:unbound-1"]

    proactive = sess_repo.list_sessions_for_ui(
        limit=20, workspace_key=sess_repo.WORKSPACE_GROUP_PROACTIVE
    )
    assert [r["sessionKey"] for r in proactive] == ["proactive:frontend_architect"]

    summaries = sess_repo.summarize_sessions_by_workspace_for_ui()
    by_key = {s["workspaceKey"]: s["sessionCount"] for s in summaries}
    assert by_key.get(sess_repo.WORKSPACE_GROUP_UNBOUND) == 1
    assert by_key.get(sess_repo.WORKSPACE_GROUP_PROACTIVE) == 1

    merged = sess_repo.merge_workspace_group_summaries_for_ui(summaries, [])
    assert merged[0]["workspaceKey"] == sess_repo.WORKSPACE_GROUP_PROACTIVE


def test_workspace_group_key_normalizes_path_variants(sqlite_tmp: None) -> None:
    del sqlite_tmp
    variants = [
        "D:/work/demo",
        "d:/work/demo/",
        "D:\\work\\demo",
    ]
    for i, root in enumerate(variants):
        sess_repo.upsert_session_row(
            f"agent:main:variant-{i}",
            thread_id=f"t-variant-{i}",
            updated_at_ms=1000 + i,
            context={"local_workspace_root": root, "use_virtual_paths": False},
        )
    summaries = sess_repo.summarize_sessions_by_workspace_for_ui()
    demo_groups = [s for s in summaries if s.get("workspaceKey") == "d:/work/demo"]
    assert len(demo_groups) == 1
    assert demo_groups[0]["sessionCount"] == 3


def test_merge_workspace_groups_stable_sort_by_registered_order(sqlite_tmp: None) -> None:
    del sqlite_tmp
    from evoflow.persistence import workspace_repositories as ws_repo

    ws_repo.set_global_workspace_paths(["D:/work/alpha", "D:/work/beta"])
    sess_repo.upsert_session_row(
        "agent:main:old-in-alpha",
        thread_id="t-alpha",
        updated_at_ms=1000,
        context={"local_workspace_root": "D:/work/alpha", "use_virtual_paths": False},
    )
    sess_repo.upsert_session_row(
        "agent:main:new-in-beta",
        thread_id="t-beta",
        updated_at_ms=9_999_999,
        context={"local_workspace_root": "D:/work/beta", "use_virtual_paths": False},
    )
    summaries = sess_repo.summarize_sessions_by_workspace_for_ui()
    merged = sess_repo.merge_workspace_group_summaries_for_ui(
        summaries,
        ws_repo.list_global_workspace_paths(),
    )
    bound_keys = [
        g["workspaceKey"]
        for g in merged
        if g["workspaceKey"] not in (sess_repo.WORKSPACE_GROUP_UNBOUND, sess_repo.WORKSPACE_GROUP_VIRTUAL)
    ]
    assert bound_keys == ["d:/work/alpha", "d:/work/beta"]


def test_list_sessions_collab_task_id_prefers_thread_then_session_column(sqlite_tmp: None) -> None:
    """collabTaskId: thread bound_task_id first, then session collab_task_id column."""
    del sqlite_tmp
    from evoflow.persistence import task_repositories as task_repo

    sk = "agent:test:bind-task"
    thread = "thread-bind-task-1"
    bound = "Task_bound_session_1"
    stale = "Task_stale_column"
    sess_repo.upsert_session_row(
        sk,
        thread_id=thread,
        updated_at_ms=5000,
        collab_task_id=stale,
    )
    task_repo.save_thread_collab(thread, {"collab_phase": "executing", "bound_task_id": bound})
    listed = sess_repo.list_sessions_for_ui(limit=20)
    row = next(s for s in listed if s["sessionKey"] == sk)
    assert row.get("collabTaskId") == bound
    assert row.get("context", {}).get("collab_task_id") == bound

    # Thread rotated: no bound row on new thread, session column still resolves task id.
    new_thread = "thread-bind-task-2"
    sess_repo.upsert_session_row(sk, thread_id=new_thread, updated_at_ms=6000, collab_task_id=bound)
    listed2 = sess_repo.list_sessions_for_ui(limit=20)
    row2 = next(s for s in listed2 if s["sessionKey"] == sk)
    assert row2.get("collabTaskId") == bound


def test_automation_sessions_hidden_from_sidebar_until_unhide(sqlite_tmp: None) -> None:
    del sqlite_tmp
    sk = "automation:task-1:run-abc"
    sess_repo.upsert_session_row(
        sk,
        thread_id="t-auto-1",
        title="定时·demo·01-01 12:00",
        updated_at_ms=7000,
        context={"source": "automation", "automation_task_id": "task-1"},
    )
    sess_repo.set_session_hidden_from_list(sk, hidden=True)
    listed = sess_repo.list_sessions_for_ui(limit=20)
    assert not any(r["sessionKey"] == sk for r in listed)
    row = sess_repo.get_session_row_for_ui(sk)
    assert row is not None
    assert row.get("hiddenFromList") is True

    sess_repo.set_session_hidden_from_list(sk, hidden=False)
    listed2 = sess_repo.list_sessions_for_ui(limit=20)
    row2 = next(s for s in listed2 if s["sessionKey"] == sk)
    assert row2.get("hiddenFromList") is False
