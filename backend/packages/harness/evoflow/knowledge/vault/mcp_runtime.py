"""Managed MCP subprocess lifecycle for Knowledge Vault providers.

Uses langchain-mcp-adapters with a persistent stdio session so tools share one
process. Launch plans come from ``runtime_resolve`` (private vs npx). Managed
PIDs are tracked in a pidfile for orphan cleanup and never exposed to agents.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import sys
import time
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from evoflow.knowledge.vault import secrets as vault_secrets
from evoflow.knowledge.vault.capability import DiscoveredCapabilities, discover_from_tool_objects
from evoflow.knowledge.vault.constants import (
    BLOCKED_WRITE_TOOLS,
    MCP_RESTART_MAX,
    OHS_PACKAGE,
    OHS_TOOL_PREFIX,
    SESSION_BOOT_TIMEOUT_SEC,
    WRITE_MCP_PACKAGE,
)
from evoflow.knowledge.vault.errors import (
    KnowledgeError,
    NodeRuntimeMissingError,
    PackageInstallFailedError,
    RequiredToolMissingError,
    SearchProviderUnavailableError,
    ToolTimeoutError,
    WriteProviderUnavailableError,
    map_exception,
)
from evoflow.knowledge.vault.models import AccessMode, EmbeddingMode, KnowledgeVaultConfig, LaunchMode
from evoflow.knowledge.vault.paths import is_localhost_url
from evoflow.knowledge.vault.runtime_resolve import (
    build_search_launch_plan,
    build_write_launch_plan,
    ohs_server_js,
    preferred_install_root,
    resolve_kb_runtime_root,
    resolve_node_binary,
    resolve_npx_binary,
    resolve_packaged_kb_mcp_root,
    sha256_file,
    write_manifest,
    write_server_js,
)
from evoflow.knowledge.vault.sanitize import sanitize_text

logger = logging.getLogger(__name__)

_PIDFILE_NAME = "managed.pids"
_CLEANUP_DONE = False


@dataclass
class RuntimeProbe:
    node_ok: bool = False
    npm_ok: bool = False
    npx_ok: bool = False
    node_path: str = ""
    npm_path: str = ""
    npx_path: str = ""
    message: str = ""


def probe_node_runtime() -> RuntimeProbe:
    import shutil

    from evoflow.utils.subprocess_platform import resolve_npm_argv

    node = resolve_node_binary()
    npm_argv = resolve_npm_argv(node)
    # Display path: last token that looks like npm (cli.js / npm.exe / npm.cmd)
    npm_display = ""
    if npm_argv:
        npm_display = npm_argv[-1] if len(npm_argv) >= 1 else ""
        if sys.platform == "win32" and not npm_display.lower().endswith(("npm", "npm.exe", "npm.cmd", "npm-cli.js")):
            npm_display = " ".join(npm_argv)
    if not npm_display:
        if sys.platform == "win32":
            npm_display = shutil.which("npm.exe") or shutil.which("npm.cmd") or shutil.which("npm") or ""
        else:
            npm_display = shutil.which("npm") or ""
    npx = resolve_npx_binary()
    probe = RuntimeProbe(
        node_ok=bool(node),
        npm_ok=bool(npm_argv) or bool(npm_display),
        npx_ok=bool(npx),
        node_path=node,
        npm_path=npm_display,
        npx_path=npx,
    )
    plan = build_search_launch_plan()
    if plan.kind == "unavailable":
        probe.message = plan.message or "Knowledge MCP runtime unavailable"
    elif plan.kind == "private":
        probe.message = "private Node runtime OK"
    else:
        if not (probe.node_ok and probe.npx_ok):
            probe.message = "Node.js / npx 未找到。请安装 Node.js 18+ 或使用私有 runtime。"
        else:
            probe.message = "Node.js runtime OK (npx dev mode)"
    return probe


def _pidfile_path() -> Path:
    return resolve_kb_runtime_root() / _PIDFILE_NAME


def _read_pidfile() -> dict[str, list[int]]:
    path = _pidfile_path()
    if not path.is_file():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(raw, dict):
        return {}
    out: dict[str, list[int]] = {}
    for k, v in raw.items():
        if isinstance(v, list):
            out[str(k)] = [int(x) for x in v if str(x).isdigit() or isinstance(x, int)]
    return out


def _write_pidfile(data: dict[str, list[int]]) -> None:
    root = resolve_kb_runtime_root()
    root.mkdir(parents=True, exist_ok=True)
    path = _pidfile_path()
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def _register_pids(vault_id: str, pids: list[int]) -> None:
    if not pids:
        return
    data = _read_pidfile()
    key = str(vault_id)
    existing = set(data.get(key) or [])
    existing.update(int(p) for p in pids if p and p > 0)
    data[key] = sorted(existing)
    _write_pidfile(data)


def _unregister_pids(vault_id: str, pids: list[int] | None = None) -> None:
    data = _read_pidfile()
    key = str(vault_id)
    if key not in data:
        return
    if pids is None:
        data.pop(key, None)
    else:
        drop = {int(p) for p in pids}
        remaining = [p for p in data[key] if p not in drop]
        if remaining:
            data[key] = remaining
        else:
            data.pop(key, None)
    _write_pidfile(data)


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        if sys.platform == "win32":
            import ctypes

            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            handle = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
            if not handle:
                return False
            ctypes.windll.kernel32.CloseHandle(handle)
            return True
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _kill_pid(pid: int) -> None:
    if pid <= 0:
        return
    try:
        if sys.platform == "win32":
            import ctypes

            PROCESS_TERMINATE = 0x0001
            handle = ctypes.windll.kernel32.OpenProcess(PROCESS_TERMINATE, False, pid)
            if handle:
                ctypes.windll.kernel32.TerminateProcess(handle, 1)
                ctypes.windll.kernel32.CloseHandle(handle)
        else:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                return
            deadline = time.monotonic() + 2.0
            while time.monotonic() < deadline and _pid_alive(pid):
                time.sleep(0.05)
            if _pid_alive(pid):
                os.kill(pid, signal.SIGKILL)
    except OSError:
        logger.debug("failed to kill managed pid (suppressed details)", exc_info=True)


def _descendant_pids(root_pid: int) -> set[int]:
    """Best-effort children of ``root_pid`` (for PID differencing after spawn)."""
    found: set[int] = set()
    if sys.platform == "win32":
        try:
            import ctypes
            from ctypes import wintypes

            TH32CS_SNAPPROCESS = 0x00000002

            class PROCESSENTRY32(ctypes.Structure):
                _fields_ = [
                    ("dwSize", wintypes.DWORD),
                    ("cntUsage", wintypes.DWORD),
                    ("th32ProcessID", wintypes.DWORD),
                    ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
                    ("th32ModuleID", wintypes.DWORD),
                    ("cntThreads", wintypes.DWORD),
                    ("th32ParentProcessID", wintypes.DWORD),
                    ("pcPriClassBase", ctypes.c_long),
                    ("dwFlags", wintypes.DWORD),
                    ("szExeFile", ctypes.c_char * 260),
                ]

            kernel32 = ctypes.windll.kernel32
            snap = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
            if snap == -1:
                return found
            try:
                entry = PROCESSENTRY32()
                entry.dwSize = ctypes.sizeof(PROCESSENTRY32)
                children: dict[int, list[int]] = {}
                if kernel32.Process32First(snap, ctypes.byref(entry)):
                    while True:
                        children.setdefault(int(entry.th32ParentProcessID), []).append(int(entry.th32ProcessID))
                        if not kernel32.Process32Next(snap, ctypes.byref(entry)):
                            break
                stack = [root_pid]
                while stack:
                    parent = stack.pop()
                    for child in children.get(parent, []):
                        if child not in found:
                            found.add(child)
                            stack.append(child)
            finally:
                kernel32.CloseHandle(snap)
        except Exception:
            logger.debug("win32 descendant pid scan failed", exc_info=True)
        return found

    # POSIX: walk /proc
    try:
        proc = Path("/proc")
        if not proc.is_dir():
            return found
        children: dict[int, list[int]] = {}
        for entry in proc.iterdir():
            if not entry.name.isdigit():
                continue
            try:
                stat = (entry / "stat").read_text(encoding="utf-8", errors="replace")
                # pid (comm) state ppid ...
                ppid = int(stat.split(")")[-1].split()[1])
                children.setdefault(ppid, []).append(int(entry.name))
            except (OSError, IndexError, ValueError):
                continue
        stack = [root_pid]
        while stack:
            parent = stack.pop()
            for child in children.get(parent, []):
                if child not in found:
                    found.add(child)
                    stack.append(child)
    except Exception:
        logger.debug("posix descendant pid scan failed", exc_info=True)
    return found


def cleanup_orphaned_managed_processes() -> dict[str, Any]:
    """Kill PIDs listed in the managed pidfile that are still alive (startup hygiene)."""
    data = _read_pidfile()
    killed: list[int] = []
    kept: dict[str, list[int]] = {}
    for vault_id, pids in data.items():
        alive: list[int] = []
        for pid in pids:
            if _pid_alive(pid):
                _kill_pid(pid)
                if _pid_alive(pid):
                    alive.append(pid)
                else:
                    killed.append(pid)
        if alive:
            kept[vault_id] = alive
    _write_pidfile(kept)
    return {"killed": killed, "remaining": kept}


def _mcp_child_env(overrides: dict[str, str]) -> dict[str, str]:
    """Merge overrides onto a string-only copy of ``os.environ``.

    MCP ``StdioServerParameters.env`` replaces the process environment when set;
    without PATH/SystemRoot the child Node process can misbehave on Windows.
    """
    env = {str(k): str(v) for k, v in os.environ.items() if v is not None}
    for key, value in overrides.items():
        env[str(key)] = str(value if value is not None else "")
    return env


def _ohs_startup_error_log() -> Path:
    return Path.home() / ".cache" / "obsidian-hybrid-search" / "last-startup-error.log"


def _read_ohs_startup_error(max_chars: int = 1200) -> str:
    path = _ohs_startup_error_log()
    try:
        if not path.is_file():
            return ""
        text = path.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return ""
    if not text:
        return ""
    return sanitize_text(text[-max_chars:])


def _looks_like_native_abi_mismatch(text: str) -> bool:
    lowered = (text or "").lower()
    return (
        "node_module_version" in lowered
        or "compiled against a different node" in lowered
        or "err_dlopen_failed" in lowered
        or ("better-sqlite3" in lowered and "abi" in lowered)
    )


def _looks_like_permanent_native_failure(text: str) -> bool:
    """True when retrying spawn cannot help (missing/broken native modules)."""
    lowered = (text or "").lower()
    if _looks_like_native_abi_mismatch(text):
        return False  # ABI can be healed via rebuild
    needles = (
        "getloadablepath",
        "sqlite-vec",
        "cannot find module",
        "找不到指定的模块",
        "the specified module could not be found",
        "better-sqlite3",
        "err_dlopen_failed",
        "native module",
    )
    return any(n in lowered for n in needles)


async def _preflight_native_search_modules(node: str, package_root: Path) -> str | None:
    """Return error if better-sqlite3 or sqlite-vec cannot load under ``node``."""
    from evoflow.utils.subprocess_platform import subprocess_hide_window_kwargs

    script = (
        "try {"
        " require('better-sqlite3');"
        " try {"
        "  const sv = require('sqlite-vec');"
        "  if (typeof sv.getLoadablePath === 'function') { sv.getLoadablePath(); }"
        " } catch (e2) {"
        "  process.stderr.write('sqlite-vec: ' + String(e2 && e2.stack || e2));"
        "  process.exit(2);"
        " }"
        " process.stdout.write('ok');"
        "} catch (e) {"
        " process.stderr.write(String(e && e.stack || e));"
        " process.exit(1);"
        "}"
    )
    try:
        proc = await asyncio.create_subprocess_exec(
            node,
            "-e",
            script,
            cwd=str(package_root),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=_mcp_child_env({}),
            **subprocess_hide_window_kwargs(),
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=20.0)
    except Exception as exc:
        return sanitize_text(str(exc))
    if proc.returncode in (0, None) and (stdout or b"").decode("utf-8", errors="replace").strip() == "ok":
        return None
    err = (stderr or b"").decode("utf-8", errors="replace").strip()
    out = (stdout or b"").decode("utf-8", errors="replace").strip()
    return sanitize_text(err or out or f"native search preflight failed (exit={proc.returncode})")


async def _preflight_better_sqlite3(node: str, package_root: Path) -> str | None:
    """Return an error string if better-sqlite3 cannot load under ``node``, else None."""
    return await _preflight_native_search_modules(node, package_root)


async def _rebuild_better_sqlite3(node: str, package_root: Path) -> str | None:
    """Rebuild better-sqlite3 for the active Node ABI. Returns error text or None on success."""
    from evoflow.utils.subprocess_platform import resolve_npm_argv, subprocess_hide_window_kwargs

    npm_argv = resolve_npm_argv(node)
    if not npm_argv:
        return "npm not found — cannot rebuild better-sqlite3"
    bs_root = package_root / "node_modules" / "better-sqlite3"
    if not bs_root.is_dir():
        return f"better-sqlite3 package missing under {package_root}"
    env = _mcp_child_env({})
    # Ensure npm scripts use the same Node we launch MCP with.
    node_dir = str(Path(node).resolve().parent)
    env["PATH"] = node_dir + os.pathsep + env.get("PATH", "")
    env["npm_config_scripts_prepend_node_path"] = "true"
    try:
        proc = await asyncio.create_subprocess_exec(
            *npm_argv,
            "run",
            "install",
            cwd=str(bs_root),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            **subprocess_hide_window_kwargs(),
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=300.0)
    except Exception as exc:
        return sanitize_text(str(exc))
    if proc.returncode not in (0, None):
        combined = ((stdout or b"") + b"\n" + (stderr or b"")).decode("utf-8", errors="replace")
        return sanitize_text(combined[-1500:] or f"rebuild failed exit={proc.returncode}")
    return await _preflight_better_sqlite3(node, package_root)


async def _ensure_native_modules_for_search(params: dict[str, Any]) -> None:
    """Heal better-sqlite3 ABI mismatches before opening the OHS MCP stdio session."""
    node = str(params.get("command") or "").strip()
    cwd = params.get("cwd")
    package_root = Path(str(cwd)) if cwd else None
    if not node or package_root is None or not package_root.is_dir():
        return
    if not (package_root / "node_modules" / "better-sqlite3").is_dir():
        return
    preflight_err = await _preflight_better_sqlite3(node, package_root)
    if not preflight_err:
        return
    if not _looks_like_native_abi_mismatch(preflight_err):
        raise SearchProviderUnavailableError(
            f"Knowledge search native module preflight failed: {preflight_err}",
            details={"node": node, "cwd": str(package_root)},
        )
    logger.warning(
        "better-sqlite3 ABI mismatch for node=%s; rebuilding native module",
        node,
    )
    rebuild_err = await _rebuild_better_sqlite3(node, package_root)
    if rebuild_err:
        raise SearchProviderUnavailableError(
            "better-sqlite3 与当前 Node 版本不匹配，自动重建失败。"
            f" 请在 {package_root} 下用同一 Node 执行"
            " `npm --prefix node_modules/better-sqlite3 run install`。"
            f" 详情: {rebuild_err}",
            details={"node": node, "cwd": str(package_root)},
        )


def _enrich_mcp_boot_error(exc: BaseException) -> BaseException:
    """Attach OHS last-startup-error.log details to opaque Connection closed failures."""
    msg = sanitize_text(str(exc))
    if "connection closed" not in msg.lower() and "closed" not in msg.lower():
        return exc
    detail = _read_ohs_startup_error()
    if not detail:
        return exc
    enriched = f"{msg}; OHS startup log: {detail}"
    if isinstance(exc, KnowledgeError):
        try:
            return type(exc)(enriched, cause=getattr(exc, "cause", None), details=getattr(exc, "details", None))
        except TypeError:
            return SearchProviderUnavailableError(enriched, cause=exc)
    return SearchProviderUnavailableError(enriched, cause=exc)


def build_search_stdio_config(cfg: KnowledgeVaultConfig) -> dict[str, Any]:
    plan = build_search_launch_plan()
    if plan.kind == "unavailable":
        raise NodeRuntimeMissingError(plan.message or "search MCP launch plan unavailable")
    overrides: dict[str, str] = {
        "OBSIDIAN_VAULT_PATH": cfg.vault_path,
        "OBSIDIAN_PREFIX": OHS_TOOL_PREFIX,
        "OBSIDIAN_RESPECT_GITIGNORE": "true" if cfg.respect_gitignore else "false",
        "OBSIDIAN_IGNORE_PATTERNS": cfg.ignore_patterns or "",
    }
    # OHS reads OPENAI_* (see obsidian-hybrid-search config.js) — not OBSIDIAN_EMBEDDING_*.
    if cfg.embedding_mode == EmbeddingMode.openai_compatible:
        if cfg.embedding_base_url:
            overrides["OPENAI_BASE_URL"] = cfg.embedding_base_url
        if cfg.embedding_model:
            overrides["OPENAI_EMBEDDING_MODEL"] = cfg.embedding_model
        key = vault_secrets.get_secret(cfg.embedding_api_key_secret_ref) or ""
        if key:
            overrides["OPENAI_API_KEY"] = key
        elif cfg.embedding_base_url:
            # Keyless local/OpenAI-compatible servers still need a non-empty key for some clients.
            overrides["OPENAI_API_KEY"] = "local-no-key"
    else:
        # Local Xenova — clear inherited chat OpenAI vars so OHS does not hit a remote API.
        overrides["OPENAI_BASE_URL"] = ""
        overrides["OPENAI_API_KEY"] = ""
        overrides["OPENAI_EMBEDDING_MODEL"] = ""
    # Local Xenova models: cache under EvoFlow runtime; mirror helps first-time download in CN.
    hf_cache = str(resolve_kb_runtime_root() / "hf-cache")
    overrides.setdefault("TRANSFORMERS_CACHE", hf_cache)
    overrides.setdefault("HF_HOME", hf_cache)
    if not os.getenv("HF_ENDPOINT"):
        overrides.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    params: dict[str, Any] = {
        "transport": "stdio",
        "command": plan.command,
        "args": list(plan.args),
        "env": _mcp_child_env(overrides),
    }
    if plan.cwd:
        params["cwd"] = plan.cwd
    return params


def build_write_stdio_config(cfg: KnowledgeVaultConfig) -> dict[str, Any]:
    plan = build_write_launch_plan()
    if plan.kind == "unavailable":
        raise WriteProviderUnavailableError(plan.message or "write MCP launch plan unavailable")
    api_key = vault_secrets.get_secret(cfg.obsidian_api_key_secret_ref) or ""
    read_paths = ",".join(cfg.allowed_read_paths) if cfg.allowed_read_paths else "*"
    write_paths = ",".join(cfg.allowed_write_paths) if cfg.allowed_write_paths else ""
    overrides: dict[str, str] = {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "OBSIDIAN_API_KEY": api_key,
        "OBSIDIAN_BASE_URL": cfg.obsidian_base_url or "http://127.0.0.1:27123",
        "OBSIDIAN_ENABLE_COMMANDS": "false",
        "OBSIDIAN_READ_ONLY": "false" if cfg.access_mode == AccessMode.read_write else "true",
        "OBSIDIAN_READ_PATHS": read_paths,
        "OBSIDIAN_WRITE_PATHS": write_paths,
    }
    env = _mcp_child_env(overrides)
    params: dict[str, Any] = {
        "transport": "stdio",
        "command": plan.command,
        "args": list(plan.args),
        "env": env,
    }
    if plan.cwd:
        params["cwd"] = plan.cwd
    return params


def build_http_config(url: str, headers: dict[str, str] | None = None) -> dict[str, Any]:
    return {
        "transport": "http",
        "url": url,
        "headers": dict(headers or {}),
    }


@dataclass
class VaultMcpSession:
    vault_id: str
    search_tools: dict[str, Any] = field(default_factory=dict)
    write_tools: dict[str, Any] = field(default_factory=dict)
    search_capabilities: DiscoveredCapabilities | None = None
    write_capabilities: DiscoveredCapabilities | None = None
    search_error: str | None = None
    write_error: str | None = None
    search_stack: AsyncExitStack | None = None
    write_stack: AsyncExitStack | None = None
    managed_pids: list[int] = field(default_factory=list)
    search_restarts: int = 0
    write_restarts: int = 0
    search_unavailable: bool = False
    write_unavailable: bool = False
    installed: bool = False
    semantic_ready: bool | None = None
    embedding_dim: int | None = None
    embedding_model: str | None = None


_SESSIONS: dict[str, VaultMcpSession] = {}
_LOCK = asyncio.Lock()
_VAULT_LOCKS: dict[str, asyncio.Lock] = {}
_BOOT_TASKS: dict[str, asyncio.Task[Any]] = {}


def get_session(vault_id: str) -> VaultMcpSession | None:
    return _SESSIONS.get(vault_id)


def get_ready_session(vault_id: str) -> VaultMcpSession | None:
    """Return a session that already has search tools loaded (no boot)."""
    sess = _SESSIONS.get(vault_id)
    if sess and sess.search_tools and not sess.search_unavailable:
        return sess
    return None


def is_session_warming(vault_id: str) -> bool:
    task = _BOOT_TASKS.get(vault_id)
    return bool(task is not None and not task.done())


def _vault_lock(vault_id: str) -> asyncio.Lock:
    lock = _VAULT_LOCKS.get(vault_id)
    if lock is None:
        lock = asyncio.Lock()
        _VAULT_LOCKS[vault_id] = lock
    return lock


def schedule_session_warmup(cfg: KnowledgeVaultConfig) -> None:
    """Fire-and-forget MCP boot so the next search/status is warm."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    vid = str(cfg.id or "").strip()
    if not vid:
        return
    if get_ready_session(vid) or is_session_warming(vid):
        return
    task = loop.create_task(ensure_session(cfg), name=f"kb-mcp-warmup-{vid}")

    def _log_warmup_failure(done: asyncio.Task[Any]) -> None:
        if done.cancelled():
            return
        exc = done.exception()
        if exc is None:
            return
        logger.warning(
            "Knowledge MCP warmup failed for vault %s: %s",
            vid,
            sanitize_text(str(exc)),
        )

    task.add_done_callback(_log_warmup_failure)


