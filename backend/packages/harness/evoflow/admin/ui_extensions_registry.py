"""UI 扩展注册表（registry.json）共享读写逻辑。

面板(Tauri)与 gateway 共享同一份 ``<evoflow_dir>/ui-extensions/registry.json``，
行格式（UI Extension Standard v1）：``{id, enabled, source, install_path, installed_at, manifest}``。
gateway 的 REST 路由与资源包(organization pack)安装器/导出器都走本模块，保证单一实现。

读取兼容两种历史脏形态：UTF-8 BOM（PowerShell 5.1 ``Set-Content -Encoding UTF8`` 产物）
与「单对象当注册表」（PS 管道把单元素数组拆成裸对象）；写入始终为无 BOM 数组。
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_registry_lock = threading.Lock()


class ExtensionValidationError(ValueError):
    """manifest/id/目录非法（对外映射 400）。"""


class ExtensionNotFoundError(LookupError):
    """注册表中无此扩展（对外映射 404）。"""


class ExtensionIOError(RuntimeError):
    """注册表/目录读写失败（对外映射 500）。"""


def _home() -> Path:
    return Path.home()


def config_dir() -> Path:
    """与面板 ``evoflow_dir()`` 相同的解析顺序。"""
    explicit = (os.getenv("EVOFLOW_UI_EXTENSIONS_DIR") or os.getenv("EVOFLOW_CONFIG_DIR") or "").strip()
    if explicit:
        return Path(explicit).expanduser()
    home_env = os.getenv("EVOFLOW_HOME", "").strip()
    if home_env:
        profile = Path(home_env).expanduser().resolve()
        # 形态一：EVOFLOW_HOME = <evoflow_dir>/profiles/<id> 时上溯两级即共享根。
        if profile.parent.name == "profiles":
            root = profile.parent.parent
            if root.name in (".evoflow", ".evoflow-dev") and root.parent == _home():
                return root
        # 形态二：EVOFLOW_HOME 直接指向 .evoflow / .evoflow-dev 根
        # （scripts/set-evoflow-dev-env.ps1 的开发约定：EVOFLOW_HOME=~/.evoflow-dev）。
        if profile.name in (".evoflow", ".evoflow-dev") and profile.parent == _home():
            return profile
    return _home() / ".evoflow"


def ui_extensions_root() -> Path:
    return config_dir() / "ui-extensions"


def registry_path() -> Path:
    return ui_extensions_root() / "registry.json"


def _strip_utf8_bom(text: str) -> str:
    return text.lstrip("\ufeff") if text.startswith("\ufeff") else text


def read_registry() -> list[dict[str, Any]]:
    path = registry_path()
    if not path.is_file():
        return []
    try:
        # utf-8-sig：兼容 PowerShell 写出的 BOM。
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ExtensionIOError(f"读取扩展注册表失败: {exc}") from exc
    if isinstance(value, dict):
        return [value]  # 历史写法：单对象当注册表（PS 管道拆包单元素数组）
    if not isinstance(value, list):
        return []
    return [row for row in value if isinstance(row, dict)]


def write_registry(rows: list[dict[str, Any]]) -> None:
    root = ui_extensions_root()
    try:
        root.mkdir(parents=True, exist_ok=True)
        path = registry_path()
        text = json.dumps(rows, ensure_ascii=False, indent=2)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, path)
    except OSError as exc:
        raise ExtensionIOError(f"写入扩展注册表失败: {exc}") from exc


def validate_extension_id(manifest: dict[str, Any]) -> str:
    raw = str(manifest.get("id") or "").strip()
    if not raw:
        raise ExtensionValidationError("manifest.id 缺失")
    if len(raw) > 64 or raw[0] not in "abcdefghijklmnopqrstuvwxyz" or not all(
        c.isascii() and (c.islower() or c.isdigit() or c == "-") for c in raw[1:]
    ):
        raise ExtensionValidationError(f"manifest.id 非法: {raw!r}（须为小写 kebab-case）")
    return raw


def _utc_now_rfc3339() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def get_row(ext_id: str) -> dict[str, Any] | None:
    return next((r for r in read_registry() if r.get("id") == ext_id), None)


def upsert_row(manifest: dict[str, Any], install_path: str, source: str) -> dict[str, Any]:
    ext_id = validate_extension_id(manifest)
    row: dict[str, Any] = {
        "id": ext_id,
        "enabled": True,
        "source": source,
        "install_path": install_path,
        "installed_at": _utc_now_rfc3339(),
        "manifest": manifest,
    }
    with _registry_lock:
        rows = read_registry()
        rows = [r for r in rows if r.get("id") != ext_id]
        rows.append(row)
        write_registry(rows)
    return row


def read_manifest_from_dir(src: Path) -> dict[str, Any]:
    manifest_file = src / "evoflow.extension.json"
    if not manifest_file.is_file():
        raise ExtensionValidationError(f"目录内未找到 evoflow.extension.json: {src}")
    try:
        # utf-8-sig：manifest 也可能由 PowerShell 工具链写出（带 BOM）。
        manifest = json.loads(manifest_file.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ExtensionValidationError(f"Manifest JSON 无效: {exc}") from exc
    if not isinstance(manifest, dict):
        raise ExtensionValidationError("Manifest JSON 须为对象")
    return manifest


def register_directory(src: Path, *, link: bool | None = None, source: str | None = None) -> dict[str, Any]:
    """把一个含 ``evoflow.extension.json`` 的目录注册进注册表。

    ``link=True``（或 manifest ``service.link=true``）只登记路径不复制（monorepo /
    folder-link）；否则复制目录到 ``<ui-extensions>/<id>/`` 后登记。
    """
    src = Path(src).expanduser()
    if not src.is_dir():
        raise ExtensionValidationError(f"扩展目录不存在: {src}")
    manifest = read_manifest_from_dir(src)
    effective_link = link if link is not None else bool((manifest.get("service") or {}).get("link", False))
    if effective_link:
        return upsert_row(manifest, str(src), source or "folder-link")
    dest = ui_extensions_root() / validate_extension_id(manifest)
    try:
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(src, dest)
    except OSError as exc:
        raise ExtensionIOError(f"复制扩展目录失败: {exc}") from exc
    return upsert_row(manifest, str(dest), source or "folder")


def set_enabled(ext_id: str, *, enabled: bool) -> dict[str, Any]:
    with _registry_lock:
        rows = read_registry()
        row = next((r for r in rows if r.get("id") == ext_id), None)
        if row is None:
            raise ExtensionNotFoundError(f"扩展不存在: {ext_id}")
        row["enabled"] = enabled
        write_registry(rows)
    return {"id": ext_id, "enabled": enabled}


def remove_row(ext_id: str) -> dict[str, Any]:
    """摘除注册行；安装目录在 ui-extensions 根下时一并删除（folder-link 只摘登记）。"""
    root = ui_extensions_root().resolve()
    with _registry_lock:
        rows = read_registry()
        row = next((r for r in rows if r.get("id") == ext_id), None)
        if row is None:
            raise ExtensionNotFoundError(f"扩展不存在: {ext_id}")
        rows = [r for r in rows if r.get("id") != ext_id]
        write_registry(rows)
    install_path = str(row.get("install_path") or "")
    if install_path:
        try:
            dest = Path(install_path).resolve()
            if dest.is_dir() and dest.parent == root:
                shutil.rmtree(dest, ignore_errors=True)
        except OSError:
            logger.debug("ui-extensions: cleanup install_path failed", exc_info=True)
    return row
