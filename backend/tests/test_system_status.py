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
    # 【self-evolution-bot · 2026-11-20 · 第70轮 · 模型:deepseek-v4.1-flash-1017】
    # 本用例原来假设「进程里没有真实运行时文件」。开发机上网关正在跑，
    # backend-runtime.json 里写着真实端口（8382），而 resolve_ports() 的
    # 优先级是 runtime 文件 > EVOFLOW_GATEWAY_PORT 环境变量，于是 8456
    # 被真实值盖掉 → 断言得到 8382 而红。这不是代码 bug，是测试没隔离环境。
    # 做法：把 runtime 文件候选清空，让 env 成为唯一来源。
    from evoflow.admin import system_status as _ss

    monkeypatch.setattr(_ss, "_runtime_state_candidates", lambda: [], raising=True)
    # EVOFLOW_GATEWAY_URL 在 resolve_gateway_base_url() 里优先级最高（甚至盖过
    # EVOFLOW_GATEWAY_PORT），开发机/网关环境下它总是指向真实端口。
    # 不清掉它，本用例在任何跑着网关的机器上都必红。
    monkeypatch.delenv("EVOFLOW_GATEWAY_URL", raising=False)
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
