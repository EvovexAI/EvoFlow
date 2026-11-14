"""Persistence / memory-pressure snapshot for Ops runtime-status.

Desktop chat SSOT is ``evoflow.db`` (messages), not LangGraph checkpointer.
This module surfaces the *extra* stores that actually blow RSS:

- ``.langgraph_api/*.pckl`` — LG inmem file persistence (should be off when
  durable checkpointer is configured; often leftover multi-GB dumps)
- configured sqlite ``checkpoints.db`` (often unused / missing on packaged desktop)
- ``evoflow.db`` (+ WAL) size
- LangGraph process RSS
- fattest chat sessions by ``content_json`` (which session is heavy)

Cheap enough for a 5s Obs poll: directory listing + one bounded SQL GROUP BY.
"""

from __future__ import annotations

import logging
import os
import sqlite3
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_FAT_SESSION_LIMIT = 8


def _mb(n: int | float | None) -> float:
    try:
        return round(float(n or 0) / (1024 * 1024), 1)
    except (TypeError, ValueError):
        return 0.0


def _file_info(path: Path) -> dict[str, Any] | None:
    try:
        if not path.is_file():
            return None
        st = path.stat()
        return {
            "path": str(path),
            "bytes": int(st.st_size),
            "mb": _mb(st.st_size),
            "mtime": int(st.st_mtime),
        }
    except OSError:
        return None


def _list_pckl_files(data_dir: Path) -> list[dict[str, Any]]:
    if not data_dir.is_dir():
        return []
    out: list[dict[str, Any]] = []
    try:
        for p in sorted(data_dir.iterdir(), key=lambda x: x.name):
            if not p.is_file():
                continue
            name = p.name
            if not (name.endswith(".pckl") or name.endswith(".pckl.tmp")):
                continue
            info = _file_info(p)
            if info:
                info["name"] = name
                out.append(info)
    except OSError as e:
        logger.debug("list .langgraph_api failed: %s", e)
    out.sort(key=lambda x: int(x.get("bytes") or 0), reverse=True)
    return out


def _langgraph_process_rss() -> dict[str, Any]:
    """Best-effort RSS for the split ``--mode langgraph`` sibling process."""
    try:
        import psutil
    except ImportError:
        return {"available": False, "error": "psutil_missing"}

    matches: list[dict[str, Any]] = []
    try:
        for proc in psutil.process_iter(["pid", "name", "cmdline", "memory_info"]):
            try:
                cmd = proc.info.get("cmdline") or []
                joined = " ".join(str(x) for x in cmd)
                if "--mode langgraph" not in joined and "langgraph-port" not in joined:
                    # also catch bare langgraph_api server without our flag
                    if "langgraph_api" not in joined and "langgraph.api" not in joined:
                        continue
                mem = proc.info.get("memory_info")
                rss = int(getattr(mem, "rss", 0) or 0) if mem else 0
                matches.append(
                    {
                        "pid": int(proc.info.get("pid") or 0),
                        "rss_bytes": rss,
                        "rss_mb": _mb(rss),
                        "rss_gb": round(rss / (1024**3), 2),
                        "name": str(proc.info.get("name") or ""),
                    }
                )
            except (psutil.Error, OSError, TypeError, ValueError):
                continue
    except Exception as e:
        return {"available": False, "error": str(e)[:200]}

    if not matches:
        return {"available": True, "found": False, "processes": []}
    matches.sort(key=lambda x: int(x.get("rss_bytes") or 0), reverse=True)
    top = matches[0]
    return {
        "available": True,
        "found": True,
        "pid": top.get("pid"),
        "rss_bytes": top.get("rss_bytes"),
        "rss_mb": top.get("rss_mb"),
        "rss_gb": top.get("rss_gb"),
        "processes": matches[:5],
    }


