"""mirror_persist is disabled — TranscriptMiddleware owns assistant rows."""

from __future__ import annotations

from unittest.mock import patch

from evoflow.session_execution.mirror_persist import persist_partial_assistant_from_mirror


def test_mirror_persist_is_noop() -> None:
    with patch(
        "evoflow.persistence.chat_session_service.append_messages_batch_and_touch_session",
    ) as batch_mock:
        persist_partial_assistant_from_mirror(
            "agent:main:test",
            run_id="run-1",
            reason="user_stop",
        )
    batch_mock.assert_not_called()
