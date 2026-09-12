"""String replacement in files — with dry_run, regex, multi-match support, and streaming progress."""

from __future__ import annotations

import difflib
import re
from typing import Annotated

from langchain.tools import InjectedToolCallId, ToolRuntime, tool

from evoflow.tools.host_direct.workspace_path_guard import resolve_tool_path
from evoflow.tools.minimal_schema import REPLACE_TOOL_DESCRIPTION
from evoflow.tools.host_direct.write_stream import (
    capture_stream_writer,
    count_lines,
    emit_write_progress,
)

@tool("replace", description=REPLACE_TOOL_DESCRIPTION, parse_docstring=False)
def str_replace_hd(
    path: str,
    old_string: str,
    new_string: str,
    *,
    dry_run: bool = False,
    regex: bool = False,
    tool_call_id: Annotated[str, InjectedToolCallId],
    runtime: ToolRuntime,
) -> str:
    """Replace text in a file."""
    resolved = resolve_tool_path(path, runtime=runtime, must_exist=True, must_be_file=True)
    if isinstance(resolved, str):
        return resolved

    # Resolve offloaded large-content refs (sent by LargeContentOffloadMiddleware).
    from evoflow.agents.middlewares.large_content_offload_middleware import resolve_offloaded_ref
    resolved_old = resolve_offloaded_ref(old_string)
    if resolved_old is not None:
        old_string = resolved_old
    resolved_new = resolve_offloaded_ref(new_string)
    if resolved_new is not None:
        new_string = resolved_new

    stream_writer = capture_stream_writer()
    tool_name = "replace"

    try:
        p = resolved
        if not p.exists():
            err = f"Error: File not found: {path}"
            emit_write_progress(
                tool_call_id=tool_call_id,
                tool_name=tool_name,
                path=path,
                phase="error",
                message=err,
                stream_writer=stream_writer,
            )
            return err

        content = p.read_text(encoding="utf-8")

        if dry_run:
            return _preview_replace(content, old_string, new_string, path, regex=regex)

        if regex:
            try:
                compiled = re.compile(old_string, re.DOTALL)
            except re.error as e:
                hint = (
                    f"Hint: old_string has invalid regex syntax ({e}). "
                    "If you intended a literal replacement, call with regex=False (the default). "
                    "If you need regex, escape special characters like ()[]{}*+?."
                )
                return f"Error: Replace failed in '{path}': invalid regex pattern.\n{hint}"
            matches = compiled.findall(content)
            new_content = compiled.sub(new_string, content)
            count = len(matches)
        else:
            count = content.count(old_string)
            if count == 0:
                hint = _find_closest_match(content, old_string)
                hint_block = f"\n\n{hint}" if hint else ""
                dash_hint = _dash_mismatch_hint(content, old_string)
                if dash_hint:
                    hint_block = f"{hint_block}\n\n{dash_hint}" if hint_block else f"\n\n{dash_hint}"
                err = (
                    f"Error: String not found in file: {path}\n"
                    f"Searched for: {old_string[:100]}{'...' if len(old_string) > 100 else ''}{hint_block}"
                )
                emit_write_progress(
                    tool_call_id=tool_call_id,
                    tool_name=tool_name,
                    path=path,
                    phase="error",
                    message=err,
                    stream_writer=stream_writer,
                )
                return err
            if count > 1:
                locations = _find_all_locations(content, old_string, path)
                return f"Error: Match appears {count} times in {path}. Provide more context for uniqueness.\n\n{locations}\nTo replace all occurrences, use regex=True with a precise pattern."
            new_content = content.replace(old_string, new_string, 1)
            count = 1

        # Compute diff stats for progress.
        lines_added = max(0, count_lines(new_string) - count_lines(old_string))
        lines_removed = max(0, count_lines(old_string) - count_lines(new_string))

        # Emit writing phase event before disk write.
        # Do NOT re-send old_string/new_string here: args-phase already streamed them.
        # write_stream.encode would treat them as *_delta and the UI would append again.
        emit_write_progress(
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            path=str(p),
            phase="writing",
            bytes_total=len(new_content.encode("utf-8")),
            bytes_written=0,
            lines_added=lines_added,
            lines_removed=lines_removed,
            content_len=len(new_content),
            stream_writer=stream_writer,
        )

        p.write_text(new_content, encoding="utf-8")

        added = len(new_string) - len(old_string)
        match_pos = -1
        if regex:
            _m = re.search(old_string, content, re.DOTALL)
            if _m:
                match_pos = _m.start()
        else:
            match_pos = content.find(old_string)
        match_line = content[:match_pos].count("\n") + 1 if match_pos >= 0 else 0
        loc_hint = f" at line {match_line}" if match_line else ""
        result = f"OK: Replaced {count} occurrence(s) in {path}{loc_hint} ({'+' if added >= 0 else ''}{added} chars)"

        emit_write_progress(
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            path=str(p),
            phase="done",
            bytes_total=len(new_content.encode("utf-8")),
            bytes_written=len(new_content.encode("utf-8")),
            lines_added=lines_added,
            lines_removed=lines_removed,
            content_len=len(new_content),
            message=result,
            stream_writer=stream_writer,
        )

        from evoflow.code_index.hooks import notify_tool_result

        abs_path = str(p)
        notify_tool_result(abs_path, result, runtime=runtime)
        return result

    except PermissionError:
        err = f"Error: Permission denied: {path}"
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
        err = f"Error: Replace failed in '{path}': {e}"
        emit_write_progress(
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            path=path,
            phase="error",
            message=err,
            stream_writer=stream_writer,
        )
        return err


