"""ask_clarification 中断时应立即落库 tool 行，避免 seq 排在用户澄清之后."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from langchain_core.messages import ToolMessage

from evoflow.agents.middlewares.transcript_middleware import (
    _written_message_ids,
    persist_transcript_tool_message_now,
)


def test_persist_clarification_tool_marks_written_and_dedupes() -> None:
    tid = "thread-clarify-persist-test"
    _written_message_ids.pop(tid, None)
    tool = ToolMessage(
        content='{"title":"t","questions":[]}',
        tool_call_id="call_test_1",
        name="ask_clarification",
        id="clarify-tool-call_test_1",
    )
    runtime = MagicMock()
    runtime.context = {"thread_id": tid}

    with patch(
        "evoflow.persistence.chat_session_service.append_messages_batch_and_touch_session",
        return_value={"appended": 1, "skipped": 0},
    ) as mock_append:
        with patch(
            "evoflow.agents.middlewares.transcript_middleware._session_key_for_thread",
            return_value="sess-1",
        ):
            with patch(
                "evoflow.agents.middlewares.transcript_middleware._run_id_for_transcript",
                return_value="run-1",
            ):
                assert persist_transcript_tool_message_now(runtime, tool, thread_id=tid) is True
                assert persist_transcript_tool_message_now(runtime, tool, thread_id=tid) is False

    mock_append.assert_called_once()
    batch = mock_append.call_args[0][1]
    assert batch[0]["role"] == "tool"
    assert batch[0]["tool_call_id"] == "call_test_1"
    assert batch[0]["id"] == "clarify-tool-call_test_1"
    _written_message_ids.pop(tid, None)
