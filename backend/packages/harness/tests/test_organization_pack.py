"""Organization Pack Phase 1 — manifest + install/uninstall."""

from __future__ import annotations

import gc
import tempfile
from pathlib import Path

import pytest

from evoflow.config.paths import reset_paths_cache
from evoflow.persistence.db import get_db, reset_db_for_tests
from evoflow.persistence.schema import ensure_app_schema

_FIXTURE = (
    Path(__file__).resolve().parent / "fixtures" / "organization_packs" / "mini-team"
)
_EVOFLOW_ROOT = Path(__file__).resolve().parents[4]


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        monkeypatch.setenv("EVOFLOW_CONFIG_PATH", str(_EVOFLOW_ROOT / "config.yaml"))
        reset_paths_cache()
        reset_db_for_tests()
        ensure_app_schema(get_db())
        yield Path(tmp)
        reset_db_for_tests()
        reset_paths_cache()
        gc.collect()


def test_load_mini_team_manifest():
    from evoflow.organizations.manifest import load_pack_manifest

    pack = load_pack_manifest(_FIXTURE)
    assert pack.pack_id == "mini-team"
    assert pack.kind == "team"
    assert pack.manifest["name"] == "迷你测试团队"


def test_preflight_and_install_uninstall(sqlite_tmp: Path):
    from evoflow.admin import agents as agents_admin
    from evoflow.organizations.export import export_organization
    from evoflow.organizations.installer import (
        install_organization,
        preflight_organization,
        uninstall_organization,
    )
    from evoflow.organizations.manifest import load_pack_manifest
    from evoflow.organizations.registry import list_org_instances
    from evoflow.proactive.repositories import ProactiveRepository

    ws = sqlite_tmp / "ws-mini"
    source = {"type": "path", "path": str(_FIXTURE)}

    pre = preflight_organization(source=source, workspace_path=str(ws))
    assert pre["ok"] is True, pre
    assert "demo-clerk" in pre["will_install"]["agents"]
    assert "demo-clerk" in pre["will_install"]["employees"]

    inst = install_organization(source=source, workspace_path=str(ws))
    assert inst["pack_id"] == "mini-team"
    assert inst["status"] == "active"
    assert "demo-clerk" in (inst.get("artifacts") or {}).get("agents", [])
    assert "demo-clerk" in (inst.get("artifacts") or {}).get("employees", [])
    assert ws.is_dir()

    row = agents_admin.get_agent("demo-clerk")
    assert row.get("agent_code") == "demo-clerk"
    role = ProactiveRepository.get_role("demo-clerk")
    assert role is not None
    assert role.role_name == "演示文员"

    items = list_org_instances(status="active")
    assert any(i["org_instance_id"] == inst["org_instance_id"] for i in items)

    export_dir = sqlite_tmp / "exported-mini"
    exported = export_organization(
        pack={"id": "re-export-mini", "name": "再导出", "version": "1.0.1"},
        include={"employee_codes": ["demo-clerk"]},
        output={"dir": str(export_dir), "zip": True},
    )
    assert exported["ok"] is True
    assert (export_dir / "evoflow.organization.json").is_file()
    assert Path(exported["zip_path"]).is_file()
    reloaded = load_pack_manifest(export_dir)
    assert reloaded.pack_id == "re-export-mini"
    assert reloaded.kind == "team"

    out = uninstall_organization(inst["org_instance_id"], options={"keep_primitives": False})
    assert out["ok"] is True
    assert ProactiveRepository.get_role("demo-clerk") is None
    with pytest.raises(Exception):
        agents_admin.get_agent("demo-clerk")

    items2 = list_org_instances(status="active")
    assert not any(i["org_instance_id"] == inst["org_instance_id"] for i in items2)


def test_parse_github_raw_catalog_url():
    from evoflow.organizations.fetch import parse_github_raw_repo

    info = parse_github_raw_repo(
        "https://raw.githubusercontent.com/acme/evoflow-resource-market/main/catalog.json"
    )
    assert info == {"owner": "acme", "repo": "evoflow-resource-market", "branch": "main"}
    info2 = parse_github_raw_repo(
        "https://raw.githubusercontent.com/acme/repo/refs/heads/develop/catalog.json"
    )
    assert info2 == {"owner": "acme", "repo": "repo", "branch": "develop"}


def test_market_catalog_url_default(monkeypatch):
    from evoflow.organizations import fetch as fetch_mod

    monkeypatch.delenv("EVOFLOW_RESOURCE_MARKET_CATALOG_URL", raising=False)
    assert fetch_mod.market_catalog_url() == fetch_mod.DEFAULT_MARKET_CATALOG_URL
    monkeypatch.setenv("EVOFLOW_RESOURCE_MARKET_CATALOG_URL", "")
    assert fetch_mod.market_catalog_url() == ""
    monkeypatch.setenv(
        "EVOFLOW_RESOURCE_MARKET_CATALOG_URL",
        "https://raw.githubusercontent.com/acme/mkt/main/catalog.json",
    )
    assert fetch_mod.market_catalog_url().endswith("/acme/mkt/main/catalog.json")
