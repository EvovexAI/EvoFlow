"""Resolve Node + private MCP package roots for Knowledge Vault.

Modes
-----
- ``dev`` / ``npx``: may use system Node + npx (development only).
- ``private`` / ``production``: launch ``node <absolute>/dist/...js`` from a
  package root; never ``npx -y`` on each start.

Package roots (first ready wins)
--------------------------------
1. ``EVOFLOW_KB_RUNTIME_ROOT`` (explicit override)
2. **In-repo / bundled** ``backend/packaging/kb-mcp`` (or frozen ``tools/kb-mcp``)
3. User data ``{EVOFLOW_HOME}/runtime/kb-mcp`` (legacy install-via-panel)

Install with ``make setup-kb-mcp`` (writes into the in-repo packaging tree).
Panel「安装并初始化」also installs into the preferred install root (packaged when
running from a source checkout).

Production installs may lack system Node. First-time「安装检索组件」calls
``ensure_private_node`` to download a portable Node into
``{EVOFLOW_HOME}/runtime/node`` (mirrors: npmmirror + nodejs.org). Operators can
still set ``EVOFLOW_KB_NODE`` or pre-place a Node tree under ``runtime/node``.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from evoflow.knowledge.vault.constants import OHS_BIN, OHS_PACKAGE, WRITE_MCP_PACKAGE

logger = logging.getLogger(__name__)

LaunchKind = Literal["private", "npx", "unavailable"]


def _is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False)) or bool(os.getenv("EVOFLOW_PACKAGED") == "1")


def resolve_kb_runtime_root() -> Path:
    """Mutable runtime prefix (pidfile, caches). Not necessarily where npm packages live."""
    override = os.getenv("EVOFLOW_KB_RUNTIME_ROOT", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    from evoflow.config.data_paths import resolve_data_base_dir

    return (resolve_data_base_dir() / "runtime" / "kb-mcp").resolve()


def _backend_dir_from_this_file() -> Path | None:
    here = Path(__file__).resolve()
    # .../backend/packages/harness/evoflow/knowledge/vault/runtime_resolve.py
    try:
        backend_dir = here.parents[5]
    except IndexError:
        return None
    if (backend_dir / "packages" / "harness").is_dir():
        return backend_dir
    return None


def resolve_packaged_kb_mcp_root() -> Path | None:
    """In-repo or frozen-bundled kb-mcp tree (``package.json`` + ``node_modules``)."""
    env = os.getenv("EVOFLOW_KB_PACKAGED_ROOT", "").strip()
    if env:
        return Path(env).expanduser().resolve()

    if _is_frozen():
        exe_dir = Path(sys.executable).resolve().parent
        candidate = exe_dir / "tools" / "kb-mcp"
        if candidate.is_dir():
            return candidate.resolve()

    backend = _backend_dir_from_this_file()
    if backend is not None:
        candidate = backend / "packaging" / "kb-mcp"
        if candidate.is_dir() and (candidate / "package.json").is_file():
            return candidate.resolve()
    return None


def resolve_kb_package_candidates() -> list[Path]:
    """Ordered roots that may contain installed OHS / write MCP packages."""
    out: list[Path] = []
    seen: set[str] = set()

    def _add(path: Path | None) -> None:
        if path is None:
            return
        key = str(path)
        if key in seen:
            return
        seen.add(key)
        out.append(path)

    override = os.getenv("EVOFLOW_KB_RUNTIME_ROOT", "").strip()
    if override:
        _add(Path(override).expanduser().resolve())
    _add(resolve_packaged_kb_mcp_root())
    _add(resolve_kb_runtime_root())
    return out


def find_ready_kb_package_root() -> tuple[Path | None, str]:
    """Return the first candidate with OHS + write entrypoints present."""
    last_msg = "no kb-mcp package root"
    for root in resolve_kb_package_candidates():
        ok, msg = private_packages_ready(root)
        if ok:
            return root, msg
        last_msg = f"{root}: {msg}"
    return None, last_msg


def preferred_install_root() -> Path:
    """Where ``npm install`` should write packages.

    Prefer the in-repo packaging tree so the project actually owns the dependency.
    Fall back to the user-data runtime root when packaged root is unavailable.
    """
    packaged = resolve_packaged_kb_mcp_root()
    if packaged is not None:
        return packaged
    return resolve_kb_runtime_root()


def resolve_node_binary() -> str:
    """Prefer private/bundled Node, then explicit env, then system Node (not editor helpers)."""
    candidates: list[Path] = []
    env_node = os.getenv("EVOFLOW_KB_NODE", "").strip()
    if env_node:
        candidates.append(Path(env_node))
    root = resolve_kb_runtime_root()
    packaged = resolve_packaged_kb_mcp_root()
    if sys.platform == "win32":
        candidates.extend(
            [
                root / "node" / "node.exe",
                root.parent / "node" / "node.exe",
            ]
        )
        if packaged is not None:
            candidates.append(packaged / "node" / "node.exe")
        # Prefer real system Node over IDE-bundled helper binaries on PATH.
        for base in (
            os.environ.get("ProgramFiles"),
            os.environ.get("ProgramW6432"),
            r"C:\Program Files",
        ):
            if not base:
                continue
            candidates.append(Path(base) / "nodejs" / "node.exe")
    else:
        candidates.extend(
            [
                root / "node" / "bin" / "node",
                root.parent / "node" / "bin" / "node",
            ]
        )
        if packaged is not None:
            candidates.append(packaged / "node" / "bin" / "node")
    # Gateway tools layout (future sidecar)
    try:
        from evoflow.config.data_paths import resolve_data_base_dir

        base = resolve_data_base_dir()
        if sys.platform == "win32":
            candidates.append(base / "tools" / "node" / "node.exe")
        else:
            candidates.append(base / "tools" / "node" / "bin" / "node")
    except Exception:
        pass

    for c in candidates:
        try:
            if c.is_file():
                return str(c.resolve())
        except OSError:
            continue

    which = shutil.which("node") or ""
    if which and _is_editor_helper_node(which):
        # Keep looking for a non-helper node later on PATH.
        for part in (os.environ.get("Path") or os.environ.get("PATH") or "").split(os.pathsep):
            if not part:
                continue
            name = "node.exe" if sys.platform == "win32" else "node"
            cand = Path(part) / name
            try:
                if cand.is_file() and not _is_editor_helper_node(str(cand)):
                    return str(cand.resolve())
            except OSError:
                continue
    return which


def _is_editor_helper_node(path: str) -> bool:
    """True for IDE-bundled helper node (often wrong ABI for native modules)."""
    normalized = path.replace("\\", "/").lower()
    return (
        "/resources/app/resources/helpers/node" in normalized
        or "/cursor/resources/" in normalized
        or "/visual studio code/resources/" in normalized
    )


def resolve_npx_binary() -> str:
    if sys.platform == "win32":
        return shutil.which("npx.cmd") or shutil.which("npx") or ""
    return shutil.which("npx") or ""


def package_dir(runtime_root: Path, package_name_at_version: str) -> Path:
    # obsidian-hybrid-search@0.13.22 → node_modules/obsidian-hybrid-search
    name = package_name_at_version.split("@")[0]
    return runtime_root / "node_modules" / name


def ohs_server_js(runtime_root: Path) -> Path:
    return package_dir(runtime_root, OHS_PACKAGE) / "dist" / "src" / "server.js"


def ohs_cli_js(runtime_root: Path) -> Path:
    return package_dir(runtime_root, OHS_PACKAGE) / "dist" / "src" / "cli.js"


def ohs_hf_preload_js(package_root: Path | None = None) -> Path | None:
    """Preload that maps HF_ENDPOINT → transformers ``env.remoteHost`` (CN mirrors)."""
    candidates: list[Path] = []
    if package_root is not None:
        candidates.append(Path(package_root))
    packaged = resolve_packaged_kb_mcp_root()
    if packaged is not None:
        candidates.append(packaged)
    candidates.extend(resolve_kb_package_candidates())
    seen: set[str] = set()
    for root in candidates:
        key = str(root)
        if key in seen:
            continue
        seen.add(key)
        path = root / "ohs-hf-preload.mjs"
        if path.is_file():
            return path.resolve()
    return None


def ohs_node_import_args(package_root: Path | None = None) -> list[str]:
    """Args to inject before OHS entry so local Xenova can use HF mirrors."""
    preload = ohs_hf_preload_js(package_root)
    if preload is None:
        return []
    # file:// URI avoids Windows path quirks with ``node --import``.
    return ["--import", preload.as_uri()]


def write_server_js(runtime_root: Path) -> Path:
    return package_dir(runtime_root, WRITE_MCP_PACKAGE) / "dist" / "index.js"


def manifest_path(runtime_root: Path) -> Path:
    return runtime_root / "manifest.json"


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def read_manifest(runtime_root: Path) -> dict[str, Any]:
    path = manifest_path(runtime_root)
    if not path.is_file():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return raw if isinstance(raw, dict) else {}


def write_manifest(runtime_root: Path, payload: dict[str, Any]) -> None:
    runtime_root.mkdir(parents=True, exist_ok=True)
    manifest_path(runtime_root).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def private_packages_ready(runtime_root: Path | None = None) -> tuple[bool, str]:
    root = runtime_root
    if root is None:
        found, msg = find_ready_kb_package_root()
        if found is not None:
            return True, msg
        return False, msg
    ohs = ohs_server_js(root)
    write = write_server_js(root)
    if not ohs.is_file():
        return False, f"missing OHS server entry: {ohs}"
    if not write.is_file():
        return False, f"missing write MCP entry: {write}"
    man = read_manifest(root)
    expected_ohs = man.get("ohs_sha256")
    expected_write = man.get("write_sha256")
    if expected_ohs and sha256_file(ohs) != expected_ohs:
        return False, "OHS package integrity check failed — reinstall required"
    if expected_write and sha256_file(write) != expected_write:
        return False, "Write MCP package integrity check failed — reinstall required"
    if man.get("ohs_package") and man["ohs_package"] != OHS_PACKAGE:
        return False, f"OHS version mismatch: installed {man.get('ohs_package')} expected {OHS_PACKAGE}"
    if man.get("write_package") and man["write_package"] != WRITE_MCP_PACKAGE:
        return False, f"Write MCP version mismatch: installed {man.get('write_package')} expected {WRITE_MCP_PACKAGE}"
    return True, "ok"


@dataclass
class McpLaunchPlan:
    kind: LaunchKind
    command: str
    args: list[str]
    cwd: str | None = None
    message: str = ""
    production: bool = False
    online_install_required: bool = False


def desired_mode() -> str:
    """Return explicit mode: private | npx | auto."""
    raw = (os.getenv("EVOFLOW_KB_MCP_LAUNCH") or "").strip().lower()
    if raw in ("private", "bundled", "production"):
        return "private"
    if raw in ("npx", "dev"):
        return "npx"
    if _is_frozen() or os.getenv("EVOFLOW_PACKAGED") == "1":
        return "private"
    return "auto"


def build_search_launch_plan() -> McpLaunchPlan:
    mode = desired_mode()
    node = resolve_node_binary()
    ready_root, ready_msg = find_ready_kb_package_root()

    if mode == "private" or (mode == "auto" and ready_root is not None):
        if not node:
            return McpLaunchPlan(
                kind="unavailable",
                command="",
                args=[],
                message=(
                    "生产模式需要 Node 运行时，但未找到。"
                    "请在知识库页点击「安装检索组件」或「重建索引」以自动下载私有 Node，"
                    "或将 Node 放到 {EVOFLOW_HOME}/runtime/node，或设置 EVOFLOW_KB_NODE。"
                ),
                production=True,
                online_install_required=ready_root is None,
            )
        if ready_root is None:
            packaged = resolve_packaged_kb_mcp_root()
            hint = (
                f"请运行 `make setup-kb-mcp` 安装到 {packaged}。"
                if packaged is not None
                else (
                    f"请在知识库页点击「重建索引」（缺组件时会自动联网安装 {OHS_PACKAGE} "
                    f"到 {{EVOFLOW_HOME}}/runtime/kb-mcp）。"
                    "正式安装包不含检索组件（约 700MB），需本机有 Node 且能联网。"
                )
            )
            return McpLaunchPlan(
                kind="unavailable",
                command="",
                args=[],
                message=f"Knowledge Vault MCP 包未就绪。{hint} 详情: {ready_msg}",
                production=True,
                online_install_required=True,
            )
        return McpLaunchPlan(
            kind="private",
            command=node,
            args=[*ohs_node_import_args(ready_root), str(ohs_server_js(ready_root))],
            cwd=str(ready_root),
            message=f"private node + local package ({ready_root})",
            production=mode == "private" or _is_frozen(),
        )

    # npx / auto fallback (development)
    npx = resolve_npx_binary()
    if not npx or not node:
        return McpLaunchPlan(
            kind="unavailable",
            command="",
            args=[],
            message="开发模式需要系统 Node.js / npx。生产环境请使用私有 runtime（make setup-kb-mcp）。",
            production=False,
            online_install_required=True,
        )
    return McpLaunchPlan(
        kind="npx",
        command=npx,
        args=["-y", "-p", OHS_PACKAGE, OHS_BIN],
        message="dev npx (may download on first use)",
        production=False,
        online_install_required=True,
    )


def build_write_launch_plan() -> McpLaunchPlan:
    mode = desired_mode()
    node = resolve_node_binary()
    ready_root, ready_msg = find_ready_kb_package_root()

    if mode == "private" or (mode == "auto" and ready_root is not None):
        if not node:
            return McpLaunchPlan(
                kind="unavailable",
                command="",
                args=[],
                message="生产模式缺少 Node 运行时（EVOFLOW_KB_NODE / runtime/node）。",
                production=True,
                online_install_required=ready_root is None,
            )
        if ready_root is None:
            return McpLaunchPlan(
                kind="unavailable",
                command="",
                args=[],
                message=f"写 MCP 私有包未安装: {ready_msg}。请运行 make setup-kb-mcp。",
                production=True,
                online_install_required=True,
            )
        return McpLaunchPlan(
            kind="private",
            command=node,
            args=[str(write_server_js(ready_root))],
            cwd=str(ready_root),
            message=f"private node + local write package ({ready_root})",
            production=True,
        )

    npx = resolve_npx_binary()
    if not npx:
        return McpLaunchPlan(
            kind="unavailable",
            command="",
            args=[],
            message="开发模式需要 npx",
            production=False,
            online_install_required=True,
        )
    return McpLaunchPlan(
        kind="npx",
        command=npx,
        args=["-y", WRITE_MCP_PACKAGE],
        message="dev npx write package",
        production=False,
        online_install_required=True,
    )


def runtime_status_dict() -> dict[str, Any]:
    user_root = resolve_kb_runtime_root()
    packaged = resolve_packaged_kb_mcp_root()
    ready_root, ready_msg = find_ready_kb_package_root()
    ready = ready_root is not None
    node = resolve_node_binary()
    return {
        "mode": desired_mode(),
        "frozen": _is_frozen(),
        "runtimeRoot": str(user_root),
        "packagedRoot": str(packaged) if packaged else None,
        "activePackageRoot": str(ready_root) if ready_root else None,
        "preferredInstallRoot": str(preferred_install_root()),
        "node": node,
        "npx": resolve_npx_binary(),
        "privatePackagesReady": ready,
        "privatePackagesMessage": ready_msg if not ready else "ok",
        "ohsPackage": OHS_PACKAGE,
        "writePackage": WRITE_MCP_PACKAGE,
        "searchPlan": build_search_launch_plan().__dict__,
        "writePlan": build_write_launch_plan().__dict__,
        "sidecarNodeBundled": bool(node and "runtime" in node.replace("\\", "/").lower()),
        "productionReady": ready and bool(node) and desired_mode() != "npx",
    }