async def warmup_enabled_vaults() -> dict[str, Any]:
    """Background: boot search MCP for every enabled vault (non-fatal)."""
    from evoflow.knowledge.vault import store as vault_store

    ok: list[str] = []
    failed: list[str] = []
    for cfg in vault_store.list_vault_configs():
        if not getattr(cfg, "enabled", False):
            continue
        vid = str(cfg.id or "").strip()
        if not vid:
            continue
        try:
            await ensure_session(cfg)
            ok.append(vid)
            logger.info("Knowledge MCP warmed for vault %s", vid)
        except Exception as exc:
            failed.append(vid)
            logger.warning(
                "Knowledge MCP warmup failed for vault %s: %s",
                vid,
                sanitize_text(str(exc)),
            )
    return {"ok": ok, "failed": failed}


def _tool_basename(name: str) -> str:
    n = str(name or "")
    for sep in ("__", "_"):
        if sep in n:
            parts = n.split(sep)
            for i in range(len(parts)):
                candidate = sep.join(parts[i:])
                if candidate.startswith(OHS_TOOL_PREFIX):
                    return candidate[len(OHS_TOOL_PREFIX) :]
                if candidate.startswith("obsidian_"):
                    return candidate
    if n.startswith(OHS_TOOL_PREFIX):
        return n[len(OHS_TOOL_PREFIX) :]
    return n


