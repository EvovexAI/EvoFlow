"""soul-summary.md must not shadow a newer SOUL.md (UI edit → next turn)."""

from __future__ import annotations

import threading
from pathlib import Path

from evoflow.assets import paths as assets_paths
from evoflow.assets.paths import EntityRef, profile_path
from evoflow.assets.soul_summary import (
    consolidate_soul_summary_for_entity,
    load_soul_summary_text,
    schedule_soul_summary_consolidate,
)
from evoflow.agents.lead_agent.prompt import _load_agent_soul_text


def test_stale_summary_falls_back_to_live_extract(tmp_path: Path, monkeypatch) -> None:
    code = "freshness-agent"
    ent = EntityRef("agent", code)
    monkeypatch.setattr(assets_paths, "assets_root", lambda: tmp_path)

    soul_path = profile_path(ent, "SOUL.md")
    soul_path.parent.mkdir(parents=True, exist_ok=True)
    soul_path.write_text("# Old\n\nold persona line\n", encoding="utf-8")
    consolidate_soul_summary_for_entity(ent)

    assert "old persona" in load_soul_summary_text(code)

    # Simulate UI save: SOUL newer than summary, summary still old body.
    soul_path.write_text("# New\n\nbrand new persona marker XYZ\n", encoding="utf-8")
    assert load_soul_summary_text(code) == ""  # stale → empty

    monkeypatch.setattr(
        "evoflow.agents.lead_agent.prompt.load_agent_soul",
        lambda _name: soul_path.read_text(encoding="utf-8"),
    )
    text = _load_agent_soul_text(code)
    assert "brand new persona marker XYZ" in text
    assert "old persona" not in text


def test_schedule_delay_zero_does_not_deadlock(tmp_path: Path, monkeypatch) -> None:
    """save_agent_soul(delay_s=0) must not hold _timer_lock across _run (non-reentrant)."""
    ent = EntityRef("agent", "deadlock-agent")
    monkeypatch.setattr(assets_paths, "assets_root", lambda: tmp_path)
    soul_path = profile_path(ent, "SOUL.md")
    soul_path.parent.mkdir(parents=True, exist_ok=True)
    soul_path.write_text("# Soul\n\nok\n", encoding="utf-8")

    done = threading.Event()

    def _target() -> None:
        schedule_soul_summary_consolidate(ent, delay_s=0)
        done.set()

    t = threading.Thread(target=_target, daemon=True)
    t.start()
    assert done.wait(timeout=3.0), "schedule_soul_summary_consolidate(delay_s=0) deadlocked"
    summary = profile_path(ent, "soul-summary.md")
    assert summary.is_file()
    assert "ok" in summary.read_text(encoding="utf-8")
