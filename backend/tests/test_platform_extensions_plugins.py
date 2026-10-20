"""platform extensions.* / plugins.* handlers — Agent应用 + 插件市场."""

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


@pytest.fixture()
def ext_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "evoflow-home"
    monkeypatch.setenv("EVOFLOW_UI_EXTENSIONS_DIR", str(root))
    return root


@pytest.fixture()
def plugin_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    storage = tmp_path / "plugin-storage"
    monkeypatch.setenv("EVOFLOW_PLUGIN_STORAGE_ROOT", str(storage))
    return storage


def _make_ext_dir(tmp_path: Path, ext_id: str) -> Path:
    src = tmp_path / f"src-{ext_id}"
    src.mkdir()
    manifest = {
        "schema": 1,
        "id": ext_id,
        "name": ext_id,
        "version": "1.0.0",
        "ui": {"kind": "webview", "entry": "http://127.0.0.1:5173"},
        "permissions": ["embed"],
        "service": {"mode": "none"},
        "bridge": {"origin_allowlist": []},
    }
    (src / "evoflow.extension.json").write_text(json.dumps(manifest), encoding="utf-8")
    return src


def test_registry_includes_extensions_and_plugins() -> None:
    reg = get_registry()
    assert "extensions.list" in reg
    assert "extensions.install" in reg
    assert "plugins.overview" in reg
    assert "plugins.install" in reg
    assert reg["extensions.uninstall"].risk == "destructive"
    assert reg["plugins.uninstall"].risk == "destructive"


def test_extensions_remote_and_path_lifecycle(ext_home: Path, tmp_path: Path) -> None:
    remote = dispatch_platform_action(
        "extensions.install",
        args_json=json.dumps(
            {"id": "demo-ops", "name": "Demo Ops", "url": "https://example.com/ops"},
            ensure_ascii=False,
        ),
        confirm=True,
    )
    assert remote.get("ok") is True
    assert remote["id"] == "demo-ops"

    listed = dispatch_platform_action("extensions.list")
    assert listed.get("ok") is True
    assert any(r.get("id") == "demo-ops" for r in listed["extensions"])

    got = dispatch_platform_action("extensions.get", args_json=json.dumps({"id": "demo-ops"}))
    assert got.get("ok") is True
    assert got["extension"]["manifest"]["ui"]["entry"] == "https://example.com/ops"

    disabled = dispatch_platform_action(
        "extensions.enable",
        args_json=json.dumps({"id": "demo-ops", "enabled": False}),
        confirm=True,
    )
    assert disabled.get("ok") is True
    assert disabled["enabled"] is False

    src = _make_ext_dir(tmp_path, "local-ops")
    installed = dispatch_platform_action(
        "extensions.install",
        args_json=json.dumps({"path": str(src)}),
        confirm=True,
    )
    assert installed.get("ok") is True
    assert installed["id"] == "local-ops"
    assert (ext_home / "ui-extensions" / "local-ops" / "evoflow.extension.json").is_file()

    removed = dispatch_platform_action(
        "extensions.uninstall",
        args_json=json.dumps({"id": "demo-ops"}),
        confirm=True,
    )
    assert removed.get("ok") is True
    listed2 = dispatch_platform_action("extensions.list")
    ids = {r.get("id") for r in listed2["extensions"]}
    assert "demo-ops" not in ids
    assert "local-ops" in ids


def test_plugins_overview_and_install_flow(plugin_home: Path) -> None:
    overview = dispatch_platform_action("plugins.overview")
    assert overview.get("ok") is True
    assert overview.get("capability", {}).get("supported") is True
    official = [m for m in overview.get("marketplaces", []) if m.get("isOfficial")]
    assert official

    installed = dispatch_platform_action(
        "plugins.install",
        args_json=json.dumps(
            {"marketplace": "evoflow-plugins-official", "pluginName": "hello-command"}
        ),
        confirm=True,
    )
    assert installed.get("ok") is True
    plugin_id = "hello-command@evoflow-plugins-official"
    assert installed.get("id") == plugin_id

    listed = dispatch_platform_action("plugins.list")
    assert any(p.get("id") == plugin_id for p in listed.get("plugins", []))

    disabled = dispatch_platform_action(
        "plugins.enable",
        args_json=json.dumps({"pluginId": plugin_id, "enabled": False}),
        confirm=True,
    )
    assert disabled.get("ok") is True
    assert disabled.get("enabled") is False

    removed = dispatch_platform_action(
        "plugins.uninstall",
        args_json=json.dumps({"pluginId": plugin_id}),
        confirm=True,
    )
    assert removed.get("ok") is True

    restored = dispatch_platform_action(
        "plugins.restore",
        args_json=json.dumps({"pluginId": plugin_id}),
        confirm=True,
    )
    assert restored.get("ok") is True
