"""Workspace（项目）级 MCP 配置与信任门（对齐 Zcode 项目 scope）.

对齐 Zcode-vs-EvoFlow MCP 分析 #3：

- **项目级配置**：项目根（默认进程 cwd，``EVOFLOW_MCP_PROJECT_DIR`` 可覆盖）下的
  ``.evoflow/mcp.json`` 或 ``.mcp.json``（Cursor 风格，IDE 兼容格式）作为
  workspace scope 的 MCP 来源，团队可随仓库共享；
- **信任门**：项目级 server 一律 **untrusted**，不显式信任就绝不连接——恶意仓库
  自带的 MCP 配置不会在打开项目时被自动拉起；
- **信任绑定内容而非名字**：信任记录保存 server 配置的内容指纹（sha256），
  配置一变（哪怕名字没变）信任即失效，需重新确认——"server/tool 名可被第三方
  仿冒，绝不能用名称 wildcard 表达这一权限"；
- **用户级优先**：项目 server 与用户级（SQLite/mcp.json）同名时用户级胜出，
  项目配置不能仿冒/劫持用户已信任的 server。

信任状态语义（供 UI 展示）：
- ``trusted``   — 已信任且配置指纹未变，会参与连接；
- ``changed``   — 曾信任但配置已被修改，视为未信任，需重新确认；
- ``untrusted`` — 从未信任过。
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

TRUST_STATUS_TRUSTED = "trusted"
TRUST_STATUS_CHANGED = "changed"
TRUST_STATUS_UNTRUSTED = "untrusted"


def resolve_project_root() -> Path:
    """项目根目录：``EVOFLOW_MCP_PROJECT_DIR`` 优先，否则进程 cwd。"""
    env_dir = (os.environ.get("EVOFLOW_MCP_PROJECT_DIR") or "").strip()
    if env_dir:
        root = Path(env_dir).expanduser()
    else:
        root = Path.cwd()
    if not root.is_absolute():
        root = Path.cwd() / root
    return root


def project_mcp_paths(root: Path | None = None) -> list[Path]:
    """候选项目级 mcp.json（顺序即优先级，先命中先用）。"""
    base = root if root is not None else resolve_project_root()
    return [base / ".evoflow" / "mcp.json", base / ".mcp.json"]


def load_project_mcp_servers() -> tuple[dict[str, dict[str, Any]], Path | None]:
    """解析项目级 mcp.json，返回 ``(servers, source_path)``；无文件返回空。"""
    from evoflow.mcp.config_io import unwrap_mcp_servers_dict

    for path in project_mcp_paths():
        if not path.is_file():
            continue
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except json.JSONDecodeError as exc:
            logger.error("Invalid JSON in project MCP config %s: %s", path, exc)
            continue
        except Exception as exc:
            logger.error("Failed to read project MCP config %s: %s", path, exc)
            continue
        servers = unwrap_mcp_servers_dict(data)
        if servers:
            logger.info("Loaded %d workspace MCP server(s) from %s", len(servers), path)
            return servers, path
    return {}, None


def server_config_fingerprint(config: dict[str, Any]) -> str:
    """server 配置内容指纹（信任绑定内容而非名字）。"""
    payload = json.dumps(config, sort_keys=True, default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def project_key(root: Path | None = None) -> str:
    """项目根的规范化存储键（Windows 大小写/分隔符不敏感）。"""
    base = root if root is not None else resolve_project_root()
    return os.path.normcase(os.path.abspath(str(base)))


def trust_store_path() -> Path:
    try:
        from evoflow.config.data_paths import resolve_data_base_dir

        return resolve_data_base_dir() / "mcp_project_trust.json"
    except Exception:
        return Path.home() / ".evoflow" / "mcp_project_trust.json"


def _load_trust_store() -> dict[str, dict[str, dict[str, Any]]]:
    path = trust_store_path()
    if not path.is_file():
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception as exc:
        logger.warning("Failed to read MCP project trust store %s: %s", path, exc)
        return {}


def _save_trust_store(store: dict[str, dict[str, dict[str, Any]]]) -> None:
    path = trust_store_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(store, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


# ── 查询 ────────────────────────────────────────────────────────────────


def project_servers_with_status() -> dict[str, dict[str, Any]]:
    """项目级 server 全量清单（含信任状态），供 UI / 管理接口使用。

    返回 ``{name: {"config": ..., "status": trusted|changed|untrusted,
    "source": str, "enabled": bool}}``。
    """
    servers, source = load_project_mcp_servers()
    store = _load_trust_store().get(project_key(), {})
    out: dict[str, dict[str, Any]] = {}
    for name, cfg in servers.items():
        record = store.get(name) if isinstance(store, dict) else None
        if not isinstance(record, dict):
            status = TRUST_STATUS_UNTRUSTED
        elif record.get("fingerprint") == server_config_fingerprint(cfg):
            status = TRUST_STATUS_TRUSTED
        else:
            status = TRUST_STATUS_CHANGED
        out[str(name)] = {
            "config": cfg,
            "status": status,
            "source": str(source) if source else "",
            "enabled": cfg.get("enabled") is not False,
        }
    return out


def trusted_project_servers() -> dict[str, dict[str, Any]]:
    """通过信任门的项目级 server（指纹匹配 + 未停用），参与连接池加载。"""
    trusted: dict[str, dict[str, Any]] = {}
    for name, info in project_servers_with_status().items():
        if info["status"] == TRUST_STATUS_TRUSTED and info["enabled"]:
            trusted[name] = info["config"]
    return trusted


# ── 变更 ────────────────────────────────────────────────────────────────


def set_project_server_trust(name: str, trusted: bool) -> dict[str, Any]:
    """信任 / 撤回信任一个项目级 server。

    信任时绑定当前配置指纹；配置后续被修改会自动降级为 ``changed``。
    返回操作后的项目清单状态（同 ``project_servers_with_status``）。
    """
    servers, _source = load_project_mcp_servers()
    if name not in servers:
        raise KeyError(f"Workspace MCP server {name!r} not found in project config")

    store = _load_trust_store()
    key = project_key()
    entries = store.setdefault(key, {})
    if trusted:
        entries[name] = {
            "fingerprint": server_config_fingerprint(servers[name]),
        }
        logger.info("Workspace MCP server %r trusted (fingerprint-bound)", name)
    else:
        entries.pop(name, None)
        logger.info("Workspace MCP server %r trust revoked", name)
    if not entries:
        store.pop(key, None)
    _save_trust_store(store)
    return project_servers_with_status()