def _index_tools(tools: list[Any]) -> dict[str, Any]:
    by_base: dict[str, Any] = {}
    for tool in tools:
        full = str(getattr(tool, "name", "") or "")
        base = _tool_basename(full)
        if base:
            by_base[base] = tool
        if full:
            by_base[full] = tool
        # Also index suffix after last __
        if "__" in full:
            by_base[full.split("__")[-1]] = tool
    return by_base


async def _close_stack(stack: AsyncExitStack | None) -> None:
    """Close an MCP ``AsyncExitStack``.

    OHS stdio sessions are often opened in a boot task and closed later from
    reindex/warmup tasks. anyio then raises ``BaseExceptionGroup`` / cancel-scope
    errors (not subclasses of ``Exception``), which previously escaped and aborted
    CLI reindex before managed PIDs were killed.
    """
    if stack is None:
        return
    try:
        await stack.aclose()
    except asyncio.CancelledError:
        raise
    except BaseException as exc:
        # KeyboardInterrupt / SystemExit should still propagate.
        if isinstance(exc, (KeyboardInterrupt, SystemExit)):
            raise
        logger.debug(
            "MCP exit stack close failed (often cross-task stdio cancel scope): %s",
            exc,
            exc_info=True,
        )


async def _close_session_resources(sess: VaultMcpSession) -> None:
    """Release vault DB locks by killing children first, then best-effort stack close."""
    # Windows: vault ``.obsidian-hybrid-search.db`` stays locked until the MCP
    # child exits. Kill PIDs before aclose so CLI ``reindex --force`` can unlink
    # even when stack teardown raises cross-task cancel-scope errors.
    pids = list(sess.managed_pids)
    for pid in pids:
        _kill_pid(pid)
    _unregister_pids(sess.vault_id)
    sess.managed_pids.clear()

    for stack_or_client in (sess.search_stack, sess.write_stack):
        if stack_or_client is None:
            continue
        if isinstance(stack_or_client, AsyncExitStack):
            await _close_stack(stack_or_client)
            continue
        close = getattr(stack_or_client, "aclose", None) or getattr(stack_or_client, "close", None)
        if close is None:
            continue
        try:
            result = close()
            if asyncio.iscoroutine(result):
                await result
        except asyncio.CancelledError:
            raise
        except BaseException:
            logger.debug("MCP resource close failed", exc_info=True)
    sess.search_stack = None
    sess.write_stack = None


