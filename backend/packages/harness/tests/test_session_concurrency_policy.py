"""Session concurrency policy unit tests."""

from __future__ import annotations

from evoflow.session_concurrency_policy import (
    claim_priority_key,
    may_auto_cancel_other_thread,
    should_prefer_interactive_claim,
)


def test_may_cancel_only_same_thread():
    assert may_auto_cancel_other_thread(actor_thread_id="a", target_thread_id="a") is True
    assert may_auto_cancel_other_thread(actor_thread_id="a", target_thread_id="b") is False
    assert may_auto_cancel_other_thread(actor_thread_id="", target_thread_id="a") is False


def test_prefer_interactive_flag():
    run = {"kwargs": {"context": {"evf_interactive": True, "session_key": "agent:main:x"}}}
    assert should_prefer_interactive_claim(run) is True


def test_proactive_not_preferred():
    run = {"kwargs": {"context": {"session_key": "proactive:dev", "evf_interactive": False}}}
    assert should_prefer_interactive_claim(run) is False


def test_claim_priority_interactive_before_background():
    interactive = {
        "kwargs": {"context": {"evf_interactive": True}},
        "created_at": "2026-09-08T14:00:02+00:00",
    }
    background = {
        "kwargs": {"context": {"session_key": "proactive:x"}},
        "created_at": "2026-09-08T14:00:01+00:00",
    }
    assert claim_priority_key(interactive) < claim_priority_key(background)
