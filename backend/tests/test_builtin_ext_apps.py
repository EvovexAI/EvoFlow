"""系统内置 UI 扩展应用（演示工作台）— 安装/刷新 + gateway 静态 serve。"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from evoflow.admin import builtin_ext_apps
from evoflow.admin import ui_extensions_registry as registry

ORIGIN = "http://127.0.0.1:38012"


@pytest.fixture()
def ext_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / "evoflow-home"
    monkeypatch.setenv("EVOFLOW_UI_EXTENSIONS_DIR", str(home))
    return home


def _installed_dir(home: Path) -> Path:
    return home / "ui-extensions" / "demo-workbench"


def _registry_rows(home: Path) -> list[dict]:
    return registry.read_registry()


def test_builtin_app_source_exists() -> None:
    apps = builtin_ext_apps.iter_builtin_ext_app_dirs()
    ids = [app_id for app_id, _ in apps]
    assert "demo-workbench" in ids
    src = dict(apps)["demo-workbench"]
    assert (src / "index.html").is_file()
    assert (src / "app.js").is_file()
    assert (src / "styles.css").is_file()
    template = json.loads((src / "evoflow.extension.json").read_text(encoding="utf-8-sig"))
    assert template["ui"]["entry"].startswith(builtin_ext_apps.GATEWAY_ORIGIN_PLACEHOLDER)


def test_first_install_copies_source_and_registers(ext_home: Path) -> None:
    actions = builtin_ext_apps.ensure_builtin_ext_apps_registered(ORIGIN)
    by_id = {a["id"]: a["action"] for a in actions}
    assert by_id["demo-workbench"] == "installed"

    dest = _installed_dir(ext_home)
    assert (dest / "index.html").is_file()
    manifest = json.loads((dest / "evoflow.extension.json").read_text(encoding="utf-8-sig"))
    # 占位符已渲染成本机网关 origin，且带 serve=gateway 标记
    assert manifest["ui"]["entry"] == ORIGIN + "/api/ui-ext-apps/demo-workbench/"
    assert manifest["ui"]["serve"] == "gateway"
    assert "__EVOFLOW_GATEWAY_ORIGIN__" not in json.dumps(manifest)

    rows = _registry_rows(ext_home)
    row = next(r for r in rows if r["id"] == "demo-workbench")
    assert row["source"] == builtin_ext_apps.BUILTIN_SOURCE_TAG
    assert row["enabled"] is True
    assert Path(row["install_path"]) == dest


def test_second_run_keeps_user_edits(ext_home: Path) -> None:
    builtin_ext_apps.ensure_builtin_ext_apps_registered(ORIGIN)
    dest = _installed_dir(ext_home)
    (dest / "app.js").write_text("// user edit", encoding="utf-8")

    actions = builtin_ext_apps.ensure_builtin_ext_apps_registered(ORIGIN)
    by_id = {a["id"]: a["action"] for a in actions}
    assert by_id["demo-workbench"] == "kept"
    assert (dest / "app.js").read_text(encoding="utf-8") == "// user edit"


def test_version_bump_refreshes_copy(ext_home: Path) -> None:
    builtin_ext_apps.ensure_builtin_ext_apps_registered(ORIGIN)
    dest = _installed_dir(ext_home)
    manifest_path = dest / "evoflow.extension.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    manifest["version"] = "0.0.1-user"  # 模拟旧版本已安装
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    (dest / "app.js").write_text("// stale", encoding="utf-8")

    actions = builtin_ext_apps.ensure_builtin_ext_apps_registered(ORIGIN)
    by_id = {a["id"]: a["action"] for a in actions}
    assert by_id["demo-workbench"] == "refreshed"
    assert (dest / "app.js").read_text(encoding="utf-8") != "// stale"
    fresh = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    assert fresh["version"] == "1.0.0"


def test_disabled_row_stays_disabled(ext_home: Path) -> None:
    builtin_ext_apps.ensure_builtin_ext_apps_registered(ORIGIN)
    registry.set_enabled("demo-workbench", enabled=False)
    builtin_ext_apps.ensure_builtin_ext_apps_registered(ORIGIN)
    row = next(r for r in _registry_rows(ext_home) if r["id"] == "demo-workbench")
    assert row["enabled"] is False


def test_port_change_updates_registry_entry_only(ext_home: Path) -> None:
    builtin_ext_apps.ensure_builtin_ext_apps_registered(ORIGIN)
    dest = _installed_dir(ext_home)
    (dest / "app.js").write_text("// user edit", encoding="utf-8")

    new_origin = "http://127.0.0.1:8001"
    actions = builtin_ext_apps.ensure_builtin_ext_apps_registered(new_origin)
    by_id = {a["id"]: a["action"] for a in actions}
    assert by_id["demo-workbench"] == "entry-updated"
    # 用户副本不被覆盖
    assert (dest / "app.js").read_text(encoding="utf-8") == "// user edit"
    # 注册行 entry 指向新端口（面板消费注册行的 manifest）
    row = next(r for r in _registry_rows(ext_home) if r["id"] == "demo-workbench")
    assert row["manifest"]["ui"]["entry"] == new_origin + "/api/ui-ext-apps/demo-workbench/"


@pytest.fixture()
def serve_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    from app.gateway.routers import ui_ext_apps

    home = tmp_path / "evoflow-home"
    monkeypatch.setenv("EVOFLOW_UI_EXTENSIONS_DIR", str(home))
    app = FastAPI()
    app.include_router(ui_ext_apps.router)
    return TestClient(app)


def _register_row(home: Path, ext_id: str, *, serve: bool) -> Path:
    dest = home / "ui-extensions" / ext_id
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "index.html").write_text("<html>demo</html>", encoding="utf-8")
    (dest / "app.js").write_text("console.log(1)", encoding="utf-8")
    (dest / "secret.bin").write_text("nope", encoding="utf-8")
    manifest = {
        "schema": 1,
        "id": ext_id,
        "name": ext_id,
        "version": "1.0.0",
        "ui": {
            "kind": "webview",
            "entry": "http://127.0.0.1:1/api/ui-ext-apps/" + ext_id + "/",
        },
    }
    if serve:
        manifest["ui"]["serve"] = "gateway"
    registry.upsert_row(manifest, str(dest), "builtin" if serve else "folder")
    return dest


def test_serve_index_and_files(serve_client: TestClient, tmp_path: Path) -> None:
    home = tmp_path / "evoflow-home"
    _register_row(home, "demo-workbench", serve=True)
    resp = serve_client.get("/api/ui-ext-apps/demo-workbench/")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/html")
    assert "demo" in resp.text

    js = serve_client.get("/api/ui-ext-apps/demo-workbench/app.js")
    assert js.status_code == 200
    assert "text/javascript" in js.headers["content-type"]


def test_serve_rejects_non_gateway_manifest(serve_client: TestClient, tmp_path: Path) -> None:
    home = tmp_path / "evoflow-home"
    _register_row(home, "external-app", serve=False)
    assert serve_client.get("/api/ui-ext-apps/external-app/").status_code == 404


def test_serve_blocks_traversal_and_unknown_suffix(serve_client: TestClient, tmp_path: Path) -> None:
    home = tmp_path / "evoflow-home"
    dest = _register_row(home, "demo-workbench", serve=True)
    # 放一个敏感文件到 ui-extensions 根（不在应用目录内）
    (home / "ui-extensions" / "secret.txt").write_text("root-secret", encoding="utf-8")

    assert serve_client.get("/api/ui-ext-apps/demo-workbench/../secret.txt").status_code in (404, 400)
    assert serve_client.get("/api/ui-ext-apps/demo-workbench/%2e%2e/secret.txt").status_code in (404, 400)
    assert "root-secret" not in (serve_client.get("/api/ui-ext-apps/demo-workbench/index.html").text or "")
    assert dest.is_dir()
    # 不在白名单的后缀拒绝
    assert serve_client.get("/api/ui-ext-apps/demo-workbench/secret.bin").status_code == 404


def test_serve_unknown_ext_404(serve_client: TestClient) -> None:
    assert serve_client.get("/api/ui-ext-apps/nope/").status_code == 404


# ─────────────────────── dev 环境解析（2026-11-10 回归） ───────────────────────


def test_config_dir_accepts_direct_evoflow_dev_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """set-evoflow-dev-env.ps1 约定：EVOFLOW_HOME=~/.evoflow-dev（根直给，非 profiles 形态）。

    曾经的 bug：config_dir 只认 profiles/<id> 上溯，匹配失败回落 ~/.evoflow，
    dev 网关把内置应用注册进了正式目录，dev 面板（读 ~/.evoflow-dev）看不到。
    """
    fake_home = tmp_path / "home"
    dev_root = fake_home / ".evoflow-dev"
    dev_root.mkdir(parents=True)
    monkeypatch.delenv("EVOFLOW_UI_EXTENSIONS_DIR", raising=False)
    monkeypatch.delenv("EVOFLOW_CONFIG_DIR", raising=False)
    monkeypatch.setenv("EVOFLOW_HOME", str(dev_root))
    monkeypatch.setattr(registry, "_home", lambda: fake_home)
    assert registry.config_dir() == dev_root
    assert registry.ui_extensions_root() == dev_root / "ui-extensions"


def test_config_dir_profiles_form_still_works(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake_home = tmp_path / "home"
    profile = fake_home / ".evoflow-dev" / "profiles" / "main"
    profile.mkdir(parents=True)
    monkeypatch.delenv("EVOFLOW_UI_EXTENSIONS_DIR", raising=False)
    monkeypatch.delenv("EVOFLOW_CONFIG_DIR", raising=False)
    monkeypatch.setenv("EVOFLOW_HOME", str(profile))
    monkeypatch.setattr(registry, "_home", lambda: fake_home)
    assert registry.config_dir() == fake_home / ".evoflow-dev"


def test_resolve_gateway_port(monkeypatch: pytest.MonkeyPatch) -> None:
    # 1) gateway_entry 自设的 EVOFLOW_GATEWAY_PORT 优先
    monkeypatch.setenv("EVOFLOW_GATEWAY_PORT", "8382")
    monkeypatch.setenv("GATEWAY_PORT", "9999")
    monkeypatch.setattr(sys, "argv", ["x", "--port", "8070"])
    assert builtin_ext_apps.resolve_gateway_port() == 8382
    # 2) 其次 GATEWAY_PORT
    monkeypatch.delenv("EVOFLOW_GATEWAY_PORT")
    assert builtin_ext_apps.resolve_gateway_port() == 9999
    # 3) 再退 uvicorn CLI 的 --port（dev 启动形态）
    monkeypatch.delenv("GATEWAY_PORT")
    monkeypatch.setattr(sys, "argv", ["python", "-m", "uvicorn", "app.gateway.app:app", "--port", "8070"])
    assert builtin_ext_apps.resolve_gateway_port() == 8070
    monkeypatch.setattr(sys, "argv", ["uvicorn", "--port=8071"])
    assert builtin_ext_apps.resolve_gateway_port() == 8071
    # 4) 兜底 8001
    monkeypatch.setattr(sys, "argv", ["uvicorn"])
    assert builtin_ext_apps.resolve_gateway_port() == 8001


def test_install_uses_resolved_port_not_default(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """dev 用 uvicorn --port 8070 启动（无 GATEWAY_PORT env）时，entry 不得烤成 8001。"""
    home = tmp_path / "evoflow-home"
    monkeypatch.setenv("EVOFLOW_UI_EXTENSIONS_DIR", str(home))
    monkeypatch.delenv("EVOFLOW_GATEWAY_PORT", raising=False)
    monkeypatch.delenv("GATEWAY_PORT", raising=False)
    monkeypatch.setattr(sys, "argv", ["python", "-m", "uvicorn", "app.gateway.app:app", "--port", "8070"])
    builtin_ext_apps.ensure_builtin_ext_apps_registered("http://127.0.0.1:8070")
    row = next(r for r in registry.read_registry() if r["id"] == "demo-workbench")
    assert row["manifest"]["ui"]["entry"] == "http://127.0.0.1:8070/api/ui-ext-apps/demo-workbench/"
