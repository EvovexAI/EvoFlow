"""Write file — direct filesystem access with streaming progress events."""

from __future__ import annotations

import shutil
from typing import Annotated

from langchain.tools import InjectedToolCallId, ToolRuntime, tool

from evoflow.tools.host_direct.workspace_path_guard import format_tool_path_label, resolve_tool_path
from evoflow.tools.minimal_schema import WRITE_TOOL_DESCRIPTION
from evoflow.tools.host_direct.write_stream import (
    capture_stream_writer,
    count_lines,
    emit_write_progress,
)

# Chunk size for incremental writing + progress events (bytes).
_WRITE_CHUNK_BYTES = 8 * 1024
# Emit a progress event at most every N bytes (keeps SSE frame volume reasonable
# while still giving visible "writing..." feedback on small files <32KB).
_PROGRESS_EMIT_INTERVAL_BYTES = 4 * 1024


@tool("write", description=WRITE_TOOL_DESCRIPTION, parse_docstring=False)
def write_file_hd(
    path: str,
    content: str,
    *,
    append: bool = False,
    create_line: bool = True,
    backup: bool = False,
    tool_call_id: Annotated[str, InjectedToolCallId],
    runtime: ToolRuntime,
) -> str:
    """Write content to a file on the local filesystem."""
    resolved = resolve_tool_path(path, runtime=runtime)
    if isinstance(resolved, str):
        return resolved

    # Resolve offloaded large-content refs (sent by LargeContentOffloadMiddleware).
    # If ``content`` is a sentinel pointing to a temp file, read the real content from disk.
    from evoflow.agents.middlewares.large_content_offload_middleware import resolve_offloaded_ref
    resolved_content = resolve_offloaded_ref(content)
    if resolved_content is not None:
        content = resolved_content

    # Capture LangGraph custom-event writer once (sync tool, cheap).
    stream_writer = capture_stream_writer()
    tool_name = "write"

    try:
        p = resolved

        # Auto-create parent directories
        p.parent.mkdir(parents=True, exist_ok=True)

        # Backup existing file before overwrite
        if backup and p.exists() and not append:
            bak_path = p.with_suffix(p.suffix + ".bak")
            shutil.copy2(p, bak_path)

        # Ensure trailing newline
        final_content = content
        if create_line and final_content and not final_content.endswith("\n"):
            final_content += "\n"

        encoded = final_content.encode("utf-8")
        total_bytes = len(encoded)
        total_lines = count_lines(final_content)
        label = format_tool_path_label(p, runtime=runtime) or path

        # Emit "writing started" event immediately so UI transitions from
        # "args-streaming" to "disk-writing" (bytes-only — content already streamed
        # verbatim from the vendor's TOOL_CALL_ARGS deltas during the args phase,
        # no need to re-send it).
        emit_write_progress(
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            path=label,
            phase="writing",
            bytes_total=total_bytes,
            bytes_written=0,
            lines_added=total_lines,
            content_len=total_bytes,
            stream_writer=stream_writer,
        )

        mode = "ab" if append else "wb"
        written = 0
        next_emit_at = _PROGRESS_EMIT_INTERVAL_BYTES

        with open(p, mode) as f:
            for offset in range(0, total_bytes, _WRITE_CHUNK_BYTES):
                chunk = encoded[offset : offset + _WRITE_CHUNK_BYTES]
                f.write(chunk)
                f.flush()
                written += len(chunk)

                if written >= next_emit_at or written == total_bytes:
                    emit_write_progress(
                        tool_call_id=tool_call_id,
                        tool_name=tool_name,
                        path=label,
                        phase="writing",
                        bytes_total=total_bytes,
                        bytes_written=written,
                        lines_added=total_lines,
                        content_len=total_bytes,
                        stream_writer=stream_writer,
                    )
                    next_emit_at = written + _PROGRESS_EMIT_INTERVAL_BYTES

        action = "appended to" if append else "wrote"
        result = f"OK: {action} {total_bytes} bytes to {label}"

        # Final "done" event (carries no content_delta; modal already has it from args stream).
        emit_write_progress(
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            path=label,
            phase="done",
            bytes_total=total_bytes,
            bytes_written=total_bytes,
            lines_added=total_lines,
            content_len=total_bytes,
            message=result,
            stream_writer=stream_writer,
        )

        from evoflow.code_index.hooks import notify_tool_result

        notify_tool_result(path, result, runtime=runtime)
        return result

    except PermissionError:
        err = f"Error: Permission denied writing to: {path}"
        emit_write_progress(
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            path=path,
            phase="error",
            message=err,
            stream_writer=stream_writer,
        )
        return err
    except IsADirectoryError:
        err = f"Error: Path is a directory: {path}"
        emit_write_progress(
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            path=path,
            phase="error",
            message=err,
            stream_writer=stream_writer,
        )
        return err
    except Exception as e:
        err = f"Error: Failed to write file '{path}': {e}"
        emit_write_progress(
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            path=path,
            phase="error",
            message=err,
            stream_writer=stream_writer,
        )
        return err
