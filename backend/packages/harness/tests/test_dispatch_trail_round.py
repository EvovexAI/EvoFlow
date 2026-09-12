"""Dispatch work-trail round_id must match chat transcript stamps."""

from __future__ import annotations

from evoflow.persistence import chat_message_repositories as msg_repo
from evoflow.persistence import session_repositories as sess_repo
from evoflow.persistence.db import get_db, reset_db_for_tests
from evoflow.proactive.chat_session import resolve_transcript_round_id
from evoflow.timeutil import utc_now_iso_z


def test_resolve_dispatch_to_round_when_exact_missing(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(tmp_path / "dispatch-trail.db"))
    monkeypatch.delenv("EVOFLOW_DATA_DIR", raising=False)
    reset_db_for_tests()

    sk = "proactive:quality-inspector"
    dispatch = f"dispatch:{utc_now_iso_z()}"
    think = f"round:{utc_now_iso_z()}"

    sess_repo.upsert_session_row(
        sk,
        thread_id="tid-1",
        created_at_ms=1,
        updated_at_ms=1,
        message_count=0,
        context={"source": "proactive"},
        title="QI",
    )
    msg_repo.append_message(
        sk,
        role="user",
        content="duty brief",
        thread_id="tid-1",
        round_id=think,
        message_id="u1",
    )
    msg_repo.append_message(
        sk,
        role="assistant",
        content="working",
        thread_id="tid-1",
        round_id=think,
        message_id="a1",
    )

    assert resolve_transcript_round_id(sk, dispatch) == think
    assert resolve_transcript_round_id(sk, think) == think


def test_resolve_keeps_dispatch_when_messages_already_stamped(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(tmp_path / "dispatch-trail-exact.db"))
    monkeypatch.delenv("EVOFLOW_DATA_DIR", raising=False)
    reset_db_for_tests()

    sk = "proactive:quality-inspector"
    dispatch = f"dispatch:{utc_now_iso_z()}"

    sess_repo.upsert_session_row(
        sk,
        thread_id="tid-2",
        created_at_ms=1,
        updated_at_ms=1,
        message_count=0,
        context={"source": "proactive"},
        title="QI",
    )
    msg_repo.append_message(
        sk,
        role="user",
        content="dispatch brief",
        thread_id="tid-2",
        round_id=dispatch,
        message_id="u2",
    )

    assert resolve_transcript_round_id(sk, dispatch) == dispatch
    # Sanity: DB has the stamped row
    row = get_db().execute(
        "SELECT round_id FROM evoflow_chat_messages WHERE session_key = ?",
        (sk,),
    ).fetchone()
    assert str(row["round_id"]) == dispatch