async def drop_session(vault_id: str) -> None:
    async with _LOCK:
        sess = _SESSIONS.pop(vault_id, None)
        task = _BOOT_TASKS.pop(vault_id, None)
    if task is not None and not task.done():
        task.cancel()
    if sess is None:
        return
    try:
        await _close_session_resources(sess)
    except asyncio.CancelledError:
        raise
    except BaseException:
        # Never block vault reindex / restart on teardown noise.
        logger.debug("drop_session cleanup failed vault=%s", vault_id, exc_info=True)


async def _start_stdio_session(
    server_name: str,
    params: dict[str, Any],
    *,
    timeout_sec: float = SESSION_BOOT_TIMEOUT_SEC,
) -> tuple[dict[str, Any], list[Any], AsyncExitStack, list[int]]:
    """Open a persistent stdio MCP session and load LangChain tools bound to it."""
    from langchain_mcp_adapters.tools import load_mcp_tools
    from mcp import ClientSession
    from mcp.client.stdio import StdioServerParameters, stdio_client

    safe_params = {k: v for k, v in params.items() if k != "env"}
    logger.info("Starting Knowledge MCP %s params=%s", server_name, safe_params)

    stack = AsyncExitStack()
    await stack.__aenter__()
    before = _descendant_pids(os.getpid())
    try:
        stdio_params = StdioServerParameters(
            command=str(params["command"]),
            args=list(params.get("args") or []),
            env=params.get("env"),
            cwd=params.get("cwd"),
        )

        async def _boot():
            read, write = await stack.enter_async_context(stdio_client(stdio_params))
            session = await stack.enter_async_context(ClientSession(read, write))
            await session.initialize()
            after = _descendant_pids(os.getpid())
            new_pids = sorted(after - before)
            listed = await session.list_tools()
            tools = await load_mcp_tools(
                session,
                server_name=server_name,
                tool_name_prefix=True,
            )
            return tools, new_pids, listed

        tools, new_pids, listed = await asyncio.wait_for(_boot(), timeout=timeout_sec)
    except Exception as exc:
        await _close_stack(stack)
        raise _enrich_mcp_boot_error(exc) from exc

    indexed = _index_tools(tools)
    # Attach MCP inputSchema onto tool objects for capability discovery
    try:
        mcp_schemas = {
            str(t.name): (t.inputSchema if isinstance(t.inputSchema, dict) else {})
            for t in (getattr(listed, "tools", None) or [])
        }
        for tool in tools:
            name = str(getattr(tool, "name", "") or "")
            base = name.split("_")[-1] if "_" in name else name
            # Prefer exact MCP name match by suffix
            schema = None
            for mcp_name, sch in mcp_schemas.items():
                if name.endswith(mcp_name) or name == mcp_name or base == mcp_name:
                    schema = sch
                    break
            if schema is not None:
                try:
                    setattr(tool, "_mcp_input_schema", schema)
                except Exception:
                    pass
    except Exception:
        logger.debug("attach MCP schemas failed", exc_info=True)

    return indexed, tools, stack, new_pids


