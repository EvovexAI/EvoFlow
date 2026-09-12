"""Persistent stream writer for stream execution output.

Provides dual-write functionality: real-time streaming + persistent storage.
Output is saved to stream-specific log files for historical replay.
Supports both task streams and thread streams (for main chat).
"""

import json
import logging
import os
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from evoflow.config.paths import get_paths
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

# Thread-safe lock for file operations
_file_lock = threading.Lock()

# Global registry of active writers
_active_writers: dict[str, "PersistentStreamWriter"] = {}
_writers_lock = threading.Lock()


class PersistentStreamWriter:
    """Stream writer that persists output to file while streaming.

    Features:
    - Dual write: real-time streaming + file persistence
    - JSONL format for easy parsing
    - Automatic file rotation for large outputs
    - Thread-safe file operations
    - Lazy file creation

    Usage:
        writer = PersistentStreamWriter(stream_id, original_writer)
        writer({"type": "stream_started", "stream_id": "xxx"})
        writer({"type": "ai_message", "content": "..."})
        writer.close()
    """

    def __init__(
        self,
        stream_id: str,  # Can be task_id or thread_id
        original_writer: Callable[[dict], Any] | None = None,
        *,
        max_file_size: int = 10 * 1024 * 1024,  # 10MB
        max_files: int = 5,
    ):
        """Initialize persistent stream writer.

        Args:
            stream_id: Stream ID (task_id or thread_id) for output file naming
            original_writer: Original stream writer for real-time streaming
            max_file_size: Maximum file size before rotation
            max_files: Maximum number of rotated files to keep
        """
        self.stream_id = stream_id
        self.original_writer = original_writer
        self.max_file_size = max_file_size
        self.max_files = max_files

        self._file: object | None = None
        self._file_path: Path | None = None
        self._current_size = 0
        self._closed = False
        self._write_count = 0
        self._last_fsync_ts = 0.0

        # Register in active writers
        with _writers_lock:
            _active_writers[stream_id] = self

        logger.debug(f"PersistentStreamWriter created for stream {stream_id}")

    def _get_log_dir(self, thread_id: str | None = None) -> Path:
        """Get log directory for stream outputs.

        Stream outputs are stored per-thread for data lifecycle management:
        {base_dir}/threads/{thread_id}/stream_outputs/

        Args:
            thread_id: Thread ID. If None, uses stream_id as thread_id.
        """
        paths = get_paths()
        tid = thread_id or self.stream_id
        log_dir = paths.thread_dir(tid) / "stream_outputs"
        log_dir.mkdir(parents=True, exist_ok=True)
        return log_dir

    def _get_file_path(self) -> Path:
        """Get file path for stream output log."""
        log_dir = self._get_log_dir()
        return log_dir / f"{self.stream_id}.jsonl"

    def _ensure_file_open(self) -> None:
        """Ensure output file is open."""
        if self._file is None and not self._closed:
            with _file_lock:
                if self._file is None and not self._closed:
                    self._file_path = self._get_file_path()
                    self._file = open(self._file_path, "a", encoding="utf-8")
                    self._current_size = self._file_path.stat().st_size if self._file_path.exists() else 0
                    logger.debug(f"Opened output file: {self._file_path}")

    def _rotate_file_if_needed(self, entry_size: int) -> None:
        """Rotate file if size exceeds limit."""
        if self._current_size + entry_size > self.max_file_size:
            with _file_lock:
                if self._file:
                    self._file.close()

                # Rotate existing files
                for i in range(self.max_files - 1, 0, -1):
                    old_path = self._file_path.with_suffix(f".jsonl.{i}")
                    new_path = self._file_path.with_suffix(f".jsonl.{i + 1}")
                    if old_path.exists():
                        old_path.rename(new_path)

                # Rotate current file
                if self._file_path.exists():
                    self._file_path.rename(self._file_path.with_suffix(".jsonl.1"))

                # Open new file
                self._file = open(self._file_path, "w", encoding="utf-8")
                self._current_size = 0
                logger.info(f"Rotated output file for stream {self.stream_id}")

    def __call__(self, message: dict[str, Any]) -> None:
        """Write message to both stream and file.

        Args:
            message: Message dict to write
        """
        if self._closed:
            logger.warning(f"Writer for stream {self.stream_id} is closed")
            return

        # 1. Real-time streaming (original writer)
        if self.original_writer:
            try:
                self.original_writer(message)
            except Exception as e:
                logger.error(f"Original writer failed: {e}")
                # Continue to persist even if streaming fails

        # 2. Persist to file
        try:
            self._persist_message(message)
        except Exception as e:
            logger.exception(f"Failed to persist message for stream {self.stream_id}: {e}")
            # Don't fail the stream if persistence fails

    def _persist_message(self, message: dict[str, Any]) -> None:
        """Persist message to file.

        Args:
            message: Message dict to persist
        """
        self._ensure_file_open()

        # Add timestamp and stream_id to entry
        entry = {
            **message,
            "_stream_id": self.stream_id,
            "_timestamp": utc_now_iso_z(),
        }

        # Convert to JSON line
        line = json.dumps(entry, ensure_ascii=False, default=str) + "\n"
        line_bytes = line.encode("utf-8")

        # Check rotation
        self._rotate_file_if_needed(len(line_bytes))

        # Write to file
        with _file_lock:
            if self._file:
                self._file.write(line)
                # flush 每条写入即可；fsync 过重，会显著拖慢高频 chunk 的 SSE 体验
                self._file.flush()
                # 限频 fsync（默认 1s 一次），在保证基本落盘的同时避免阻塞
                now = time.monotonic()
                if now - self._last_fsync_ts >= 1.0:
                    try:
                        os.fsync(self._file.fileno())
                    except Exception:
                        pass
                    self._last_fsync_ts = now
                self._current_size += len(line_bytes)
                self._write_count += 1

    def close(self) -> None:
        """Close the writer and release resources."""
        if self._closed:
            return

        self._closed = True

        # Unregister from active writers
        with _writers_lock:
            if self.stream_id in _active_writers:
                del _active_writers[self.stream_id]

        # Close file
        with _file_lock:
            if self._file:
                try:
                    self._file.close()
                    logger.debug(f"Closed output file for stream {self.stream_id}")
                except Exception as e:
                    logger.error(f"Error closing file for stream {self.stream_id}: {e}")
                finally:
                    self._file = None

        logger.info(f"PersistentStreamWriter closed for stream {self.stream_id} (wrote {self._write_count} entries)")

    def __enter__(self) -> "PersistentStreamWriter":
        """Context manager entry."""
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        """Context manager exit."""
        self.close()


