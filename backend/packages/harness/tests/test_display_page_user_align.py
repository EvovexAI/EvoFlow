"""Display pagination aligns page start to the owning user turn."""

from __future__ import annotations

import pytest

from evoflow.persistence import chat_message_repositories as msg_repo
from evoflow.persistence import session_repositories as sess_repo
from evoflow.persistence.db import reset_db_for_tests


@pytest.fixture
def chat_db(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(tmp_path / "display-page.db"))
    reset_db_for_tests()
    sk = "agent:test:page-align"
    sess_repo.upsert_session_row(
        sk,
        thread_id="t-page-align",
        created_at_ms=1,
        updated_at_ms=1,
        message_count=0,
        context={},
        title="t",
    )
    yield sk
    reset_db_for_tests()


def test_display_paginated_extends_to_owning_user(chat_db: str) -> None:
    sk = chat_db
    msg_repo.append_message(sk, role="user", content="帮我看下", run_id="run-1")
    msg_repo.append_message(sk, role="assistant", content="先查", run_id="run-1")
    msg_repo.append_message(sk, role="assistant", content="结论好了", run_id="run-1")
    for i in range(5):
        msg_repo.append_message(sk, role="user", content=f"追问{i}", run_id=f"run-x{i}")
        msg_repo.append_message(sk, role="assistant", content=f"答{i}", run_id=f"run-x{i}")

    # Newest 3 in ASC often start on an assistant (… asst, user, asst). Align should
    # prepend the owning user so the page does not open mid-turn.
    page = msg_repo.list_messages_for_display_paginated(sk, limit=3)
    msgs = page["messages"]
    assert msgs
    assert msgs[0].get("role") == "user"
    assert page.get("oldest_seq") is not None