async def _start_http_session(
    server_name: str,
    params: dict[str, Any],
    *,
    timeout_sec: float = SESSION_BOOT_TIMEOUT_SEC,
) -> tuple[dict[str, Any], list[Any], Any]:
    from langchain_mcp_adapters.client import MultiServerMCPClient

    client = MultiServerMCPClient({server_name: params}, tool_name_prefix=True)
    try:
        tools = await asyncio.wait_for(client.get_tools(), timeout=timeout_sec)
    except TimeoutError as exc:
        raise ToolTimeoutError(f"MCP server {server_name} timed out", cause=exc) from exc
    except Exception as exc:
        raise map_exception(exc) from exc
    return _index_tools(tools), tools, client


async def _start_with_backoff(
    *,
    label: str,
    starter: Any,
    restarts_so_far: int,
) -> Any:
    delays = (0.4, 1.0, 2.0)
    last_exc: BaseException | None = None
    remaining = max(0, MCP_RESTART_MAX - restarts_so_far)
    if remaining <= 0:
        raise SearchProviderUnavailableError(f"{label} unavailable after {MCP_RESTART_MAX} restarts")
    for attempt in range(remaining):
        try:
            return await starter()
        except Exception as exc:
            last_exc = exc
            msg = sanitize_text(str(exc))
            logger.warning("%s start attempt %s failed: %s", label, attempt + 1, msg)
            # Permanent native failures cannot be healed by sleep+respawn.
            if isinstance(exc, SearchProviderUnavailableError) or _looks_like_permanent_native_failure(msg):
                raise map_exception(exc) from exc
            if attempt + 1 < remaining:
                await asyncio.sleep(delays[min(attempt, len(delays) - 1)])
    assert last_exc is not None
    raise map_exception(last_exc) from last_exc


