"""pending-inject in-memory queue (runtime-aligned; no SQLite)."""

from __future__ import annotations

from evoflow.persistence.pending_inject_repository import (
    clear_pending_inject_store_for_tests,
    consume_pending_injects,
    count_unconsumed_pending_injects,
    enqueue_pending_inject,
    list_unconsumed_pending_injects,
    pending_inject_last_consumed_info,
    pop_unconsumed_pending_injects,
)


def setup_function() -> None:
    clear_pending_inject_store_for_tests()


def teardown_function() -> None:
    clear_pending_inject_store_for_tests()


def test_enqueue_pending_inject_with_plain_content() -> None:
    sk = "agent:main:test-pending-inject-unit"
    mid = "msg-unit-plain-1"

    row = enqueue_pending_inject(sk, message_id=mid, content="steering text", role="user")
    assert row is not None
    assert row["message_id"] == mid
    assert row["content_json"].get("content") == "steering text"
    assert row.get("text") == "steering text"
    assert count_unconsumed_pending_injects(sk) == 1

    again = enqueue_pending_inject(sk, message_id=mid, content="steering text", role="user")
    assert again is None

    drained = consume_pending_injects(sk, consumed_by_run_id="run-1")
    assert any(r["message_id"] == mid for r in drained)
    assert count_unconsumed_pending_injects(sk) == 0

    last = pending_inject_last_consumed_info(sk)
    assert last is not None
    assert last["messageId"] == mid
    assert last.get("consumedByRunId") == "run-1"


def test_list_and_pop_unconsumed_pending_injects() -> None:
    sk = "agent:main:test-pending-inject-restore"

    enqueue_pending_inject(sk, message_id="m1", content="first steer")
    enqueue_pending_inject(sk, message_id="m2", content="second steer")

    listed = list_unconsumed_pending_injects(sk)
    assert [r["message_id"] for r in listed] == ["m1", "m2"]
    assert listed[0]["text"] == "first steer"
    assert count_unconsumed_pending_injects(sk) == 2

    # List is non-destructive
    assert count_unconsumed_pending_injects(sk) == 2

    popped = pop_unconsumed_pending_injects(sk)
    assert [r["message_id"] for r in popped] == ["m1", "m2"]
    assert count_unconsumed_pending_injects(sk) == 0
    assert list_unconsumed_pending_injects(sk) == []
    assert pop_unconsumed_pending_injects(sk) == []
