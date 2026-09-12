"""Read linter/diagnostic output for Python, JavaScript, TypeScript, and Java."""

from __future__ import annotations

import re as _re_mod
import time as _time

from langchain.tools import ToolRuntime, tool

from evoflow.tools.code_lint import (
    LINTABLE_EXTENSIONS_LABEL,
    lint_path,
    validate_read_lints_target,
)
from evoflow.tools.host_direct.workspace_path_guard import resolve_tool_path
from evoflow.tools.minimal_schema import READ_LINTS_DESCRIPTION


def _get_changed_lines(path) -> set[int] | None:
    """Get changed line numbers from git diff for a file (unstaged + staged vs HEAD)."""
    import re as _re
    import subprocess
    try:
        from evoflow.utils.subprocess_platform import subprocess_hide_window_kwargs, subprocess_text_io_kwargs

        result = subprocess.run(
            ["git", "diff", "HEAD", "--unified=0", "--", str(path)],
            capture_output=True, text=True, timeout=10,
            cwd=str(path.parent) if hasattr(path, "parent") else None,
            **subprocess_text_io_kwargs(),
            **subprocess_hide_window_kwargs(),
        )
        if result.returncode != 0:
            return None
        lines: set[int] = set()
        for line in result.stdout.splitlines():
            if line.startswith("@@"):
                m = _re.search(r'\+(\d+)(?:,(\d+))?', line)
                if m:
                    start = int(m.group(1))
                    count = int(m.group(2) or "1")
                    for i in range(start, start + count):
                        lines.add(i)
        return lines if lines else None
    except Exception:
        return None


# --- Batch audit detection (优化6) ---
_RECENT_LINT_CALLS: dict[str, list[float]] = {}
_LINT_BATCH_WINDOW_SEC = 60.0
_LINT_BATCH_THRESHOLD = 3


def _record_lint_call(thread_id: str) -> int:
    """Track recent read_lints calls per thread; return count in the current window."""
    tid = str(thread_id or "").strip()
    if not tid:
        return 0
    now = _time.time()
    calls = _RECENT_LINT_CALLS.get(tid, [])
    calls = [t for t in calls if now - t < _LINT_BATCH_WINDOW_SEC]
    calls.append(now)
    _RECENT_LINT_CALLS[tid] = calls
    return len(calls)


def _extract_line_number_from_lint(line: str) -> int | None:
    """Extract line number from a lint output line, supporting both ruff and eslint formats.

    - Ruff:   ``path/to/file.py:42:5: E501 message``  (path may contain ``:`` on Windows)
    - ESLint: ``    67:42  warning  message``         (indented, no path prefix)
    """
    import re as _re
    # ESLint format: "    67:42  warning  message" (indented, no path prefix)
    m = _re.match(r'^\s*(\d+):\d+', line)
    if m:
        return int(m.group(1))
    # Ruff format: "path:line:col: message" (path may contain colons on Windows)
    m = _re.search(r':(\d+):\d+', line)
    if m:
        return int(m.group(1))
    return None


def _filter_lint_by_changed_lines(lint_output: str, changed: set[int]) -> str:
    """Filter lint output to only show issues on changed lines."""
    kept: list[str] = []
    dropped = 0
    for line in lint_output.splitlines():
        line_no = _extract_line_number_from_lint(line)
        if line_no is not None:
            if line_no in changed:
                kept.append(line)
            else:
                dropped += 1
            continue
        kept.append(line)
    if dropped:
        kept.append(f"({dropped} pre-existing issue(s) on unchanged lines hidden — pass changed_only=False to see all)")
    return "\n".join(kept)


# --- Debug log lifecycle detection (优化8) ---
# Patterns that are unambiguously temporary debug code — flagged in any context.
_DEBUG_LOG_PATTERNS: list[tuple[_re_mod.Pattern, str]] = [
    (_re_mod.compile(r'\bbreakpoint\s*\('), 'breakpoint()'),
    (_re_mod.compile(r'\bpdb\.set_trace\s*\('), 'pdb.set_trace()'),
    (_re_mod.compile(r'\bdebugger\s*;'), 'debugger statement'),
    (_re_mod.compile(r'\be\.printStackTrace\s*\('), 'printStackTrace()'),
    (_re_mod.compile(r'#\s*TODO[^\n]*(?:debug|remove|temp)', _re_mod.IGNORECASE), 'debug TODO marker'),
    (_re_mod.compile(r'//\s*TODO[^\n]*(?:debug|remove|temp)', _re_mod.IGNORECASE), 'debug TODO marker'),
    (_re_mod.compile(r'#\s*TEMP\s+DEBUG', _re_mod.IGNORECASE), 'TEMP DEBUG marker'),
    (_re_mod.compile(r'logger\.debug\s*\(\s*["\'][^"\']*DEBUG', _re_mod.IGNORECASE), 'debug log with DEBUG marker'),
]

# print()/console.log() are only flagged when the call content looks like debug output.
# This avoids false positives on legitimate print() usage (CLI output, scripts, etc.).
_DEBUG_KEYWORDS_RE = _re_mod.compile(
    r'(?:DEBUG|debug|test|temp|trace|dump|here|xxx|fixme|todo|tmp|inspect|verify|hack|临时|调试|测试)',
    _re_mod.IGNORECASE,
)
_CONDITIONAL_DEBUG_PATTERNS: list[tuple[_re_mod.Pattern, str]] = [
    (_re_mod.compile(r'\bprint\s*\('), 'print() with debug content'),
    (_re_mod.compile(r'\bconsole\.log\s*\('), 'console.log() with debug content'),
]