async def drop_all_sessions() -> None:
    ids = list(_SESSIONS.keys())
    for vid in ids:
        await drop_session(vid)


async def _ensure_session_body(
    cfg: KnowledgeVaultConfig,
    *,
    need_write: bool = False,
    force_reload: bool = False,
) -> VaultMcpSession:
    """Boot/reuse MCP session for one vault. Caller must hold ``_vault_lock``."""
    existing = _SESSIONS.get(cfg.id)
    if existing and not force_reload:
        need_search = not existing.search_tools and not existing.search_unavailable
        need_w = (
            need_write
            and cfg.access_mode == AccessMode.read_write
            and not existing.write_tools
            and not existing.write_unavailable
        )
        if not need_search and not need_w:
            return existing
        sess = existing
    else:
        if force_reload and existing:
            await _close_session_resources(existing)
            _SESSIONS.pop(cfg.id, None)
        sess = VaultMcpSession(vault_id=cfg.id)

    if cfg.launch_mode == LaunchMode.managed_stdio:
        if not sess.search_tools and not sess.search_unavailable:
            try:

                async def _boot_search():
                    params = build_search_stdio_config(cfg)
                    await _ensure_native_modules_for_search(params)
                    return await _start_stdio_session(
                        cfg.search_server_name or f"kb-search-{cfg.id}",
                        params,
                        timeout_sec=SESSION_BOOT_TIMEOUT_SEC,
                    )

                indexed, tool_objs, stack, pids = await _start_with_backoff(
                    label="search MCP",
                    starter=_boot_search,
                    restarts_so_far=sess.search_restarts,
                )
                sess.search_tools = indexed
                sess.search_stack = stack
                sess.search_capabilities = discover_from_tool_objects(tool_objs)
                if sess.search_capabilities.missing_required:
                    raise RequiredToolMissingError(
                        "required search tools missing",
                        details={
                            "missing": list(sess.search_capabilities.missing_required),
                            "found": sess.search_capabilities.raw_names,
                        },
                    )
                sess.managed_pids.extend(pids)
                _register_pids(cfg.id, pids)
                sess.search_error = None
            except Exception as exc:
                sess.search_restarts += 1
                mapped = map_exception(exc)
                sess.search_error = sanitize_text(getattr(mapped, "message", str(mapped)))
                # Permanent native module failure: stop warmup storm immediately.
                if (
                    isinstance(exc, SearchProviderUnavailableError)
                    or _looks_like_permanent_native_failure(sess.search_error)
                    or sess.search_restarts >= MCP_RESTART_MAX
                ):
                    sess.search_restarts = max(sess.search_restarts, MCP_RESTART_MAX)
                    sess.search_unavailable = True
                # Persist degraded state so restarts accumulate and status stops
                # forever reporting "warming" with a null session.
                _SESSIONS[cfg.id] = sess
                if not isinstance(exc, RequiredToolMissingError):
                    if sess.search_unavailable:
                        raise SearchProviderUnavailableError(
                            sess.search_error or "search MCP unavailable",
                            cause=exc,
                        ) from exc
                    raise mapped from exc

        if (
            need_write
            and cfg.access_mode == AccessMode.read_write
            and not sess.write_tools
            and not sess.write_unavailable
        ):
            try:

                async def _boot_write():
                    params = build_write_stdio_config(cfg)
                    return await _start_stdio_session(
                        cfg.write_server_name or f"kb-write-{cfg.id}",
                        params,
                        timeout_sec=SESSION_BOOT_TIMEOUT_SEC,
                    )

                indexed, tool_objs, stack, pids = await _start_with_backoff(
                    label="write MCP",
                    starter=_boot_write,
                    restarts_so_far=sess.write_restarts,
                )
                filtered = {
                    k: v
                    for k, v in indexed.items()
                    if _tool_basename(k) not in BLOCKED_WRITE_TOOLS and k not in BLOCKED_WRITE_TOOLS
                }
                sess.write_tools = filtered
                sess.write_stack = stack
                sess.write_capabilities = discover_from_tool_objects(tool_objs)
                sess.managed_pids.extend(pids)
                _register_pids(cfg.id, pids)
                sess.write_error = None
            except Exception as exc:
                sess.write_restarts += 1
                mapped = map_exception(exc)
                sess.write_error = sanitize_text(getattr(mapped, "message", str(mapped)))
                if sess.write_restarts >= MCP_RESTART_MAX:
                    sess.write_unavailable = True
                # Degrade — do not fail search session
                logger.warning("Write MCP unavailable for vault %s: %s", cfg.id, sess.write_error)

    else:
        # external_http
        if cfg.search_server_url and not sess.search_tools:
            if not is_localhost_url(cfg.search_server_url) and not cfg.allow_remote_http:
                raise SearchProviderUnavailableError(
                    "external search URL is not localhost; set allowRemoteHttp after explicit confirmation"
                )
            headers = dict(cfg.headers or {})
            auth = vault_secrets.get_secret(cfg.auth_secret_ref) if cfg.auth_secret_ref else None
            if auth and "Authorization" not in headers:
                headers["Authorization"] = f"Bearer {auth}"
            try:
                indexed, tool_objs, client = await _start_http_session(
                    cfg.search_server_name or f"kb-search-{cfg.id}",
                    build_http_config(cfg.search_server_url, headers),
                )
                sess.search_tools = indexed
                sess.search_stack = client  # type: ignore[assignment]
                sess.search_capabilities = discover_from_tool_objects(tool_objs)
            except Exception as exc:
                raise map_exception(exc) from exc

        if (
            need_write
            and cfg.access_mode == AccessMode.read_write
            and cfg.write_server_url
            and not sess.write_tools
        ):
            if not is_localhost_url(cfg.write_server_url) and not cfg.allow_remote_http:
                raise WriteProviderUnavailableError(
                    "external write URL is not localhost; set allowRemoteHttp after explicit confirmation"
                )
            headers = dict(cfg.headers or {})
            try:
                indexed, tool_objs, client = await _start_http_session(
                    cfg.write_server_name or f"kb-write-{cfg.id}",
                    build_http_config(cfg.write_server_url, headers),
                )
                sess.write_tools = {
                    k: v
                    for k, v in indexed.items()
                    if _tool_basename(k) not in BLOCKED_WRITE_TOOLS
                }
                sess.write_stack = client  # type: ignore[assignment]
                sess.write_capabilities = discover_from_tool_objects(tool_objs)
            except Exception as exc:
                mapped = map_exception(exc)
                sess.write_error = sanitize_text(getattr(mapped, "message", str(mapped)))

    sess.installed = True
    _SESSIONS[cfg.id] = sess
    return sess


