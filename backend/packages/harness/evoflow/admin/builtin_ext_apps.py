"""系统内置 UI 扩展应用（builtin ext apps）安装与刷新。

仓库在 ``evoflow/assets/builtin_ext_apps/<app-id>/`` 随包携带演示应用的完整源码
（单页 HTML 工作台，无需构建）。网关启动时把它们安装进用户数据目录
``<evoflow_dir>/ui-extensions/<app-id>/`` 并注册进共享注册表 registry.json，
使面板「Agent 应用」页像普通扩展一样列出/打开它们。

策略（对用户数据目录友好）：

- 首次安装：整目录复制（源码进用户数据目录，用户可直接打开/修改）。
- 版本升级（manifest.version 变化）：重新复制覆盖（用户改动以同版本内编辑为准，
  升级时被覆盖——演示应用可接受，避免陈旧入口）。
- 版本未变：**不覆盖**用户副本；仅当网关端口变化时同步修正注册行里的
  ``ui.entry``（用户副本里的 manifest 文件不动，注册行才是面板消费源）。
- 用户手动禁用过的行保留 ``enabled=False``，不被启动重装翻转。
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import sys
from pathlib import Path
from typing import Any

from evoflow.admin.ui_extensions_registry import (
    config_dir,
    read_registry,
    validate_extension_id,
    write_registry,
    _registry_lock,
)

logger = logging.getLogger(__name__)

# 源码目录：evoflow/assets/builtin_ext_apps/（PyInstaller 经 gateway.spec datas
# 落到 _internal/evoflow/assets/builtin_ext_apps/，__file__ 相对解析同构）。
_BUILTIN_ASSETS_DIR = Path(__file__).resolve().parent.parent / "assets" / "builtin_ext_apps"

# manifest 模板里的占位符 → 渲染为本网关实际可达的 entry origin。
GATEWAY_ORIGIN_PLACEHOLDER = "__EVOFLOW_GATEWAY_ORIGIN__"

# 标记「由本模块安装」，serve 路由据此放行静态文件。
BUILTIN_SOURCE_TAG = "builtin"


def resolve_gateway_port() -> int:
    """推断本网关进程实际监听的端口。

    不同启动形态端口来源不同，按优先级探测：

    1. ``EVOFLOW_GATEWAY_PORT`` —— gateway_entry（打包 sidecar）自设
    2. ``GATEWAY_PORT`` —— GatewayConfig 的环境约定（桌面启动器/部分脚本）
    3. ``sys.argv`` 里的 ``--port`` —— 开发态 uvicorn CLI（python -m uvicorn
       app.gateway.app:app --port 8070）与 gateway_entry argparse 共用此形态
    4. 8001 —— GatewayConfig 默认值兜底
    """
    for env_name in ("EVOFLOW_GATEWAY_PORT", "GATEWAY_PORT"):
        raw = (os.getenv(env_name) or "").strip()
        if raw.isdigit() and int(raw) > 0:
            return int(raw)
    argv = sys.argv or []
    for i, arg in enumerate(argv):
        if arg == "--port" and i + 1 < len(argv) and argv[i + 1].isdigit():
            return int(argv[i + 1])
        if arg.startswith("--port=") and arg[7:].isdigit():
            return int(arg[7:])
    return 8001


def iter_builtin_ext_app_dirs() -> list[tuple[str, Path]]:
    """列出随包内置应用：[(app_id, source_dir), ...]。"""
    if not _BUILTIN_ASSETS_DIR.is_dir():
        return []
    out: list[tuple[str, Path]] = []
    for child in sorted(_BUILTIN_ASSETS_DIR.iterdir()):
        if child.is_dir() and (child / "evoflow.extension.json").is_file():
            out.append((child.name, child))
    return out


def _render_manifest(manifest: dict[str, Any], gateway_origin: str) -> dict[str, Any]:
    text = json.dumps(manifest, ensure_ascii=False, indent=2)
    text = text.replace(GATEWAY_ORIGIN_PLACEHOLDER, gateway_origin.rstrip("/"))
    rendered = json.loads(text)
    rendered.setdefault("ui", {})["serve"] = "gateway"
    return rendered


def _copy_app_source(src: Path, dest: Path, rendered_manifest: dict[str, Any]) -> None:
    if dest.exists():
        shutil.rmtree(dest, ignore_errors=True)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(src, dest)
    (dest / "evoflow.extension.json").write_text(
        json.dumps(rendered_manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _upsert_builtin_row(ext_id: str, rendered_manifest: dict[str, Any], install_path: Path) -> None:
    """注册/刷新内置应用行；保留用户已设置的 enabled 状态。"""
    row: dict[str, Any] = {
        "id": ext_id,
        "enabled": True,
        "source": BUILTIN_SOURCE_TAG,
        "install_path": str(install_path),
        "installed_at": "",
        "manifest": rendered_manifest,
    }
    with _registry_lock:
        rows = read_registry()
        existing = next((r for r in rows if r.get("id") == ext_id), None)
        if existing is not None:
            row["enabled"] = existing.get("enabled") is not False
            row["installed_at"] = str(existing.get("installed_at") or "")
            rows = [r for r in rows if r.get("id") != ext_id]
        rows.append(row)
        write_registry(rows)


def ensure_builtin_ext_apps_registered(gateway_origin: str) -> list[dict[str, Any]]:
    """启动时安装/刷新全部内置应用。返回 [{id, action}, ...]，action ∈
    installed|refreshed|entry-updated|kept|failed。"""
    actions: list[dict[str, Any]] = []
    origin = (gateway_origin or "").rstrip("/")
    if not origin:
        return actions
    for app_id, src in iter_builtin_ext_app_dirs():
        try:
            template = json.loads((src / "evoflow.extension.json").read_text(encoding="utf-8-sig"))
            validate_extension_id(template)
            rendered = _render_manifest(template, origin)
            entry = str((rendered.get("ui") or {}).get("entry") or "")
            version = str(rendered.get("version") or "")
            dest = config_dir() / "ui-extensions" / app_id
            installed_manifest: dict[str, Any] | None = None
            manifest_file = dest / "evoflow.extension.json"
            if manifest_file.is_file():
                try:
                    installed_manifest = json.loads(manifest_file.read_text(encoding="utf-8-sig"))
                except (OSError, json.JSONDecodeError):
                    installed_manifest = None

            existing = next((r for r in read_registry() if r.get("id") == app_id), None)
            old_entry = str(((existing or {}).get("manifest") or {}).get("ui", {}).get("entry", ""))
            old_path = str((existing or {}).get("install_path") or "")

            if installed_manifest is None or str(installed_manifest.get("version") or "") != version:
                # 首装或版本升级：复制源码进用户数据目录（升级覆盖用户副本）。
                _copy_app_source(src, dest, rendered)
                action = "installed" if installed_manifest is None else "refreshed"
                _upsert_builtin_row(app_id, rendered, dest)
            elif (
                existing is not None
                and old_entry == entry
                and old_path == str(dest)
            ):
                # 版本未变且注册行已一致 → 不动注册表，尊重用户对副本的编辑。
                action = "kept"
            else:
                # 版本未变：不覆盖用户副本；只把注册行 entry/install_path 修到当前
                # 网关 origin（dev↔正式端口切换场景）。
                action = "entry-updated"
                _upsert_builtin_row(app_id, rendered, dest)
            actions.append({"id": app_id, "action": action})
        except Exception:
            logger.exception("builtin ext app %s install failed (non-fatal)", app_id)
            actions.append({"id": app_id, "action": "failed"})
    if any(a["action"] != "kept" for a in actions):
        logger.info("builtin ext apps ensured: %s", actions)
    return actions
