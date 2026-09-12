"""Model hydration must retain the latest real user turn outside the tail window."""

from __future__ import annotations

import pytest

from evoflow.agents.message_analysis_utils import resolve_user_question_for_model_payload
from evoflow.persistence.chat_message_content import plain_text
from evoflow.persistence.chat_message_repositories import (
    append_message,
    list_lead_chat_rows_for_model_hydration,
)
from evoflow.persistence.db import reset_db_for_tests


@pytest.fixture
def chat_db(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(tmp_path / "hydrate_user_anchor.db"))
    reset_db_for_tests()
    return tmp_path


def _seed_tool_heavy_session(session_key: str, *, user_text: str, tool_rounds: int) -> None:
    append_message(session_key, role="user", content=user_text, message_id="u-anchor")
    for i in range(tool_rounds):
        append_message(
            session_key,
            role="assistant",
            content="",
            message_id=f"a{i}",
            content_json={
                "content": "",
                "tool_calls": [{"id": f"tc{i}", "name": "read_file", "args": {"path": f"/a{i}"}}],
            },
        )
        append_message(
            session_key,
            role="tool",
            content=f"body-{i}",
            message_id=f"t{i}",
            tool_call_id=f"tc{i}",
            tool_name="read_file",
        )


def test_list_lead_chat_rows_for_model_hydration_anchors_latest_user(chat_db) -> None:
    sk = "agent:test:hydrate-anchor"
    _seed_tool_heavy_session(sk, user_text="fix the auth bug", tool_rounds=25)

    tail_only = list_lead_chat_rows_for_model_hydration(sk, limit=40)
    user_rows = [r for r in tail_only if str(r.get("role") or "") == "user"]
    assert len(user_rows) == 1
    payload = user_rows[0].get("payload") if isinstance(user_rows[0].get("payload"), dict) else {}
    assert plain_text(payload) == "fix the auth bug"
    assert int(user_rows[0]["seq"]) < int(tail_only[1]["seq"])


def test_resolve_user_question_falls_back_to_transcript(chat_db) -> None:
    sk = "agent:test:resolve-user"
    _seed_tool_heavy_session(sk, user_text="deploy to staging", tool_rounds=25)

    text = resolve_user_question_for_model_payload([], session_key=sk)
    assert text == "deploy to staging"


def test_resolve_user_question_prefers_runtime_context() -> None:
    text = resolve_user_question_for_model_payload(
        [],
        runtime_context={"evf_user_question": "ship the hotfix"},
    )
    assert text == "ship the hotfix"