def _checkpointer_config_snapshot() -> dict[str, Any]:
    cp_type = ""
    raw_conn = ""
    try:
        from evoflow.config.app_config import get_app_config

        cp_cfg = getattr(get_app_config(), "checkpointer", None)
        cp_type = str(getattr(cp_cfg, "type", "") or "").strip().lower()
        raw_conn = str(getattr(cp_cfg, "connection_string", "") or "").strip()
    except Exception:
        logger.debug("read checkpointer config failed", exc_info=True)

    path: Path | None = None
    try:
        from evoflow.config.data_paths import resolve_checkpoints_config_path

        if raw_conn:
            path = resolve_checkpoints_config_path(raw_conn)
        else:
            path = resolve_checkpoints_config_path("checkpoints.db")
    except Exception:
        logger.debug("resolve checkpoints path failed", exc_info=True)

    info = _file_info(path) if path else None
    disable = (os.getenv("LANGGRAPH_DISABLE_FILE_PERSISTENCE") or "").strip().lower()
    keep = (os.getenv("EVOFLOW_KEEP_LG_FILE_PERSISTENCE") or "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )
    return {
        "configured_type": cp_type or None,
        "connection_string": raw_conn or None,
        "sqlite_path": str(path) if path else None,
        "sqlite_exists": bool(info),
        "sqlite_mb": (info or {}).get("mb", 0),
        "sqlite_bytes": (info or {}).get("bytes", 0),
        "file_persistence_disabled": disable in ("1", "true", "yes", "on"),
        "file_persistence_env": disable or "unset",
        "keep_lg_file_persistence": keep,
        "chat_ssot": "evoflow_chat_messages",
        "note": (
            "聊天正文 SSOT 是 evoflow.db；"
            ".pckl 是 LangGraph 额外落盘；"
            "sqlite checkpointer 在打包桌面常未真正挂上。"
        ),
    }


def _evoflow_db_sizes() -> dict[str, Any]:
    try:
        from evoflow.persistence.db import resolve_evolflow_db_path

        db = Path(resolve_evolflow_db_path())
    except Exception as e:
        return {"error": str(e)[:200]}

    main = _file_info(db)
    wal = _file_info(Path(str(db) + "-wal"))
    shm = _file_info(Path(str(db) + "-shm"))
    total = int((main or {}).get("bytes") or 0) + int((wal or {}).get("bytes") or 0)
    return {
        "path": str(db),
        "db_mb": (main or {}).get("mb", 0),
        "wal_mb": (wal or {}).get("mb", 0),
        "shm_mb": (shm or {}).get("mb", 0),
        "total_mb": _mb(total),
        "exists": bool(main),
    }


def _fat_sessions(limit: int = _FAT_SESSION_LIMIT) -> dict[str, Any]:
    """Largest sessions by message payload — proxy for 'which chat is heavy'."""
    try:
        from evoflow.persistence.db import resolve_evolflow_db_path

        db = Path(resolve_evolflow_db_path())
        if not db.is_file():
            return {"sessions": [], "error": "evoflow.db_missing"}
        uri = f"file:{db.as_posix()}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=2.0)
        try:
            rows = conn.execute(
                """
                SELECT m.session_key,
                       COUNT(*) AS n,
                       SUM(LENGTH(COALESCE(m.content_json, ''))) AS bytes,
                       MAX(s.thread_id) AS thread_id,
                       MAX(s.title) AS title,
                       MAX(s.run_status) AS run_status
                FROM evoflow_chat_messages m
                LEFT JOIN evoflow_chat_sessions s ON s.session_key = m.session_key
                GROUP BY m.session_key
                ORDER BY bytes DESC
                LIMIT ?
                """,
                (int(limit),),
            ).fetchall()
        finally:
            conn.close()
    except Exception as e:
        return {"sessions": [], "error": str(e)[:200]}

    sessions = []
    for sk, n, b, tid, title, run_status in rows:
        sessions.append(
            {
                "session_key": sk,
                "thread_id": tid,
                "title": title,
                "run_status": run_status,
                "message_count": int(n or 0),
                "content_bytes": int(b or 0),
                "content_mb": _mb(b),
            }
        )
    return {"sessions": sessions, "limit": limit}


def build_persistence_pressure_snapshot() -> dict[str, Any]:
    """Payload nested under ``runtime-status.persistence_pressure``."""
    try:
        from evoflow.langgraph_runtime_env import langgraph_api_data_dir

        lg_dir = langgraph_api_data_dir()
    except Exception:
        from pathlib import Path as _P

        home = (os.getenv("EVOFLOW_HOME") or "").strip()
        base = _P(home).expanduser() if home else _P.home() / ".evoflow"
        lg_dir = base / ".langgraph_api"

    files = _list_pckl_files(lg_dir)
    total_bytes = sum(int(f.get("bytes") or 0) for f in files)
    checkpointer = _checkpointer_config_snapshot()
    evo_db = _evoflow_db_sizes()
    lg_rss = _langgraph_process_rss()
    fat = _fat_sessions()

    warn_gb = total_bytes >= 512 * 1024 * 1024  # ≥512MB pckl
    warn_rss = bool(lg_rss.get("found")) and float(lg_rss.get("rss_gb") or 0) >= 4.0
    warn_wal = float(evo_db.get("wal_mb") or 0) >= 512

    return {
        "langgraph_api_dir": str(lg_dir),
        "pckl": {
            "file_count": len(files),
            "total_bytes": total_bytes,
            "total_mb": _mb(total_bytes),
            "total_gb": round(total_bytes / (1024**3), 2),
            "files": files[:12],
        },
        "checkpointer": checkpointer,
        "evoflow_db": evo_db,
        "langgraph_process": lg_rss,
        "fat_sessions": fat,
        "warnings": {
            "pckl_large": warn_gb,
            "langgraph_rss_high": warn_rss,
            "evoflow_wal_large": warn_wal,
        },
        "legend": {
            "pckl": "LangGraph 进程落盘的内存态（*.pckl），不是聊天库；偏大时启动必灌 RSS",
            "checkpointer_sqlite": "配置里的 checkpoints.db；聊天 UI 不读它；打包桌面常未创建",
            "evoflow_db": "聊天正文 / V4 hydrate 的 SSOT",
            "fat_sessions": "按消息 content_json 体积排序的会话（哪条对话最肥）",
            "langgraph_rss": "Agent Runtime（--mode langgraph）进程工作集",
        },
    }
