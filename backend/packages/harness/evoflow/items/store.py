"""用户事项 JSON 持久化（``{EVOFLOW_HOME}/data/user_items.json``）。"""

from __future__ import annotations

import json
import logging
import threading
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_lock = threading.RLock()
_CACHE: dict[str, Any] | None = None
# 磁盘 mtime（ns）；外进程写库后本进程缓存自动失效
_CACHE_MTIME_NS: int | None = None


def _store_path() -> Path:
    from evoflow.config.paths import get_paths

    base = get_paths().base_dir / "data"
    base.mkdir(parents=True, exist_ok=True)
    return base / "user_items.json"


def _empty_doc() -> dict[str, Any]:
    return {"version": 1, "items": []}


def _file_mtime_ns(path: Path) -> int | None:
    try:
        return path.stat().st_mtime_ns
    except OSError:
        return None


def _load_unlocked() -> dict[str, Any]:
    global _CACHE, _CACHE_MTIME_NS
    path = _store_path()
    mtime_ns = _file_mtime_ns(path) if path.exists() else None
    # 外进程（CLI / 另一 Python）改写文件后，Gateway 进程内缓存必须失效，否则面板仍见旧 status
    if _CACHE is not None and mtime_ns is not None and mtime_ns == _CACHE_MTIME_NS:
        return _CACHE
    if _CACHE is not None and mtime_ns is None and _CACHE_MTIME_NS is None and not path.exists():
        return _CACHE
    if not path.exists():
        _CACHE = _empty_doc()
        _CACHE_MTIME_NS = None
        return _CACHE
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            _CACHE = _empty_doc()
            _CACHE_MTIME_NS = _file_mtime_ns(path)
            return _CACHE
        items = raw.get("items")
        if not isinstance(items, list):
            raw["items"] = []
        raw.setdefault("version", 1)
        _CACHE = raw
        _CACHE_MTIME_NS = _file_mtime_ns(path)
        return _CACHE
    except Exception:
        logger.exception("failed to load user_items.json")
        _CACHE = _empty_doc()
        _CACHE_MTIME_NS = _file_mtime_ns(path)
        return _CACHE


def _save_unlocked(doc: dict[str, Any]) -> None:
    global _CACHE, _CACHE_MTIME_NS
    path = _store_path()
    tmp = path.with_suffix(".json.tmp")
    payload = json.dumps(doc, ensure_ascii=False, indent=2)
    tmp.write_text(payload, encoding="utf-8")
    tmp.replace(path)
    _CACHE = doc
    _CACHE_MTIME_NS = _file_mtime_ns(path)


def load_doc() -> dict[str, Any]:
    with _lock:
        return _load_unlocked()


def save_doc(doc: dict[str, Any]) -> None:
    with _lock:
        _save_unlocked(doc)


def list_raw_items() -> list[dict[str, Any]]:
    with _lock:
        doc = _load_unlocked()
        items = doc.get("items")
        return list(items) if isinstance(items, list) else []


def replace_all_items(items: list[dict[str, Any]]) -> None:
    with _lock:
        doc = _load_unlocked()
        doc["items"] = list(items)
        _save_unlocked(doc)


def upsert_raw_item(item: dict[str, Any]) -> dict[str, Any]:
    with _lock:
        doc = _load_unlocked()
        items = doc.get("items")
        if not isinstance(items, list):
            items = []
            doc["items"] = items
        iid = str(item.get("id") or "").strip()
        if not iid:
            raise ValueError("item id required")
        for i, row in enumerate(items):
            if isinstance(row, dict) and str(row.get("id") or "") == iid:
                items[i] = item
                _save_unlocked(doc)
                return item
        items.append(item)
        _save_unlocked(doc)
        return item


def delete_raw_item(item_id: str) -> bool:
    with _lock:
        doc = _load_unlocked()
        items = doc.get("items")
        if not isinstance(items, list):
            return False
        iid = str(item_id or "").strip()
        next_items = [r for r in items if not (isinstance(r, dict) and str(r.get("id") or "") == iid)]
        if len(next_items) == len(items):
            return False
        doc["items"] = next_items
        _save_unlocked(doc)
        return True


def reset_store_for_tests() -> None:
    """测试用：清空内存缓存（不删磁盘，由临时 EVOFLOW_HOME 隔离）。"""
    global _CACHE, _CACHE_MTIME_NS
    with _lock:
        _CACHE = None
        _CACHE_MTIME_NS = None
