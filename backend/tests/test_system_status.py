"""diagnostics.status / system_status snapshot basics."""

from __future__ import annotations

from evoflow.admin.platform_handlers import diagnostics_status
from evoflow.admin.system_status import build_system_status_snapshot, format_system_status_markdown


def test_build_system_status_snapshot_has_required_fields(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path / "data"))
    monkeypatch.setenv("EVOFLOW_GATEWAY_PORT", "8382")
    monkeypatch.setenv("EVOFLOW_WEBUI_HTTP_PORT", "1420")
    monkeypatch.setenv("EVOFLOW_INSTALL_DIR", str(tmp_path / "install"))

    snap = build_system_status_snapshot()
    assert snap["ok"] is True
    assert snap["overall"] in {"healthy", "degraded", "unhealthy", "unknown", "running"}
    assert snap["ports"]["backend"] == 8382
    assert snap["ports"]["frontend"] == 1420
    assert any(row.get("role") == "backend" and row.get("port") == 8382 for row in snap["ports"]["system"])
    assert "data" in str(snap["paths"]["data_dir"]).replace("\\", "/")
    assert snap["install"]["path"]
    assert "系统运行状态" in snap["markdown"]
    assert "后端" in snap["markdown"]
    assert "数据目录" in snap["markdown"]
    assert "安装目录" in snap["markdown"]


def test_diagnostics_status_handler_wraps_snapshot(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path / "data"))
    monkeypatch.setenv("EVOFLOW_GATEWAY_PORT", "8456")
    out = diagnostics_status({})
    assert out["ok"] is True
    assert out["action"] == "diagnostics.status"
    assert out["ports"]["backend"] == 8456
    assert out["markdown"]


def test_format_markdown_lists_ports():
    md = format_system_status_markdown(
        {
            "overall": "healthy",
            "generated_at": "2026-01-01 00:00:00",
            "ports": {
                "backend": 8001,
                "frontend": 1420,
                "gateway": 8001,
                "system": [
                    {"role": "backend", "port": 8001},
                    {"role": "frontend", "port": 1420},
                ],
                "gateway_base_url": "http://127.0.0.1:8001",
            },
            "paths": {"data_dir": "D:/data", "base_dir": "D:/"},
            "install": {"path": "D:/install"},
            "service": {"status": "healthy", "pid": 1},
            "ready": {"ready": True, "phase": "ready"},
            "runtime": {"summary": {"automation_running": True, "task_queue_running": True}},
        }
    )
    assert "8001" in md
    assert "1420" in md
    assert "D:/data" in md
    assert "D:/install" in md