def get_persistent_stream_writer(
    stream_id: str,
    original_writer: Callable[[dict], Any] | None = None,
) -> PersistentStreamWriter:
    """Get or create a persistent stream writer for a stream.

    Args:
        stream_id: Stream ID (task_id or thread_id)
        original_writer: Original stream writer for real-time streaming

    Returns:
        PersistentStreamWriter instance
    """
    # Check if there's already an active writer for this stream
    with _writers_lock:
        if stream_id in _active_writers:
            writer = _active_writers[stream_id]
            # Update original writer if provided
            if original_writer:
                writer.original_writer = original_writer
            return writer

    # Create new writer
    return PersistentStreamWriter(stream_id, original_writer)


def get_stream_output_file_path(stream_id: str, thread_id: str | None = None) -> Path | None:
    """Get the output file path for a stream.

    Args:
        stream_id: Stream ID (task_id or thread_id)
        thread_id: Thread ID. If None, uses stream_id as thread_id.

    Returns:
        Path to output file if exists, None otherwise
    """
    try:
        paths = get_paths()
        tid = thread_id or stream_id
        log_dir = paths.thread_dir(tid) / "stream_outputs"
        file_path = log_dir / f"{stream_id}.jsonl"
        return file_path if file_path.exists() else None
    except Exception:
        return None


