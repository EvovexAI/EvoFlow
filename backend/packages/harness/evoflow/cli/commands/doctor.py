"""evoflow doctor — 本机环境自检（卡死 / DB 锁 / 技能装了不生效 / 残留进程排查）。"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from evoflow.cli.common import add_output_flags

_STALE_PYTHON_WARN_THRESHOLD = 15


def register(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser(
        "doctor",
        help="Diagnose local environment (DB locks, stale processes, skills roots)",
        description=(
            "本机环境自检：SQLite 锁/-wal 残留、python 残留进程、技能根目录错位、"
            "EVOFLOW_* 环境变量、gateway 运行时信息。用于排查 CLI 卡死、"
            "技能装了不生效、venv python 启动慢等问题。"
        ),
    )
    add_output_flags(parser)
    parser.set_defaults(handler=_run)


def _check_env() -> dict[str, Any]:
    relevant = [
        "EVOFLOW_HOME",
        "EVOFLOW_SKILLS_PATH",
        "EVOFLOW_CONFIG_DIR",
        "EVOFLOW_CONFIG_PATH",
        "EVOFLOW_DB_PATH",
        "EVOFLOW_PROFILE",
        "EVOFLOW_GATEWAY_URL",
        "EVOFLOW_SQLITE_BUSY_TIMEOUT_MS",
    ]
    detail: dict[str, Any] = {
        "python": sys.version.split()[0],
        "executable": str(sys.executable),
        "frozen": bool(getattr(sys, "frozen", False)),
        "envs": {k: os.getenv(k, "") for k in relevant},
    }
    try:
        from evoflow.config.data_paths import prefer_profile_base_dir, resolve_active_profile_id
        from evoflow.config.paths import get_paths

        paths = get_paths()
        shared = Path.home() / ".evoflow"
        detail["resolved_base_dir"] = str(paths.base_dir)
        detail["active_profile"] = resolve_active_profile_id(shared) if shared.is_dir() else None
        detail["profile_aware_home"] = str(prefer_profile_base_dir(shared)) if shared.is_dir() else None
        if not (os.getenv("EVOFLOW_HOME") or "").strip() and shared.is_dir():
            root_db = shared / "data" / "app" / "evoflow.db"
            profile_home = Path(str(detail["profile_aware_home"] or ""))
            if profile_home.is_dir() and paths.base_dir.resolve() != profile_home.resolve():
                detail["home_mismatch"] = {
                    "cli_base": str(paths.base_dir),
                    "panel_profile": str(profile_home),
                    "root_db_exists": root_db.is_file(),
                }
    except Exception as exc:
        detail["resolve_error"] = str(exc)
    return {
        "name": "env",
        "ok": True,
        "detail": detail,
    }


def _check_media_credentials() -> dict[str, Any]:
    """Surface whether panel MiniMax/etc. credentials are visible to this process."""
    try:
        from evoflow.community.media_generation.config_helpers import available_media_providers
        from evoflow.config.paths import get_paths
        from evoflow.persistence.db import resolve_evolflow_db_path
        from evoflow.persistence.media_settings import get_enabled_vendors, get_media_credentials

        creds = get_media_credentials()
        enabled = get_enabled_vendors()
        mk = str(creds.get("minimaxMediaApiKey") or "").strip()
        detail = {
            "db_path": str(resolve_evolflow_db_path()),
            "base_dir": str(get_paths().base_dir),
            "enabledVendors": {
                k: bool(enabled.get(k))
                for k in ("volcengine", "minimax", "dashscope", "openai-image", "kling")
            },
            "has_minimaxMediaApiKey": bool(mk),
            "minimaxMediaBaseUrl": str(creds.get("minimaxMediaBaseUrl") or ""),
            "preferredVideoProvider": str(creds.get("preferredVideoProvider") or ""),
            "available_providers": available_media_providers(),
        }
        ok = True
        hint = None
        if enabled.get("minimax") and not mk:
            ok = False
            hint = "MiniMax 已启用但未读到 API Key：确认 CLI 的 base_dir 与面板 profile 一致（见 env.resolved_base_dir）"
        elif not enabled.get("minimax") and not (detail["available_providers"].get("video") or []):
            hint = (
                "当前进程看不到可用视频渠道。若面板已配置 MiniMax，请确认 "
                "EVOFLOW_HOME 指向 ~/.evoflow/profiles/<id>（或升级后让 CLI 自动解析 profile）"
            )
        out: dict[str, Any] = {"name": "media_credentials", "ok": ok, "detail": detail}
        if hint:
            out["hint"] = hint
        return out
    except Exception as exc:
        return {
            "name": "media_credentials",
            "ok": False,
            "detail": {"error": str(exc)},
            "hint": "无法读取 media.credentials；检查 EVOFLOW_HOME / 数据库路径",
        }


def _probe_sidecar_locks(db_path: Path) -> list[str]:
    """检查 -wal/-shm 是否被其他进程占用（Windows 上会让新进程打不开库）。"""
    locked: list[str] = []
    for suffix in ("-wal", "-shm"):
        sidecar = Path(str(db_path) + suffix)
        if not sidecar.is_file():
            continue
        try:
            with open(sidecar, "ab"):
                pass
        except (PermissionError, OSError) as exc:
            locked.append(f"{sidecar.name} ({exc})")
    return locked


def _check_database() -> dict[str, Any]:
    detail: dict[str, Any] = {}
    ok = True
    try:
        from evoflow.persistence.db import resolve_evolflow_db_path

        db_path = Path(resolve_evolflow_db_path())
    except Exception as exc:
        return {
            "name": "database",
            "ok": False,
            "detail": {"error": f"解析 DB 路径失败: {exc}"},
            "hint": "检查 config.yaml 的 storage.sqlite_path 与 EVOFLOW_DB_PATH/EVOFLOW_HOME 设置",
        }
    detail["path"] = str(db_path)
    try:
        detail["size_mb"] = round(db_path.stat().st_size / (1024 * 1024), 1)
    except OSError:
        detail["size_mb"] = None
    locked = _probe_sidecar_locks(db_path)
    detail["locked_sidecars"] = locked
    if locked:
        ok = False
        detail["error"] = "SQLite sidecar 被其他进程占用"
    else:
        conn: sqlite3.Connection | None = None
        t0 = time.perf_counter()
        try:
            conn = sqlite3.connect(str(db_path), timeout=3.0)
            conn.execute("PRAGMA busy_timeout=2000")
            rows = conn.execute("PRAGMA quick_check").fetchall()
            result = str(rows[0][0]) if rows else "no result"
            detail["quick_check"] = result
            detail["connect_ms"] = round((time.perf_counter() - t0) * 1000, 1)
            if result != "ok":
                ok = False
                detail["error"] = f"quick_check 异常: {result[:200]}"
        except sqlite3.OperationalError as exc:
            ok = False
            detail["error"] = f"打开/查询 DB 失败: {exc}"
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass
    hint = None
    if locked:
        hint = (
            "有残留的 evoflow/python 进程占着 -wal/-shm：在任务管理器结束对应进程后重试；"
            "确认无进程运行时可手动删除列出的 sidecar 文件"
        )
    elif not ok:
        hint = "DB 打不开/校验不过：先停掉所有 evoflow 进程，必要时备份后重建库"
    out: dict[str, Any] = {"name": "database", "ok": ok, "detail": detail}
    if hint:
        out["hint"] = hint
    return out


def _check_skills() -> dict[str, Any]:
    try:
        from evoflow.skills.loader import describe_skills_root_context

        ctx = describe_skills_root_context()
    except Exception as exc:
        return {"name": "skills", "ok": False, "detail": {"error": str(exc)}}
    warnings = list(ctx.get("warnings") or [])
    out: dict[str, Any] = {
        "name": "skills",
        "ok": not warnings,
        "detail": {
            "active_root": ctx.get("active"),
            "active_source": ctx.get("active_source"),
            "candidates": ctx.get("candidates"),
        },
        "warnings": warnings,
    }
    if warnings:
        out["hint"] = "技能只从生效根加载；把目录里的技能移动/复制到生效根的 skills/custom/ 下，或用面板技能页安装"
    return out


def _count_stale_python_processes() -> dict[str, Any] | None:
    """统计 python 进程数（残留堆积会让 venv python 启动极慢甚至挂起）。"""
    try:
        if sys.platform == "win32":
            output = subprocess.run(
                ["tasklist", "/FI", "IMAGENAME eq python.exe", "/FO", "CSV", "/NH"],
                capture_output=True,
                text=True,
                timeout=10,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            lines = [ln for ln in (output.stdout or "").splitlines() if ln.strip().startswith('"')]
            count = len(lines)
        else:
            output = subprocess.run(
                ["pgrep", "-c", "python"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            count = int((output.stdout or "0").strip() or 0)
    except Exception:
        return None
    return {"name": "processes", "ok": count < _STALE_PYTHON_WARN_THRESHOLD, "detail": {"python_process_count": count}}


def _find_gateway_runtime() -> dict[str, Any]:
    """尽力读取面板写的 backend-runtime.json（profile 目录下）。"""
    candidates: list[Path] = []
    home = os.getenv("EVOFLOW_HOME", "").strip()
    if home:
        candidates.append(Path(home) / "backend-runtime.json")
    for base in (Path.home() / ".evoflow", Path.home() / ".evoflow-dev"):
        profiles = base / "profiles"
        if profiles.is_dir():
            try:
                candidates.extend(p / "backend-runtime.json" for p in sorted(profiles.iterdir()) if p.is_dir())
            except OSError:
                pass
    for candidate in candidates:
        try:
            if candidate.is_file():
                data = json.loads(candidate.read_text(encoding="utf-8"))
                return {
                    "path": str(candidate),
                    "baseUrl": data.get("baseUrl"),
                    "port": data.get("port"),
                    "status": data.get("status"),
                    "pid": data.get("pid"),
                }
        except Exception:
            continue
    return {"path": None}


def _run(args: argparse.Namespace) -> dict[str, Any]:
    checks: list[dict[str, Any]] = [
        _check_env(),
        _check_database(),
        _check_media_credentials(),
        _check_skills(),
    ]
    proc_check = _count_stale_python_processes()
    if proc_check is not None:
        if not proc_check["ok"]:
            proc_check["hint"] = (
                f"检测到 {proc_check['detail']['python_process_count']} 个 python 进程：残留堆积可能导致 "
                "venv python 启动极慢甚至挂起（CLI 卡死的常见根因）。清理不需要的 python 进程后重试"
            )
        checks.append(proc_check)
    runtime = _find_gateway_runtime()

    hints: list[str] = []
    for check in checks:
        hints.extend(check.get("warnings") or [])
        if check.get("hint"):
            hints.append(check["hint"])
    hints.append(
        "CLI 长时间无响应时的替代通道：EvoPanel/gateway HTTP API"
        + (f"（当前 gateway: {runtime.get('baseUrl')}）" if runtime.get("baseUrl") else "（端口见 profile 目录下 backend-runtime.json）")
    )

    return {
        "command": "doctor",
        "ok": all(bool(c.get("ok")) for c in checks),
        "checks": checks,
        "gateway_runtime": runtime,
        "hints": hints,
    }
