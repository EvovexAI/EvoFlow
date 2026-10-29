"""Paginated ops lists: channel messages + media usage events."""

from __future__ import annotations

import uuid

import pytest


@pytest.fixture()
def ops_db(tmp_path, monkeypatch):
    db_path = tmp_path / f"ops_{uuid.uuid4().hex[:8]}.db"
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
    from evoflow.persistence.db import get_db, reset_db_for_tests
    from evoflow.persistence.schema import ensure_app_schema

    reset_db_for_tests()
    conn = get_db()
    ensure_app_schema(conn)
    yield conn
    reset_db_for_tests()
    monkeypatch.delenv("EVOFLOW_DB_PATH", raising=False)


def test_channel_push_list_paginated_enrich(ops_db):
    from evoflow.persistence.channel_push_repositories import list_paginated, record_push

    record_push(
        direction="inbound",
        channel="feishu",
        kind="im_message",
        event="callback",
        content_summary="hello inbound",
        payload={"msg_type": "text", "files": ["a.png"]},
        status="ok",
        triggered_by="user",
    )
    record_push(
        direction="outbound",
        channel="feishu",
        kind="im_message",
        event="sent",
        content_summary="hello outbound",
        payload={"attachments": ["out.pdf"], "thread_id": "t1"},
        status="ok",
        triggered_by="agent",
    )
    record_push(
        direction="outbound",
        channel="feishu",
        kind="approval_decision",
        event="callback",
        content_summary="approved",
        payload={"decision": "approved"},
        status="ok",
        triggered_by="user",
    )
    # Stream patches must not appear in the ops message list.
    record_push(
        direction="outbound",
        channel="feishu",
        kind="im_message",
        event="card_patched",
        content_summary="哈",
        payload={"is_final": False},
        status="ok",
        triggered_by="agent",
    )
    # Legacy bad inbound: human open_id stuffed into sender_account_id.
    record_push(
        direction="inbound",
        channel="feishu",
        kind="im_message",
        event="callback",
        content_summary="legacy peer",
        sender_account_id="ou_deadbeef",
        payload={"msg_type": "text", "account_id": ""},
        status="ok",
        triggered_by="user",
    )

    page = list_paginated(page=1, page_size=20, channel="feishu")
    assert page["total"] >= 3
    assert page["pages"] >= 1
    items = page["items"]
    assert all(i.get("event") != "card_patched" for i in items)
    assert not any(i.get("content_summary") == "哈" for i in items)
    assert any(i["display_status"] == "已接收" for i in items)
    assert any(i["display_status"] == "已回复" for i in items)
    inbound = next(i for i in items if i["direction"] == "inbound" and i["content_summary"] == "hello inbound")
    assert inbound["msg_type"] == "文本"
    assert inbound["attachment_count"] >= 1
    decision = next(i for i in items if i["kind"] == "approval_decision")
    assert decision["msg_type"] == "审批回执"
    assert decision["kind_label"] == "审批回执"
    # Actor labels present (primary bot when no employee code).
    assert "employee_name" in items[0]
    assert "bot_id" in items[0]
    legacy = next(i for i in items if i["content_summary"] == "legacy peer")
    assert legacy["employee_name"] == "主机器人"
    assert legacy.get("peer_user_id") == "ou_deadbeef"
    assert legacy.get("agent_code") == ""


def test_list_channel_bindings_from_table(ops_db):
    from evoflow.persistence.channel_push_repositories import list_channel_bindings
    from evoflow.persistence.config_repositories import upsert_bot_binding

    upsert_bot_binding(
        "feishu",
        "cli_test_app",
        agent_code="demo-analyst",
        enabled=True,
        bound_at="2026-04-01T12:00:00Z",
    )
    page = list_channel_bindings(channel="feishu")
    assert page["total"] >= 1
    row = next(i for i in page["items"] if i["bot_id"] == "cli_test_app")
    assert row["channel_label"] == "飞书"
    assert row["agent_code"] == "demo-analyst"
    assert row["status_label"] == "已绑定"
    assert row["bind_method_label"] in ("配置同步", "扫码绑定")


def test_self_intro_skips_raw_tool_wire_names(monkeypatch):
    from evoflow.proactive import self_intro as si

    monkeypatch.setattr(
        "evoflow.session_tool_binding.agent_tools.resolve_agent_tool_names_for_agent",
        lambda _code: ["read", "platform", "some_unknown_mcp_tool", "web_search"],
    )
    labels = si._tool_labels("demo")
    assert "读文件" in labels
    assert "管平台配置" in labels
    assert "上网搜索" in labels
    assert "some_unknown_mcp_tool" not in labels
    assert "platform" not in labels


def test_fetch_usage_events_media(ops_db):
    from evoflow.persistence.usage_ledger import (
        fetch_usage_events,
        record_media_generation_usage,
    )

    ok = record_media_generation_usage(
        media_kind="image",
        provider="jimeng",
        model="seedream-4",
        task_id="task_img_1",
        status="succeeded",
        thread_id="thread_abc",
        prompt="a cat sitting on a desk",
        remote_url="https://example.com/cat.png",
        vendor_cost=0.02,
        vendor_currency="USD",
        agent_code="artist",
        meta={"prompt": "a cat sitting on a desk"},
    )
    assert ok is True

    page = fetch_usage_events(category="media", page=1, page_size=20)
    assert page["total"] >= 1
    row = page["items"][0]
    assert row["media_kind"] == "image"
    assert row["model"] == "seedream-4"
    assert row["amount"] > 0
    assert "cat" in (row.get("content_preview") or "")
    assert row.get("result_url") or row.get("remote_url")