# Lines that define regex patterns (not actual debug code) — skipped to avoid self-reference.
_PATTERN_DEF_RE = _re_mod.compile(r'compile\s*\(|_DEBUG_LOG_PATTERNS|_CONDITIONAL_DEBUG|_DEBUG_KEYWORDS')


def _is_comment_only(line: str) -> bool:
    """True when the line is a pure comment with no executable code."""
    stripped = line.strip()
    return stripped.startswith('#') or stripped.startswith('//')


def _scan_debug_logs(path) -> str:
    """Scan for temporary debug log patterns and return warning text (优化8).

    Two tiers of patterns:
    - _DEBUG_LOG_PATTERNS: unambiguous debug constructs (breakpoint, pdb, debugger, etc.)
      — always flagged, even inside comments (e.g. ``# TODO: remove debug``).
    - _CONDITIONAL_DEBUG_PATTERNS: print()/console.log() — only flagged when the
      call argument contains debug-like keywords (DEBUG, test, temp, trace, …).
      Pure-comment lines are skipped for these to avoid noise.

    Lines inside triple-quoted strings (docstrings, multi-line assignments) are
    skipped to avoid false positives from text that merely mentions debug patterns.
    """
    try:
        content = path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return ""
    warnings: list[str] = []
    in_triple = False
    triple_marker = ""
    for i, line in enumerate(content.splitlines(), 1):
        # Track triple-quoted string blocks — skip content inside them
        if in_triple:
            if triple_marker in line:
                count = line.count(triple_marker)
                if count % 2 == 1:
                    in_triple = False
                    triple_marker = ""
            continue
        # Check if this line opens a triple-quoted string
        dq = line.count('"""')
        sq = line.count("'''")
        if dq > 0:
            if dq % 2 == 1:
                in_triple = True
                triple_marker = '"""'
            continue
        if sq > 0:
            if sq % 2 == 1:
                in_triple = True
                triple_marker = "'''"
            continue
        # Skip regex pattern-definition lines (avoids self-reference false positives)
        if _PATTERN_DEF_RE.search(line):
            continue
        matched = False
        # Tier 1: always-flag patterns
        for pattern, desc in _DEBUG_LOG_PATTERNS:
            if pattern.search(line):
                snippet = line.strip()[:100]
                warnings.append(f"  L{i}: {desc} — `{snippet}`")
                matched = True
                break
        if matched:
            continue
        # Tier 2: conditional patterns — skip pure comments, require debug keywords
        if _is_comment_only(line):
            continue
        for pattern, desc in _CONDITIONAL_DEBUG_PATTERNS:
            if pattern.search(line) and _DEBUG_KEYWORDS_RE.search(line):
                snippet = line.strip()[:100]
                warnings.append(f"  L{i}: {desc} — `{snippet}`")
                break
    if not warnings:
        return ""
    header = f"\n\n[debug-log-warning] {len(warnings)} temporary debug pattern(s) found:"
    footer = "\nConsider removing these before committing."
    body = "\n".join(warnings[:20])
    if len(warnings) > 20:
        body += f"\n  ... and {len(warnings) - 20} more"
    return header + "\n" + body + footer


@tool("read_lints", description=READ_LINTS_DESCRIPTION, parse_docstring=False)
def read_lints_tool(
    paths: str,
    *,
    changed_only: bool = True,
    runtime: ToolRuntime,
) -> str:
    """Read linter/diagnostic errors for one source file."""
    if not paths or not str(paths).strip():
        return (
            "Error: read_lints requires a single file path "
            f"(Python / JS / TS / Java only: {LINTABLE_EXTENSIONS_LABEL}). "
            "Directory scans are not supported."
        )

    resolved = resolve_tool_path(
        str(paths).strip(),
        runtime=runtime,
        must_exist=True,
        must_be_file=True,
    )
    if isinstance(resolved, str):
        return resolved

    reject = validate_read_lints_target(resolved)
    if reject:
        return reject

    body = lint_path(resolved)
    if changed_only and "No issues found" not in body:
        changed = _get_changed_lines(resolved)
        if changed is not None:
            body = _filter_lint_by_changed_lines(body, changed)
        else:
            body += "\n\n(changed_only=True but git diff unavailable — showing all issues)"
    # Detect batch audit pattern — suggest changed_only=false after multiple calls
    tid = ""
    if runtime is not None and getattr(runtime, "context", None):
        tid = str(runtime.context.get("thread_id") or "").strip()
    call_count = _record_lint_call(tid)
    batch_hint = ""
    if call_count >= _LINT_BATCH_THRESHOLD and changed_only:
        batch_hint = (
            f"\n\n[hint] {call_count} read_lints calls in the last {_LINT_BATCH_WINDOW_SEC:.0f}s — "
            "for a full audit pass, consider changed_only=False to see all issues."
        )
    debug_warning = _scan_debug_logs(resolved)
    header = f"Linter results: {resolved.resolve()}\n{'=' * 60}\n"
    return header + body + batch_hint + debug_warning
