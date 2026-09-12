"""UI preview helpers for large tool outputs (content lives in evoflow_chat_messages)."""

from __future__ import annotations

import json
import tempfile

import pytest

from evoflow.persistence import chat_message_repositories as msg_repo
from evoflow.persistence.db import get_db, reset_db_for_tests
from evoflow.persistence.schema import ensure_app_schema
from evoflow.tools.tool_result_store import (
    build_preview_text,
    should_offload_for_ui,
    slim_content_for_ui,
)


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_db_for_tests()
        ensure_app_schema(get_db())
        yield
        reset_db_for_tests()


def test_should_offload_read_file_not_terminal():
    assert should_offload_for_ui("read_file", "x" * 2000) is True
    assert should_offload_for_ui("read", "x" * 200) is True
    assert should_offload_for_ui("terminal", "x" * 5000) is False
    assert should_offload_for_ui("read_file", "small") is True
    assert should_offload_for_ui("read_file", "Error: file not found") is True
    assert should_offload_for_ui("read_file", "") is False
    assert should_offload_for_ui("read_file", "\n".join(f"line {i}" for i in range(20))) is True


def test_slim_and_fetch_from_chat_messages(sqlite_tmp):
    del sqlite_tmp
    sk = "agent:main:default"
    body = "line\n" * 500
    msg_repo.append_message(
        sk,
        role="tool",
        content_json={"content": body},
        tool_call_id="call-read-1",
        tool_name="read_file",
        message_id="tool-msg-1",
    )

    preview, meta = slim_content_for_ui("call-read-1", "read_file", body)
    assert meta.get("truncated") is True
    assert preview == ""
    assert preview != body

    payload = msg_repo.get_tool_result_for_display(sk, "call-read-1")
    assert payload is not None
    assert payload["content"] == body
    assert payload["toolCallId"] == "call-read-1"


def test_tool_result_includes_assistant_args(sqlite_tmp):
    del sqlite_tmp
    sk = "agent:main:write-args"
    msg_repo.append_message(
        sk,
        role="assistant",
        content_json={
            "content": "",
            "tool_calls": [
                {
                    "id": "call-write-1",
                    "name": "write_to_file",
                    "args": {
                        "path": "src/a.ts",
                        "content": "line1\nline2\n",
                    },
                }
            ],
        },
        message_id="asst-1",
    )
    msg_repo.append_message(
        sk,
        role="tool",
        content_json={"content": "OK: wrote 12 bytes to src/a.ts"},
        tool_call_id="call-write-1",
        tool_name="write_to_file",
        message_id="tool-msg-1",
    )
    payload = msg_repo.get_tool_result_for_display(sk, "call-write-1")
    assert payload is not None
    assert payload["args"]["path"] == "src/a.ts"
    assert payload["args"]["content"].startswith("line1")
    assert payload["content"].startswith("OK:")


def test_slim_search_and_web_tools_empty_on_ui():
    for name in ("grep", "search_code_index", "web_search", "web_fetch", "ls", "read_lints", "browser_snapshot"):
        preview, meta = slim_content_for_ui("call-x", name, "x" * 200)
        assert preview == "", name


def test_pending_clarification_from_transcript(sqlite_tmp):
    del sqlite_tmp
    sk = "agent:main:clarify-pending"
    preview = json.dumps(
        {
            "title": "需求确认",
            "questions": [
                {
                    "id": "q1",
                    "prompt": "选哪个方向？",
                    "options": [{"id": "opt_1", "label": "A. 方案一"}, {"id": "opt_2", "label": "B. 方案二"}],
                }
            ],
        },
        ensure_ascii=False,
    )
    msg_repo.append_message(sk, role="user", content_json={"content": "帮我设计"}, message_id="u1")
    msg_repo.append_message(
        sk,
        role="assistant",
        content_json={
            "content": "",
            "tool_calls": [
                {
                    "id": "call-ask-1",
                    "name": "ask_clarification",
                    "args": {
                        "title": "需求确认",
                        "questions": [{"prompt": "选哪个方向？", "options": ["方案一", "方案二"]}],
                    },
                }
            ],
        },
        message_id="a1",
    )
    msg_repo.append_message(
        sk,
        role="tool",
        content_json={"content": preview},
        tool_call_id="call-ask-1",
        tool_name="ask_clarification",
        message_id="t1",
    )
    payload = msg_repo.get_pending_clarification_for_session(sk)
    assert payload is not None
    assert payload["toolCallId"] == "call-ask-1"
    assert "选哪个方向" in payload["content"] or payload["args"].get("questions")

    msg_repo.append_message(
        sk,
        role="user",
        content_json={"content": "__EVF_CLARIFY_ANS_V1__: {\"answers\":[]}"},
        message_id="u2",
    )
    assert msg_repo.get_pending_clarification_for_session(sk) is None


def test_pending_clarification_from_tool_row_only(sqlite_tmp):
    del sqlite_tmp
    sk = "agent:main:clarify-tool-only"
    preview = json.dumps(
        {
            "title": "需求确认",
            "questions": [{"id": "q1", "prompt": "选哪个方向？", "options": ["A", "B"]}],
        },
        ensure_ascii=False,
    )
    msg_repo.append_message(sk, role="user", content_json={"content": "帮我设计"}, message_id="u1")
    msg_repo.append_message(
        sk,
        role="tool",
        content_json={"content": preview},
        tool_call_id="call-ask-tool-only",
        tool_name="ask_clarification",
        message_id="t1",
    )
    payload = msg_repo.get_pending_clarification_for_session(sk)
    assert payload is not None
    assert payload["toolCallId"] == "call-ask-tool-only"


def test_build_preview_text_truncates():
    body = "\n".join(f"row {i}" for i in range(200))
    preview = build_preview_text(body, max_chars=400)
    assert len(preview) < len(body)


def test_list_messages_for_display_content_json_only(sqlite_tmp):
    del sqlite_tmp
    sk = "agent:main:display-shape"
    msg_repo.append_message(sk, role="user", content="hello user", message_id="u1")
    body = "line\n" * 500
    msg_repo.append_message(
        sk,
        role="tool",
        content_json={"content": body},
        tool_call_id="call-read-disp",
        tool_name="read_file",
        message_id="t1",
    )
    display = msg_repo.list_messages_for_display(sk, limit=10)
    assert len(display) == 2
    for row in display:
        assert "content" not in row
        assert isinstance(row.get("content_json"), dict)
    assert display[0]["content_json"]["content"] == "hello user"
    tool = display[1]
    assert tool["content_json"]["content"] == ""
    assert tool.get("truncated") is True
    assert tool.get("output_truncated") is True
