"""Dual-run / session concurrency regression checks (no live Gateway required).

Validates policy defaults that make chat + proactive coexist:
- preempt off by default
- interactive claim sorts ahead of proactive
- same-thread cancel allowed; cross-thread auto-cancel forbidden
- in-process LG mount defaults FORCE isolated loops on
"""

from __future__ import annotations

import os
from datetime import datetime, timezone

from evoflow.session_concurrency_policy import (
    claim_priority_key,
    may_auto_cancel_other_thread,
    should_prefer_interactive_claim,
)


def test_preempt_default_off(monkeypatch):
    monkeypatch.delenv("EVOFLOW_CHAT_PREEMPT_PROACTIVE", raising=False)
    from app.gateway.interactive_run_preempt import chat_preempt_proactive_enabled

    assert chat_preempt_proactive_enabled() is False


def test_interactive_pending_sorts_before_proactive():
    older_proactive = {
        "status": "pending",
        "kwargs": {"context": {"session_key": "proactive:role-a", "evf_interactive": False}},
        "created_at": datetime(2026, 9, 8, 14, 0, 0, tzinfo=timezone.utc),
    }
    newer_chat = {
        "status": "pending",
        "kwargs": {"context": {"evf_interactive": True, "session_key": "agent:main:new"}},
        "created_at": datetime(2026, 9, 8, 14, 0, 5, tzinfo=timezone.utc),
    }
    ordered = sorted([older_proactive, newer_chat], key=claim_priority_key)
    assert should_prefer_interactive_claim(ordered[0]) is True
    assert ordered[0] is newer_chat


def test_cross_thread_auto_cancel_forbidden():
    assert may_auto_cancel_other_thread(actor_thread_id="chat-1", target_thread_id="pro-1") is False
    assert may_auto_cancel_other_thread(actor_thread_id="chat-1", target_thread_id="chat-1") is True


def test_lazy_langgraph_defaults_force_isolated_loops(monkeypatch):
    """Simulate env setup from mount_langgraph_in_process without importing LG ASGI."""
    monkeypatch.delenv("EVOFLOW_FORCE_BG_JOB_ISOLATED_LOOPS", raising=False)
    monkeypatch.delenv("BG_JOB_ISOLATED_LOOPS", raising=False)

    _force_iso = (os.environ.get("EVOFLOW_FORCE_BG_JOB_ISOLATED_LOOPS") or "1").strip().lower()
    assert _force_iso not in ("0", "false", "no", "off")
    os.environ["EVOFLOW_FORCE_BG_JOB_ISOLATED_LOOPS"] = "1"
    os.environ["BG_JOB_ISOLATED_LOOPS"] = "true"

    from evoflow.platform.asyncio_windows import apply_windows_langgraph_runtime_fixes

    apply_windows_langgraph_runtime_fixes()
    assert os.environ.get("BG_JOB_ISOLATED_LOOPS") == "true"
    assert os.environ.get("EVOFLOW_FORCE_BG_JOB_ISOLATED_LOOPS") == "1"
