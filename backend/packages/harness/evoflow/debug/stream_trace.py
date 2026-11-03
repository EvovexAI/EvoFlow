"""Stream trace debug module for storing complete vendor vs gateway streaming output.

Usage:
    # Enable stream tracing (set env before startup)
    import os
    os.environ["EVOFLOW_STREAM_TRACE"] = "1"  # or "true", "yes", "on"

    # In code:
    from evoflow.debug.stream_trace import stream_trace

    # Log vendor (raw LLM response chunks)
    stream_trace.log_vendor_chunk(thread_id, chunk)

    # Log gateway (processed SSE output)
    stream_trace.log_gateway_chunk(thread_id, chunk)
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from contextvars import ContextVar
from datetime import datetime
from pathlib import Path
from typing import Any

from evoflow.debug.trace_sink import debug_log_root

_SAFE_THREAD_ID = re.compile(r"^[a-zA-Z0-9._-]+$")

# Context variable set by the gateway before invoking a chat model,
# so the chat model layer (vendor_roundtrip) can find the thread_id
# without relying on langgraph's var_child_runnable_config (which is
# not set when LangChain chat models stream directly).
_CURRENT_THREAD_ID: ContextVar[str | None] = ContextVar("evoflow_stream_trace_thread_id", default=None)


def set_current_thread_id(thread_id: str | None) -> None:
    """Set the active thread id for the current async/sync context.

    Called by the gateway right before it invokes a LangGraph run that
    ultimately streams from a chat model. Vendor-side trace code reads
    this via :func:`get_current_thread_id`.
    """
    _CURRENT_THREAD_ID.set((thread_id or "").strip() or None)


def get_current_thread_id() -> str | None:
    """Read the active thread id (set by :func:`set_current_thread_id`)."""
    return _CURRENT_THREAD_ID.get()


def _is_stream_trace_enabled() -> bool:
    """Opt-in only. Set ``EVOFLOW_STREAM_TRACE=1`` to enable (release-safe default off)."""
    from evoflow.runtime.log_policy import env_flag

    return env_flag("EVOFLOW_STREAM_TRACE", default=False)


def _normalize_thread_id(thread_id: str | None) -> str:
    """Normalize thread_id for safe directory naming."""
    s = (thread_id or "").strip()
    if not s or s == "unknown" or not _SAFE_THREAD_ID.match(s):
        return "_no_thread"
    return s


def _stream_trace_root() -> Path:
    """Get the root directory for stream traces under product ``logs/debug``."""
    try:
        from evoflow.runtime.log_policy import resolve_debug_logs_dir

        return resolve_debug_logs_dir() / "stream_trace"
    except Exception:
        return debug_log_root() / "logs" / "debug" / "stream_trace"


class _StreamTraceWriter:
    """Thread-safe writer for stream trace logs."""

    def __init__(self, thread_id: str) -> None:
        self._thread_id = thread_id
        self._seg = _normalize_thread_id(thread_id)
        self._root = _stream_trace_root() / self._seg
        self._vendor_file = self._root / "vendor_stream.jsonl"
        self._gateway_file = self._root / "gateway_stream.jsonl"
        self._lock = threading.Lock()
        self._files_created = False

    def _ensure_files(self) -> None:
        """Ensure log files exist (called within lock)."""
        if not self._files_created:
            self._root.mkdir(parents=True, exist_ok=True)
            # Create header comments if files don't exist
            if not self._vendor_file.exists():
                with open(self._vendor_file, "w", encoding="utf-8") as f:
                    f.write(
                        f"# Stream Trace - Vendor (Raw LLM Response)\n"
                        f"# Thread: {self._thread_id}\n"
                        f"# Started: {datetime.now().isoformat()}\n"
                        f"# Format: JSONL\n\n"
                    )
            if not self._gateway_file.exists():
                with open(self._gateway_file, "w", encoding="utf-8") as f:
                    f.write(
                        f"# Stream Trace - Gateway (Processed SSE Output)\n"
                        f"# Thread: {self._thread_id}\n"
                        f"# Started: {datetime.now().isoformat()}\n"
                        f"# Format: JSONL\n\n"
                    )
            self._files_created = True

    def _write_jsonl(self, filepath: Path, record: dict[str, Any]) -> None:
        """Write a JSON record to the specified file."""
        with self._lock:
            self._ensure_files()
            try:
                with open(filepath, "a", encoding="utf-8") as f:
                    f.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
            except Exception:
                # Silently fail to avoid polluting logs
                pass

    def _chunk_to_dict(self, chunk: Any) -> dict[str, Any]:
        """Convert a chunk object to a dict, preserving full content."""
        if chunk is None:
            return {"value": None, "type": "None"}
        if isinstance(chunk, str):
            return {"value": chunk, "type": "str"}
        if isinstance(chunk, bytes):
            try:
                return {"value": chunk.decode("utf-8", errors="replace"), "type": "bytes"}
            except Exception:
                return {"value": f"<binary {len(chunk)} bytes>", "type": "bytes"}
        if isinstance(chunk, dict):
            return {"value": chunk, "type": "dict"}
        # Handle LangChain ChatGenerationChunk and similar.  A
        # ChatGenerationChunk normally has both `.content` and `.message`, so do
        # not use an if/elif chain here: tool-call data is carried by the message
        # even when the generation content is an empty string.
        result: dict[str, Any] = {"type": type(chunk).__name__}
        if hasattr(chunk, "content"):
            content = chunk.content
            result["content"] = content if not isinstance(content, str) else content
        elif hasattr(chunk, "text"):
            result["content"] = str(chunk.text)

        msg = getattr(chunk, "message", None)
        if msg is not None:
            if "content" not in result and hasattr(msg, "content"):
                result["content"] = msg.content

            def _jsonable(value: Any) -> Any:
                if value is None or isinstance(value, (str, int, float, bool)):
                    return value
                if isinstance(value, (dict, list, tuple)):
                    if isinstance(value, dict):
                        return {str(k): _jsonable(v) for k, v in value.items()}
                    return [_jsonable(v) for v in value]
                for method_name in ("model_dump", "dict"):
                    method = getattr(value, method_name, None)
                    if callable(method):
                        try:
                            return _jsonable(method())
                        except Exception:
                            pass
                if hasattr(value, "__dict__"):
                    return {str(k): _jsonable(v) for k, v in vars(value).items() if not str(k).startswith("_")}
                return str(value)

            # LangChain's ToolCallChunk is usually already a dict with `args`.
            # Preserve the original shape instead of assuming OpenAI's nested
            # function.arguments shape; this is the data needed to diagnose the
            # vendor-to-gateway transformation.
            for attr in ("tool_call_chunks", "tool_calls", "invalid_tool_calls", "additional_kwargs"):
                if hasattr(msg, attr):
                    value = getattr(msg, attr)
                    result[attr] = _jsonable(value)

        # Include additional attributes if present
        if hasattr(chunk, "generation_info"):
            result["generation_info"] = chunk.generation_info
        if hasattr(chunk, "id"):
            result["id"] = chunk.id
        if hasattr(chunk, "response_metadata"):
            result["response_metadata"] = chunk.response_metadata
        return result

    def log_vendor_chunk(self, chunk: Any, seq: int = 0, extra: dict[str, Any] | None = None) -> None:
        """Log a vendor (raw LLM) stream chunk with full content."""
        record: dict[str, Any] = {
            "timestamp_ms": int(time.time() * 1000),
            "seq": seq,
            "source": "vendor",
            "chunk": self._chunk_to_dict(chunk),
        }
        if extra:
            record.update(extra)
        self._write_jsonl(self._vendor_file, record)

    def log_gateway_chunk(self, chunk: Any, seq: int = 0, extra: dict[str, Any] | None = None) -> None:
        """Log a gateway (processed SSE) stream chunk with full content."""
        record: dict[str, Any] = {
            "timestamp_ms": int(time.time() * 1000),
            "seq": seq,
            "source": "gateway",
            "chunk": self._chunk_to_dict(chunk),
        }
        if extra:
            record.update(extra)
        self._write_jsonl(self._gateway_file, record)

    def flush(self) -> None:
        """Flush any pending writes (no-op, already write-through)."""
        pass


# Global registry of trace writers (thread-safe)
_trace_registry: dict[str, _StreamTraceWriter] = {}
_trace_registry_lock = threading.Lock()


def _get_trace_writer(thread_id: str) -> _StreamTraceWriter | None:
    """Get or create a trace writer for the given thread_id."""
    if not _is_stream_trace_enabled():
        return None
    with _trace_registry_lock:
        if thread_id not in _trace_registry:
            _trace_registry[thread_id] = _StreamTraceWriter(thread_id)
        return _trace_registry[thread_id]


def get_trace_paths(thread_id: str) -> dict[str, Path] | None:
    """Get the trace file paths for a thread (for reading/verification)."""
    if not _is_stream_trace_enabled():
        return None
    seg = _normalize_thread_id(thread_id)
    root = _stream_trace_root() / seg
    return {
        "vendor": root / "vendor_stream.jsonl",
        "gateway": root / "gateway_stream.jsonl",
    }


class StreamTrace:
    """Main entry point for stream tracing. Use this class for tracing."""

    def __init__(self, thread_id: str) -> None:
        self._thread_id = thread_id
        self._writer = _get_trace_writer(thread_id)
        self._vendor_seq = 0
        self._gateway_seq = 0

    @property
    def is_enabled(self) -> bool:
        """Check if tracing is enabled."""
        return self._writer is not None

    def log_vendor_chunk(self, chunk: Any, extra: dict[str, Any] | None = None) -> None:
        """Log a vendor (raw LLM) stream chunk."""
        if not self._writer:
            return
        seq = self._vendor_seq
        self._vendor_seq += 1
        self._writer.log_vendor_chunk(chunk, seq=seq, extra=extra)

    def log_gateway_chunk(self, chunk: Any, extra: dict[str, Any] | None = None) -> None:
        """Log a gateway (processed SSE) stream chunk."""
        if not self._writer:
            return
        seq = self._gateway_seq
        self._gateway_seq += 1
        self._writer.log_gateway_chunk(chunk, seq=seq, extra=extra)

    def log_vendor_stream_start(self, metadata: dict[str, Any] | None = None) -> None:
        """Log the start of a vendor stream."""
        self.log_vendor_chunk({"type": "stream_start", "metadata": metadata or {}})

    def log_gateway_stream_start(self, metadata: dict[str, Any] | None = None) -> None:
        """Log the start of a gateway stream."""
        self.log_gateway_chunk({"type": "stream_start", "metadata": metadata or {}})

    def log_stream_end(self, stats: dict[str, Any] | None = None) -> None:
        """Log the end of a stream with summary stats."""
        vendor_stats = {"source": "vendor", "total_chunks": self._vendor_seq}
        gateway_stats = {"source": "gateway", "total_chunks": self._gateway_seq}
        if stats:
            vendor_stats.update(stats)
            gateway_stats.update(stats)
        if self._writer:
            self._writer.log_vendor_chunk(
                {"type": "stream_end", **vendor_stats},
                seq=self._vendor_seq,
            )
            self._writer.log_gateway_chunk(
                {"type": "stream_end", **gateway_stats},
                seq=self._gateway_seq,
            )


# Convenience function
def stream_trace(thread_id: str | None) -> StreamTrace:
    """Get a StreamTrace instance for the given thread_id.

    If ``thread_id`` is None/empty, fall back to the contextvar
    populated by :func:`set_current_thread_id`.
    """
    effective = (thread_id or "").strip() or get_current_thread_id()
    return StreamTrace(effective)


def list_trace_threads() -> list[str]:
    """List all thread_ids that have trace data."""
    root = _stream_trace_root()
    if not root.exists():
        return []
    return [d.name for d in root.iterdir() if d.is_dir()]