async def ensure_session(
    cfg: KnowledgeVaultConfig,
    *,
    need_write: bool = False,
    force_reload: bool = False,
    wait_sec: float | None = None,
) -> VaultMcpSession:
    """Ensure a vault MCP session is ready.

    ``wait_sec=None`` waits until boot finishes (reindex / install).
    ``wait_sec=N`` waits at most N seconds for an in-progress boot; if still
    warming, raises ``ToolTimeoutError`` while the background boot continues.
    """
    global _CLEANUP_DONE
    if not _CLEANUP_DONE:
        try:
            cleanup_orphaned_managed_processes()
        except Exception:
            logger.debug("orphan cleanup failed", exc_info=True)
        _CLEANUP_DONE = True

    if not force_reload:
        existing = _SESSIONS.get(cfg.id)
        if existing and existing.search_tools and not existing.search_unavailable:
            need_w = (
                need_write
                and cfg.access_mode == AccessMode.read_write
                and not existing.write_tools
                and not existing.write_unavailable
            )
            if not need_w:
                return existing

    vid = str(cfg.id)

    async def _runner() -> VaultMcpSession:
        async with _vault_lock(vid):
            return await _ensure_session_body(cfg, need_write=need_write, force_reload=force_reload)

    async with _LOCK:
        task = _BOOT_TASKS.get(vid)
        if force_reload and task is not None and not task.done():
            task.cancel()
            task = None
        if task is None or task.done():
            task = asyncio.create_task(_runner(), name=f"kb-mcp-boot-{vid}")
            _BOOT_TASKS[vid] = task

    if wait_sec is None:
        return await task
    try:
        return await asyncio.wait_for(asyncio.shield(task), timeout=float(wait_sec))
    except TimeoutError as exc:
        raise ToolTimeoutError(
            f"Knowledge search runtime is still starting (vault={vid})",
            cause=exc,
            details={"vaultId": vid, "warming": True},
        ) from exc


async def call_tool(
    tools: dict[str, Any],
    name: str,
    arguments: dict[str, Any],
    *,
    timeout_sec: float = 60.0,
) -> Any:
    """Invoke a single discovered tool by exact name (no multi-name guessing)."""
    tool = tools.get(name)
    if tool is None:
        # Allow basename fallback only within the same index
        base = _tool_basename(name)
        tool = tools.get(base)
    if tool is None:
        raise RequiredToolMissingError(
            f"tool not found: {name}",
            details={"requested": name, "available": sorted(set(tools.keys()))[:50]},
        )
    try:
        if hasattr(tool, "ainvoke"):
            return await asyncio.wait_for(tool.ainvoke(arguments), timeout=timeout_sec)
        if hasattr(tool, "invoke"):
            return await asyncio.wait_for(asyncio.to_thread(tool.invoke, arguments), timeout=timeout_sec)
        raise RequiredToolMissingError(f"tool {name} is not invokable")
    except TimeoutError as exc:
        raise ToolTimeoutError(f"tool timed out: {name}", cause=exc) from exc
    except KnowledgeError:
        raise
    except Exception as exc:
        raise map_exception(exc) from exc


