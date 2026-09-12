"""Tests for per-session tool approval policy persistence."""

from __future__ import annotations

from evoflow.persistence.session_repositories import upsert_session_row
from evoflow.persistence.tool_approval_policy import (
    get_session_policy_raw,
    set_session_policy,
)


def test_set_session_policy_upserts_when_row_missing() -> None:
    sk = "agent:main:test-policy-upsert"
    set_session_policy(sk, "prompt")
    assert get_session_policy_raw(sk) == "prompt"


def test_set_session_policy_updates_existing_row() -> None:
    sk = "agent:main:test-policy-update"
    upsert_session_row(sk, thread_id="tid-policy", title="policy test")
    set_session_policy(sk, "grant_all")
    assert get_session_policy_raw(sk) == "grant_all"


def test_set_session_policy_clear() -> None:
    sk = "agent:main:test-policy-clear"
    upsert_session_row(sk, thread_id="tid-clear", title="clear")
    set_session_policy(sk, "session")
    set_session_policy(sk, None)
    assert get_session_policy_raw(sk) is None
