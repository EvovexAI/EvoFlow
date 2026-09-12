"""diagnostics admin: known log sources + anomaly timeline."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

from evoflow.admin import diagnostics as diag
from evoflow.admin.platform_actions import dispatch_platform_action, reset_registry_cache


def test_list_sources_marks_errors(tmp_path: Path, monkeypatch) -> None:
    logs = tmp_path / "logs"
    logs.mkdir()
    monkeypatch.setenv("EVOFLOW_LOGS_DIR", str(logs))

    day = datetime.now().strftime("%Y-%m-%d")
    (logs / f"evoflow-gateway-{day}.log").write_text(
        f"{day} 10:00:00 - app - INFO - boot ok\n"
        f"{day} 10:01:00 - app - ERROR - connection failed: ECONNREFUSED\n",
        encoding="utf-8",
    )
    (logs / "evopanel-startup.log").write_text(
        f"[{day} 09:59:00] sidecar spawned\n",
        encoding="utf-8",
    )

    out = diag.list_sources(hours=24)
    assert out["logs_dir"] == str(logs.resolve())
    assert "gateway" in out["sources_with_errors"]
    gateway = next(s for s in out["sources"] if s["id"] == "gateway")
    assert gateway["has_errors"] is True
    assert gateway["error_count"] >= 1
    startup = next(s for s in out["sources"] if s["id"] == "startup")
    assert startup["exists"] is True
    assert startup["has_errors"] is False


def test_timeline_markdown(tmp_path: Path, monkeypatch) -> None:
    logs = tmp_path / "logs"
    logs.mkdir()
    monkeypatch.setenv("EVOFLOW_LOGS_DIR", str(logs))
    day = datetime.now().strftime("%Y-%m-%d")
    (logs / f"frontend-{day}.log").write_text(
        f"[{day} 11:00:00.123] [ERROR] Uncaught TypeError: x is not a function\n",
        encoding="utf-8",
    )

    tl = diag.anomaly_timeline(hours=24, format="both")
    assert tl["ok"] is True
    assert "frontend" in tl["sources_with_errors"]
    assert "异常时间线" in tl["markdown"]
    assert any(e["source"] == "frontend" for e in tl["events"])


def test_platform_diagnostics_actions(tmp_path: Path, monkeypatch) -> None:
    logs = tmp_path / "logs"
    logs.mkdir()
    monkeypatch.setenv("EVOFLOW_LOGS_DIR", str(logs))
    reset_registry_cache()
    day = datetime.now().strftime("%Y-%m-%d")
    (logs / f"gateway-{day}.log").write_text(
        f"{day} 12:00:00 - x - ERROR - boom\n",
        encoding="utf-8",
    )

    sources = dispatch_platform_action("diagnostics.sources", args_json='{"hours":24}')
    assert sources.get("ok") is True
    assert "gateway" in (sources.get("sources_with_errors") or [])

    timeline = dispatch_platform_action(
        "diagnostics.timeline",
        args_json='{"hours":24,"format":"markdown"}',
    )
    assert timeline.get("ok") is True
    assert "markdown" in timeline
    reset_registry_cache()