def _normalize_dashes(text: str) -> str:
    return (
        text.replace("\u2014", "-")
        .replace("\u2013", "-")
        .replace("\u2212", "-")
        .replace("\u2010", "-")
        .replace("\u2011", "-")
    )


def _dash_mismatch_hint(content: str, old_string: str) -> str:
    """Hint when only dash/quote variants differ (common replace failure)."""
    if not old_string.strip():
        return ""
    norm_old = _normalize_dashes(old_string)
    if norm_old == old_string and content.count(old_string) > 0:
        return ""
    if _normalize_dashes(content).count(norm_old) == 0:
        return ""
    return (
        "Hint: file text may use a different dash or quote character than old_string "
        "(e.g. em dash — vs hyphen -). Copy the exact characters from Closest match above."
    )


def _find_closest_match(content: str, old_string: str) -> str:
    """Find the text segment most similar to old_string and return it with line context."""
    lines = content.splitlines()
    old_lines = old_string.splitlines()
    if not old_lines or not lines:
        return ""

    matcher = difflib.SequenceMatcher(None, content, old_string)
    match = matcher.find_longest_match(0, len(content), 0, len(old_string))

    if match.size > 10:
        pos = 0
        match_line = 0
        for i, line in enumerate(lines):
            if pos + len(line) >= match.a:
                match_line = i
                break
            pos += len(line) + 1
        start = max(0, match_line - 3)
        end = min(len(lines), match_line + len(old_lines) + 3)
        context = "\n".join(f"{start + j + 1}: {lines[start + j]}" for j in range(end - start))
        return f"Closest match at line {match_line + 1} ({match.size}/{len(old_string)} chars similar):\n{context}"

    first_old = old_lines[0].strip()
    if first_old and len(first_old) > 3:
        best_ratio = 0.0
        best_line = 0
        for i, line in enumerate(lines):
            ratio = difflib.SequenceMatcher(None, line.strip(), first_old).ratio()
            if ratio > best_ratio:
                best_ratio = ratio
                best_line = i
        if best_ratio > 0.3:
            start = max(0, best_line - 3)
            end = min(len(lines), best_line + len(old_lines) + 3)
            context = "\n".join(f"{start + j + 1}: {lines[start + j]}" for j in range(end - start))
            return f"Closest match at line {best_line + 1} (similarity {best_ratio:.0%}):\n{context}"

    return ""


def _preview_replace(content: str, old: str, new: str, path: str, *, regex: bool = False) -> str:
    """Generate a dry-run preview of changes."""
    if regex:
        matches = list(re.finditer(old, content, re.DOTALL))
        if not matches:
            return f"Dry run: No matches found for pattern in {path}"
        lines = [f"Dry Run Preview for: {path}", f"Pattern would match {len(matches)} location(s):"]
        for i, m in enumerate(matches[:5]):
            start = m.start()
            snippet = content[max(0, start - 20) : start + len(m.group()) + 20].replace("\n", "\\n")
            lines.append(f"  [{i}] ...{snippet}...")
        lines.append("\nRun again with dry_run=False to apply.")
        return "\n".join(lines)

    count = content.count(old)
    if count == 0:
        return f"Dry run: String not found in {path}"

    lines = [
        "--- Dry Run Preview ---",
        f"File: {path}",
        "",
        f"<<<< OLD ({len(old.splitlines())} lines)",
    ]
    for line in old.splitlines():
        lines.append(f"  {line}")
    lines.append(f">>>> NEW ({len(new.splitlines())} lines)")
    for line in new.splitlines():
        lines.append(f"  {line}")
    lines.append("---")
    lines.append(f"Would {'replace all ' if count > 1 else 'change'} {count} occurrence(s). Run with dry_run=False to apply.")
    return "\n".join(lines)


def _find_all_locations(content: str, target: str, path: str) -> str:
    """Find all locations where target appears, with context."""
    lines = content.splitlines()
    locations = []
    for i, line in enumerate(lines):
        idx = 0
        while True:
            pos = line.find(target, idx)
            if pos == -1:
                break
            locations.append((i + 1, pos, line.strip()))
            idx = pos + 1

    result = ["Match locations:"]
    for line_no, col, text in locations[:5]:
        preview = text[:80] + ("..." if len(text) > 80 else "")
        result.append(f"  Line {line_no}: {preview}")
    if len(locations) > 5:
        result.append(f"  ... and {len(locations) - 5} more")
    return "\n".join(result)
