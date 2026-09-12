"""Batch regex pattern replacement across multiple files."""

from __future__ import annotations

import re

from langchain.tools import ToolRuntime, tool

from evoflow.tools.host_direct.workspace_path_guard import resolve_tool_path

_PATTERN_FIX_DESCRIPTION = """Apply a single regex pattern replacement across multiple files simultaneously.

Use this when the **same** code pattern needs to be fixed across many files (e.g., changing a
deprecated API call, fixing a common bug pattern across middleware files). For different
replacements per file, use ``worker`` batch tasks instead. For single-file precise
replacement, use ``replace``.

Args:
    files: Comma-separated list of file paths to process (max 50).
    pattern: Regex pattern to search for in each file.
    replacement: Replacement string (supports backreferences like \\1, \\g<name>).
    dry_run: If True, preview matches without modifying files. Default False.

Returns per-file match counts and success/failure status. Files with 0 matches are reported
but not modified.
"""

_MAX_FILES = 50
_MAX_FILE_SIZE = 1_048_576  # 1 MB


@tool("pattern_fix", description=_PATTERN_FIX_DESCRIPTION, parse_docstring=True)
def pattern_fix_tool(
    files: str,
    pattern: str,
    replacement: str,
    *,
    dry_run: bool = False,
    runtime: ToolRuntime,
) -> str:
    """Batch regex replacement across multiple files.

    Args:
        files: Comma-separated file paths (max 50).
        pattern: Regex pattern to search for.
        replacement: Replacement string (supports backreferences).
        dry_run: If True, only preview matches without writing.
    """
    try:
        regex = re.compile(pattern)
    except re.error as exc:
        return f"Error: invalid regex pattern: {exc}"

    raw_paths = [p.strip() for p in str(files or "").split(",") if p.strip()]
    if not raw_paths:
        return "Error: no file paths provided. Pass comma-separated paths."
    if len(raw_paths) > _MAX_FILES:
        return f"Error: too many files ({len(raw_paths)}). Maximum {_MAX_FILES} files per call."

    tid = ""
    if runtime is not None and getattr(runtime, "context", None):
        tid = str(runtime.context.get("thread_id") or "").strip()

    results: list[str] = []
    total_matches = 0
    total_modified = 0

    for raw_path in raw_paths:
        resolved = resolve_tool_path(
            raw_path,
            runtime=runtime,
            must_exist=True,
            must_be_file=True,
        )
        if isinstance(resolved, str):
            results.append(f"  \u2717 {raw_path}: {resolved}")
            continue

        fpath = resolved
        try:
            size = fpath.stat().st_size
        except OSError as exc:
            results.append(f"  \u2717 {raw_path}: stat error: {exc}")
            continue
        if size > _MAX_FILE_SIZE:
            results.append(f"  \u2717 {raw_path}: file too large ({size // 1024}KB > {_MAX_FILE_SIZE // 1024}KB)")
            continue

        try:
            content = fpath.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            try:
                content = fpath.read_text(encoding="latin-1")
            except Exception as exc:
                results.append(f"  \u2717 {raw_path}: read error: {exc}")
                continue
        except Exception as exc:
            results.append(f"  \u2717 {raw_path}: read error: {exc}")
            continue

        matches = list(regex.finditer(content))
        if not matches:
            results.append(f"  \u25cb {raw_path}: 0 matches")
            continue

        if dry_run:
            results.append(f"  \u25cb {raw_path}: {len(matches)} match(es) [dry-run]")
            for m in matches[:3]:
                line_no = content[: m.start()].count("\n") + 1
                snippet = m.group(0)[:80].replace("\n", " ")
                results.append(f"      L{line_no}: {snippet}")
            if len(matches) > 3:
                results.append(f"      ... and {len(matches) - 3} more")
            total_matches += len(matches)
        else:
            new_content = regex.sub(replacement, content)
            try:
                fpath.write_text(new_content, encoding="utf-8")
                results.append(f"  \u2713 {raw_path}: {len(matches)} match(es) replaced")
                total_modified += 1
                total_matches += len(matches)
                # Register write for mission_state tracking (\u4f18\u53161)
                if tid:
                    try:
                        from evoflow.context.working_memory import register_write

                        register_write(tid, str(fpath), "pattern_fix")
                    except Exception:
                        pass
            except Exception as exc:
                results.append(f"  \u2717 {raw_path}: write error: {exc}")

    mode = "DRY RUN" if dry_run else "APPLIED"
    header = f"pattern_fix [{mode}]: {len(raw_paths)} file(s), pattern={pattern!r}\n"
    if not dry_run:
        header += f"  Total: {total_matches} match(es) replaced across {total_modified} file(s)\n"
    else:
        header += f"  Total: {total_matches} match(es) found across {len(raw_paths)} file(s)\n"
    header += "=" * 60
    return header + "\n" + "\n".join(results)