async def install_packages(*, progress_cb: Any | None = None) -> dict[str, Any]:
    """Install pinned MCP packages into the project packaging tree (or user runtime).

    Prefer ``backend/packaging/kb-mcp`` so the repo owns the dependency. Falls back
    to ``{EVOFLOW_HOME}/runtime/kb-mcp`` when the packaged root is unavailable.

    When the machine has no Node (typical packaged desktop install), downloads a
    portable Node into ``{EVOFLOW_HOME}/runtime/node`` before ``npm install``.
    """
    from evoflow.knowledge.vault.node_bootstrap import ensure_private_node
    from evoflow.utils.subprocess_platform import resolve_npm_argv, subprocess_hide_window_kwargs

    root = preferred_install_root()
    root.mkdir(parents=True, exist_ok=True)
    # Keep npm cache under user runtime when installing into a source tree, so
    # caches are not committed next to packaging/kb-mcp.
    cache_root = resolve_kb_runtime_root()
    cache_root.mkdir(parents=True, exist_ok=True)
    cache_dir = cache_root / "npm-cache"
    cache_dir.mkdir(parents=True, exist_ok=True)

    # Skip network install when private packages are already present.
    from evoflow.knowledge.vault.runtime_resolve import find_ready_kb_package_root

    ready_root, ready_msg = find_ready_kb_package_root()
    if ready_root is not None and resolve_node_binary():
        if progress_cb:
            progress_cb("packages_already_ready")
        probe = probe_node_runtime()
        return {
            "ok": True,
            "skipped": True,
            "runtimeRoot": str(ready_root),
            "installRoot": str(ready_root),
            "message": ready_msg or "kb-mcp packages already installed",
            "runtime": probe.__dict__,
        }

    # Ordinary installers do not ship Node; bootstrap a private runtime first.
    try:
        node_path = await asyncio.to_thread(ensure_private_node, progress_cb=progress_cb)
    except NodeRuntimeMissingError:
        raise
    except Exception as exc:
        raise NodeRuntimeMissingError(
            "自动准备 Node 运行时失败，请检查网络后重试。",
            cause=exc,
        ) from exc

    probe = probe_node_runtime()
    npm_argv = resolve_npm_argv(node_path or probe.node_path or resolve_node_binary())
    if not npm_argv:
        raise NodeRuntimeMissingError(
            probe.message
            or "npm not found — private Node 已准备但仍缺少 npm，请重试安装或手动安装 Node.js 18+"
        )
    packaged_pkg = None
    packaged = resolve_packaged_kb_mcp_root()
    if packaged is not None and (packaged / "package.json").is_file():
        packaged_pkg = packaged / "package.json"

    if packaged_pkg is not None and root.resolve() == packaged.resolve():
        # Keep the tracked package.json as source of truth; do not overwrite.
        pass
    else:
        # Install into user runtime (or custom root): write pins matching constants.
        if packaged_pkg is not None:
            (root / "package.json").write_text(packaged_pkg.read_text(encoding="utf-8"), encoding="utf-8")
        else:
            package_json = {
                "name": "evoflow-kb-mcp-runtime",
                "private": True,
                "dependencies": {
                    OHS_PACKAGE.split("@")[0]: OHS_PACKAGE.split("@", 1)[1] if "@" in OHS_PACKAGE else "*",
                    WRITE_MCP_PACKAGE.split("@")[0]: WRITE_MCP_PACKAGE.split("@", 1)[1]
                    if "@" in WRITE_MCP_PACKAGE
                    else "*",
                },
            }
            (root / "package.json").write_text(json.dumps(package_json, indent=2), encoding="utf-8")

    env = {
        **os.environ,
        "npm_config_cache": str(cache_dir),
        "NPM_CONFIG_CACHE": str(cache_dir),
        "npm_config_ignore_scripts": "false",
        "NPM_CONFIG_IGNORE_SCRIPTS": "false",
        "npm_config_fund": "false",
        "NPM_CONFIG_FUND": "false",
        "npm_config_audit": "false",
        "NPM_CONFIG_AUDIT": "false",
    }
    # Prefer the same Node as MCP launch for any npm lifecycle scripts.
    effective_node = node_path or probe.node_path or resolve_node_binary()
    if effective_node:
        node_dir = str(Path(effective_node).resolve().parent)
        env["PATH"] = node_dir + os.pathsep + env.get("PATH", "")

    if progress_cb:
        progress_cb("installing_private_packages")

    # argv array — never shell-string concatenation
    cmd = [
        *npm_argv,
        "install",
        "--prefix",
        str(root),
        "--no-fund",
        "--no-audit",
        "--foreground-scripts",
    ]
    # When package.json already pins deps, plain `npm install` is enough.
    # Still pass package specs when installing into a fresh runtime copy.
    if packaged is None or root.resolve() != packaged.resolve():
        cmd.extend([OHS_PACKAGE, WRITE_MCP_PACKAGE])
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(root),
            env=env,
            **subprocess_hide_window_kwargs(),
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=600.0)
    except TimeoutError as exc:
        raise PackageInstallFailedError("npm install timed out", cause=exc) from exc
    except FileNotFoundError as exc:
        raise NodeRuntimeMissingError("npm not found", cause=exc) from exc

    out = (stdout or b"").decode("utf-8", errors="replace")
    err = (stderr or b"").decode("utf-8", errors="replace")
    combined = sanitize_text(out + "\n" + err)
    if proc.returncode not in (0, None):
        raise PackageInstallFailedError(
            f"npm install failed, exit={proc.returncode}",
            details={"log": combined[-2000:]},
        )

    ohs = ohs_server_js(root)
    write = write_server_js(root)
    if not ohs.is_file() or not write.is_file():
        raise PackageInstallFailedError(
            "install completed but package entrypoints missing",
            details={"ohs": str(ohs), "write": str(write), "log": combined[-1500:]},
        )

    # Ensure better-sqlite3 matches the Node binary we will use to launch OHS.
    node = resolve_node_binary() or (probe.node_path or "")
    if node and (root / "node_modules" / "better-sqlite3").is_dir():
        rebuild_err = await _rebuild_better_sqlite3(node, root)
        if rebuild_err:
            logger.warning("better-sqlite3 rebuild after install: %s", rebuild_err)

    manifest = {
        "ohs_package": OHS_PACKAGE,
        "write_package": WRITE_MCP_PACKAGE,
        "ohs_sha256": sha256_file(ohs),
        "write_sha256": sha256_file(write),
        "installed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "node": node or probe.node_path,
        "installRoot": str(root),
        "packaged": bool(packaged and root.resolve() == packaged.resolve()),
    }
    write_manifest(root, manifest)
    return {
        "ok": True,
        "runtimeRoot": str(root),
        "installRoot": str(root),
        "packagedRoot": str(packaged) if packaged else None,
        "manifest": manifest,
        "log": combined[-1500:],
        "runtime": probe.__dict__,
    }
