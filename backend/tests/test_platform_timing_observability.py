"""Platform tool action timing → observability + skills-root context cache."""

from __future__ import annotations

import importlib
import json
import sqlite3
from pathlib import Path
from unittest.mock import MagicMock

from evoflow.observability.sqlite_store import ObservabilitySqliteStore, ObservabilityTable
from evoflow.observability.tool_timing import pop_tool_exec_detail

platform_tool_mod = importlib.import_module("evoflow.tools.builtins.platform_tool")
queries = importlib.import_module("evoflow.observability.queries")
loader = importlib.import_module("evoflow.skills.loader")


def test_platform_tool_notes_action_timing(monkeypatch) -> None:
    import evoflow.admin.platform_actions as pa

    monkeypatch.setattr(
        pa,
        "dispatch_platform_action",
        lambda action, **kwargs: {"ok": True, "action": action, "agents": []},
    )
    monkeypatch.setattr(platform_tool_mod, "_bind_runtime_identity", lambda *_a, **_k: None)
    monkeypatch.setattr(platform_tool_mod, "_principal_from_runtime", lambda *_a, **_k: "")
    monkeypatch.setattr(platform_tool_mod, "_session_from_runtime", lambda *_a, **_k: ("", ""))

    runtime = MagicMock()
    runtime.context = {}
    fn = getattr(platform_tool_mod.platform_tool, "func", None) or platform_tool_mod.platform_tool
    out = fn(
        action="agents.list",
        runtime=runtime,
        tool_call_id="plat-call-1",
        args_json="",
        domain="",
        confirm=False,
    )
    assert "agents" in out or "ok" in out
    detail = pop_tool_exec_detail("plat-call-1")
    assert detail is not None
    assert detail["kind"] == "platform"
    assert detail["action"] == "agents.list"
    assert detail["domain"] == "agents"
    assert detail["ok"] is True
    assert float(detail["exec_ms"]) >= 0


def test_platform_action_latency_stats(tmp_path: Path, monkeypatch) -> None:
    store = ObservabilitySqliteStore(tmp_path / "obs.db")
    for i, (action, exec_ms) in enumerate(
        [
            ("skills.list", 780.0),
            ("catalog", 8.0),
            ("agents.list", 210.0),
            ("skills.list", 35.0),
        ]
    ):
        store.insert_tool_invocation(
            thread_id="t",
            run_id=None,
            tool_call_id=f"p{i}",
            tool_name="platform",
            started_at="2026-11-08T22:00:00+08:00",
            ended_at="2026-11-08T22:00:01+08:00",
            duration_ms=exec_ms,
            status="success",
            input_obj={"action": action},
            output_text="{}",
            collab_phase=None,
            invocation_source="tool_middleware",
            timing={
                "kind": "platform",
                "action": action,
                "domain": action.split(".", 1)[0] if "." in action else action,
                "exec_ms": exec_ms,
                "ok": True,
            },
        )

    monkeypatch.setattr(queries, "_store", lambda: store)
    stats = queries._platform_action_latency_stats(store._connection(), since=None, limit=10)
    assert stats["sample_count"] == 4
    assert stats["by_action"][0]["action"] == "skills.list"
    assert stats["by_action"][0]["max_exec_ms"] == 780.0
    assert stats["slowest"][0]["action"] == "skills.list"
    assert "playbook" in stats


def test_skills_root_context_cache(monkeypatch) -> None:
    loader.clear_skills_cache()
    calls = {"n": 0}
    real = loader._describe_skills_root_context_uncached

    def counted():
        calls["n"] += 1
        return {"active": "/tmp/skills", "active_source": "test", "candidates": [], "warnings": []}

    monkeypatch.setattr(loader, "_describe_skills_root_context_uncached", counted)
    a = loader.describe_skills_root_context()
    b = loader.describe_skills_root_context()
    assert a["active"] == "/tmp/skills"
    assert b["active"] == "/tmp/skills"
    assert calls["n"] == 1
    loader.clear_skills_cache()
    c = loader.describe_skills_root_context()
    assert c["active"] == "/tmp/skills"
    assert calls["n"] == 2
    # restore for other tests
    monkeypatch.setattr(loader, "_describe_skills_root_context_uncached", real)
