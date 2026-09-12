"""Streaming utilities for gateway.

Provides persistent stream writer for task/stream execution output
and background worker for decoupled stream processing.
"""

from .background_worker import (
    StreamBackgroundWorker,
    get_or_create_worker,
    is_worker_running,
)
from .persistent_writer import (
    PersistentStreamWriter,
    # Unified stream storage
    StreamStorage,
    close_all_writers,
    close_writer,
    get_persistent_stream_writer,
    get_stream_output_file_path,
    # Stream status query
    get_stream_status,
    get_task_output_file_path,
    read_stream_output,
    # Backward compatibility
    read_task_output,
    stream_storage,
)

__all__ = [
    "PersistentStreamWriter",
    "get_persistent_stream_writer",
    "read_stream_output",
    "get_stream_output_file_path",
    "read_task_output",  # backward compatibility
    "get_task_output_file_path",  # backward compatibility
    "close_writer",
    "close_all_writers",
    "StreamStorage",
    "stream_storage",
    "get_stream_status",
    "StreamBackgroundWorker",
    "get_or_create_worker",
    "is_worker_running",
]
