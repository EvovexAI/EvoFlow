"""org pack drift audit — pack vs runtime."""

from __future__ import annotations

import json
from pathlib import Path


def test_audit_pack_drift_missing_agent(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("EVOFLOW_CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))

    pack = tmp_path / "pack"
    (pack / "agents").mkdir(parents=True)
    (pack / "employees").mkdir()
    (pack / "agents" / "demo.SOUL.md").write_text("你是演示员工。\n", encoding="utf-8")
    (pack / "agents" / "demo.yaml").write_text(
        "name: demo\nagent_code: demo\nsystem_prompt_file: ./demo.SOUL.md\n",
        encoding="utf-8",
    )
    (pack / "employees" / "demo.json").write_text(
        json.dumps({"agent_code": "demo", "name": "演示"}, ensure_ascii=False),
        encoding="utf-8",
    )
    (pack / "evoflow.organization.json").write_text(
        json.dumps(
            {
                "schema": 1,
                "kind": "team",
                "id": "demo-pack",
                "name": "Demo",
                "version": "9.9.9",
                "primitives": {"agents": [{"from": "./agents/demo.yaml"}]},
                "team": {"employees": [{"from": "./employees/demo.json"}]},
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    # Stub registry / agent exists to avoid needing full DB
    monkeypatch.setattr(
        "evoflow.persistence.config_repositories.agent_exists",
        lambda _code: False,
    )
    monkeypatch.setattr(
        "evoflow.config.agents_config.load_agent_soul",
        lambda _code: None,
    )
    monkeypatch.setattr(
        "evoflow.admin.ui_extensions_registry.read_registry",
        lambda: [],
    )
    monkeypatch.setattr(
        "evoflow.organizations.registry.list_org_instances",
        lambda status="": [],
    )

    from evoflow.organizations.drift import audit_pack_drift

    report = audit_pack_drift(str(pack))
    assert report["pack_id"] == "demo-pack"
    assert report["summary"]["agent_drift"] == 1
    assert report["agents"][0]["status"] == "missing_in_runtime"
    assert "sync" in report["recommendation"]