def read_stream_output(
    stream_id: str,
    offset: int = 0,
    limit: int = 100,
    from_timestamp: str | None = None,
    thread_id: str | None = None,
) -> list[dict]:
    """Read stream output from file.

    Args:
        stream_id: Stream ID (task_id or thread_id)
        offset: Number of entries to skip
        limit: Maximum number of entries to return
        from_timestamp: Only return entries after this timestamp
        thread_id: Thread ID. If None, uses stream_id as thread_id.

    Returns:
        List of output entries
    """
    file_path = get_stream_output_file_path(stream_id, thread_id)
    if not file_path:
        return []

    entries = []
    skipped = 0

    try:
        with open(file_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue

                try:
                    entry = json.loads(line)

                    # Apply timestamp filter
                    if from_timestamp:
                        entry_ts = entry.get("_timestamp", "")
                        if entry_ts and entry_ts < from_timestamp:
                            continue

                    # Apply offset
                    if skipped < offset:
                        skipped += 1
                        continue

                    entries.append(entry)

                    # Apply limit
                    if len(entries) >= limit:
                        break

                except json.JSONDecodeError:
                    logger.warning(f"Invalid JSON in task output file: {line[:100]}")
                    continue

    except Exception as e:
        logger.exception(f"Failed to read stream output for {stream_id}: {e}")

    return entries


def close_writer(stream_id: str) -> bool:
    """Close writer for a specific stream.

    Args:
        stream_id: Stream ID (task_id or thread_id)

    Returns:
        True if writer was found and closed
    """
    with _writers_lock:
        writer = _active_writers.get(stream_id)
        if writer:
            writer.close()
            return True
    return False


def close_all_writers() -> None:
    """Close all active writers."""
    with _writers_lock:
        writers = list(_active_writers.values())
        _active_writers.clear()

    for writer in writers:
        try:
            writer.close()
        except Exception as e:
            logger.error(f"Error closing writer: {e}")

    logger.info(f"Closed {len(writers)} active writers")


# Backward compatibility aliases
get_task_output_file_path = get_stream_output_file_path
read_task_output = read_stream_output


# ============================================================================
# Unified Stream Storage Singleton
# ============================================================================


class StreamStorage:
    """统一流式数据内存缓存入口。

    所有流数据（正常聊天、任务执行）都通过此单例广播到内存队列，
    供 SSE 订阅者实时接收。会话结束后自动释放，不写入文件。
    """

    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return
        self._initialized = True

    async def broadcast(
        self,
        thread_id: str,
        event_type: str,
        data: dict[str, Any],
    ) -> None:
        """广播流数据到 SSE 订阅者（纯内存，不写文件）。

        Args:
            thread_id: Thread ID
            event_type: 事件类型（如 "lead_agent:chunk"）
            data: 事件数据
        """
        try:
            from app.gateway.routers.events import broadcaster

            await broadcaster.broadcast(thread_id, event_type, data)
        except ImportError:
            logger.warning("Could not import broadcaster, SSE events will not be sent")
        except Exception as e:
            logger.error(f"StreamStorage broadcast failed for thread {thread_id}: {e}")

    def read(
        self,
        thread_id: str,
        offset: int = 0,
        limit: int = 100,
    ) -> list[dict]:
        """读取历史流数据。

        Args:
            thread_id: Thread ID
            offset: 跳过条目数
            limit: 返回条目数限制

        Returns:
            历史流数据列表
        """
        return read_stream_output(thread_id, offset, limit, thread_id=thread_id)

    def close(self, thread_id: str) -> bool:
        """关闭指定 thread 的写入器。

        Args:
            thread_id: Thread ID

        Returns:
            是否找到并关闭了写入器
        """
        with self._writers_lock:
            writer = self._writers.pop(thread_id, None)
            if writer:
                writer.close()
                return True
        return False

    def close_all(self) -> None:
        """关闭所有写入器"""
        with self._writers_lock:
            writers = list(self._writers.values())
            self._writers.clear()

        for writer in writers:
            try:
                writer.close()
            except Exception as e:
                logger.error(f"Error closing writer: {e}")


# 全局单例实例
stream_storage = StreamStorage()


# ============================================================================
# Stream Status Query API
# ============================================================================


def get_stream_status(thread_id: str) -> dict:
    """获取流状态信息，供前端查询。

    Args:
        thread_id: Thread ID

    Returns:
        状态字典：
        - is_stream_active: 是否正在流式输出
        - elapsed_seconds: 流式已持续时间
        - source: 状态来源 (proxy_memory / langgraph_api / none)
    """
    try:
        import time

        result = {
            "thread_id": thread_id,
            "is_stream_active": False,
            "elapsed_seconds": None,
            "source": "none",
        }

        # 1. 先查内存
        try:
            from app.gateway.routers.langgraph_proxy import _active_stream_proxies

            in_memory = thread_id in _active_stream_proxies
            if in_memory:
                result["is_stream_active"] = True
                result["elapsed_seconds"] = round(time.time() - _active_stream_proxies[thread_id], 2)
                result["source"] = "proxy_memory"
                return result
        except Exception as e:
            logger.debug("get_stream_status memory check failed: thread_id=%s err=%s", thread_id, e)

        # 2. 内存没有，查 LangGraph API
        try:
            import httpx

            from app.gateway.routers.langgraph_proxy import LANGGRAPH_BASE_URL

            timeout = httpx.Timeout(connect=2.0, read=5.0)
            with httpx.Client(timeout=timeout) as client:
                url = f"{LANGGRAPH_BASE_URL}/threads/{thread_id}/runs"
                resp = client.get(url, params={"limit": 1, "status": "running"})
                if resp.status_code == 200:
                    runs = resp.json()

                    if isinstance(runs, list) and len(runs) > 0:
                        result["is_stream_active"] = True
                        result["source"] = "langgraph_api"
                        return result
                    else:
                        pass
                else:
                    logger.debug("get_stream_status langgraph runs error: thread_id=%s status=%s body=%s", thread_id, resp.status_code, resp.text[:200])
        except Exception as e:
            logger.debug("get_stream_status langgraph query failed: thread_id=%s err=%s", thread_id, e)

        return result
    except Exception as outer_e:
        logger.debug("get_stream_status outer exception: thread_id=%s err=%s", thread_id, outer_e)
        return {"thread_id": thread_id, "is_stream_active": False, "elapsed_seconds": None, "source": "error"}
