"""Background workspace file watcher → incremental code index updates."""

from __future__ import annotations

import logging
import threading
from pathlib import Path

from evoflow.code_index.store import index_file, resolve_index_root
from evoflow.config.code_index_config import get_code_index_config

logger = logging.getLogger(__name__)


def _watch_key(root: str) -> str:
    from evoflow.code_index.store import _workspace_hash

    return _workspace_hash(root)


class _WatchHandle:
    def __init__(self, root: str, *, workspace_root: str | None, thread_id: str | None) -> None:
        self.root = root
        self.workspace_root = workspace_root
        self.thread_id = thread_id
        self.ref_count = 1
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name=f"code-index-watch-{self.root[-8:]}", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=5.0)

    def _run(self) -> None:
        cfg = get_code_index_config()
        try:
            from watchfiles import watch
        except ImportError:
            logger.warning("watchfiles not installed; code index watcher disabled")
            return

        root_path = Path(self.root)
        logger.info(
            "code_index watcher started for %s (debounce_ms=%d)",
            self.root,
            cfg.watcher_debounce_ms,
        )
        try:
            for changes in watch(
                self.root,
                watch_filter=None,
                debounce=int(cfg.watcher_debounce_ms),
                step=200,
                stop_event=self._stop,
                recursive=True,
            ):
                if self._stop.is_set():
                    break
                for change, abs_path in changes:
                    self._apply_change(change, Path(abs_path), root_path)
        except Exception as e:
            if not self._stop.is_set():
                logger.warning("code_index watcher stopped for %s: %s", self.root, e)
        logger.info("code_index watcher exited for %s", self.root)

    def _apply_change(self, change: object, abs_path: Path, root_path: Path) -> None:
        from watchfiles import Change

        try:
            rel = abs_path.relative_to(root_path).as_posix()
        except ValueError:
            return
        if change == Change.deleted:
            index_file(
                self.workspace_root,
                relative_path=rel,
                thread_id=self.thread_id,
                deleted=True,
            )
        elif change in (Change.added, Change.modified):
            index_file(
                self.workspace_root,
                relative_path=rel,
                thread_id=self.thread_id,
            )


class CodeIndexWatcherRegistry:
    """One watcher thread per resolved workspace root (reference counted)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._handles: dict[str, _WatchHandle] = {}

    def start(
        self,
        *,
        workspace_root: str | None = None,
        thread_id: str | None = None,
        explicit: bool = False,
    ) -> dict:
        cfg = get_code_index_config()
        if not cfg.enabled:
            return {"ok": False, "reason": "index_disabled"}
        if not explicit and not cfg.watcher_enabled:
            return {"ok": False, "reason": "watcher_disabled"}
        root = resolve_index_root(workspace_root=workspace_root, thread_id=thread_id)
        key = _watch_key(root)
        with self._lock:
            existing = self._handles.get(key)
            if existing:
                existing.ref_count += 1
                return {"ok": True, "root": root, "watching": True, "started": False}
            handle = _WatchHandle(
                root,
                workspace_root=workspace_root,
                thread_id=thread_id,
            )
            handle.start()
            self._handles[key] = handle
            return {"ok": True, "root": root, "watching": True, "started": True}

    def stop(
        self,
        *,
        workspace_root: str | None = None,
        thread_id: str | None = None,
    ) -> dict:
        root = resolve_index_root(workspace_root=workspace_root, thread_id=thread_id)
        key = _watch_key(root)
        with self._lock:
            handle = self._handles.get(key)
            if not handle:
                return {"ok": True, "root": root, "watching": False}
            handle.ref_count -= 1
            if handle.ref_count <= 0:
                handle.stop()
                del self._handles[key]
                return {"ok": True, "root": root, "watching": False, "stopped": True}
            return {"ok": True, "root": root, "watching": True, "stopped": False}

    def status(
        self,
        *,
        workspace_root: str | None = None,
        thread_id: str | None = None,
    ) -> dict:
        root = resolve_index_root(workspace_root=workspace_root, thread_id=thread_id)
        key = _watch_key(root)
        with self._lock:
            handle = self._handles.get(key)
            return {
                "ok": True,
                "root": root,
                "watching": handle is not None,
                "ref_count": handle.ref_count if handle else 0,
            }


_watcher_registry = CodeIndexWatcherRegistry()


def start_index_watch(*, workspace_root: str | None = None, thread_id: str | None = None) -> dict:
    return _watcher_registry.start(workspace_root=workspace_root, thread_id=thread_id, explicit=True)


def stop_index_watch(*, workspace_root: str | None = None, thread_id: str | None = None) -> dict:
    return _watcher_registry.stop(workspace_root=workspace_root, thread_id=thread_id)


def index_watch_status(*, workspace_root: str | None = None, thread_id: str | None = None) -> dict:
    return _watcher_registry.status(workspace_root=workspace_root, thread_id=thread_id)
