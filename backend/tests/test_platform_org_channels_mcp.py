"""platform org.* / channels.* / settings.update_model / mcp fine-grained."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from evoflow.admin.platform_actions import dispatch_platform_action, get_registry, reset_registry_cache


@pytest.fixture(autouse=True)
def _reset_registry() -> None:
    reset_registry_cache()
    yield
    reset_registry_cache()


def test_registry_has_new_high_priority_actions() -> None:
    reg = get_registry()
    for name in (
        "settings.update_model",
        "mcp.list",
        "mcp.add",
        "mcp.remove",
        "mcp.test",
        "mcp.login",
        "mcp.logout",
        "org.preflight",
        "org.install",
        "org.list",
        "org.market_catalog",
        "channels.list",
        "channels.set_config",
        "channels.registration_begin",
    ):
        assert name in reg, name
    assert reg["org.uninstall"].risk == "destructive"
    assert reg["mcp.remove"].risk == "destructive"


def test_org_list_empty(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path / "home"))
    out = dispatch_platform_action("org.list", args_json=json.dumps({"status": "all"}))
    assert out.get("ok") is True
    assert out.get("count") == 0 or isinstance(out.get("items"), list)


def test_org_preflight_missing_path() -> None:
    out = dispatch_platform_action("org.preflight", args_json="{}")
    assert out.get("ok") is False
    assert "source" in str(out.get("error") or "").lower() or "path" in str(out.get("error") or "").lower()


def test_mcp_list_and_add_remove(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # Isolate MCP config via extensions config dir if respected; otherwise just exercise list.
    listed = dispatch_platform_action("mcp.list")
    assert listed.get("ok") is True

    added = dispatch_platform_action(
        "mcp.add",
        args_json=json.dumps(
            {
                "server": "platform-test-echo",
                "document": {
                    "enabled": False,
                    "command": "echo",
                    "args": ["ok"],
                },
            }
        ),
        confirm=True,
    )
    assert added.get("ok") is True, added

    removed = dispatch_platform_action(
        "mcp.remove",
        args_json=json.dumps({"server": "platform-test-echo"}),
        confirm=True,
    )
    assert removed.get("ok") is True, removed


def test_channels_list_degrades_without_service() -> None:
    out = dispatch_platform_action("channels.list")
    assert out.get("ok") is True
    assert "channels" in out or "service_running" in out


def test_channels_get_requires_name() -> None:
    out = dispatch_platform_action("channels.get", args_json="{}")
    assert out.get("ok") is False


def test_assets_init_and_eval_cases(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("EVOFLOW_ASSETS_ROOT", str(tmp_path / "assets"))
    init = dispatch_platform_action("assets.init", confirm=True)
    assert init.get("ok") is True
    assert init.get("root")

    cases = dispatch_platform_action("eval.cases")
    assert cases.get("ok") is True


def test_tasks_cleanup_defaults_dry_run() -> None:
    out = dispatch_platform_action("tasks.cleanup_noise", confirm=True)
    assert out.get("ok") is True
    assert out.get("dry_run") is True
