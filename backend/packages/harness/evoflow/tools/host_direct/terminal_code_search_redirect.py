"""Intercept shell code-search commands in ``terminal`` and redirect to fast in-process search."""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

from evoflow.tools.arg_coerce import split_pipe_terms


def _code_search_redirect_enabled() -> bool:
    return (os.getenv("TERMINAL_BLOCK_CODE_SEARCH", "0") or "0").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


_QUOTED = r'"(?:[^"\\]|\\.)*"|\'(?:[^\'\\]|\\.)*\''

_CODE_SEARCH_RE = re.compile(
    r"(?i)(?:"
    r"\bselect-string\b|\bsls\b|"
    r"\bfindstr\b|"
    r"\bgrep\b|\brg\b|\bripgrep\b|\bag\b|\back\b|"
    r"\bfind\b\s+\.\s+-"
    r")"
)

# ``Get-ChildItem -Recurse`` alone is used for disk/folder sizing — not code search.
_GCI_RECURSE_CODE_SEARCH_RE = re.compile(
    r"(?i)\b(?:get-childitem|gci)\b[^\n\r|;]*\s+-recurse\b"
)

# Filesystem metrics / inventory — allow even when -Recurse appears in the pipeline.
_NON_CODE_SEARCH_RE = re.compile(
    r"(?i)(?:"
    r"\bmeasure-object\b|"
    r"\b(?:total|sum|average|maximum|minimum)\s+(?:size|length|bytes)\b|"
    r"\b(?:size|length)\s*[-/](?:sum|total)\b|"
    r"\b(?:sizegb|sizemb|sizekb|freespace|usedspace|disk\s+usage|folder\s+size)\b|"
    r"\bget-psdrive\b|\bget-volume\b|\bget-wmiobject\b.*\bwin32_logicaldisk\b"
    r")"
)

_REDIRECT_BANNER = (
    "[terminal → code search] Shell 代码搜索已转为内置检索（秒级），避免 PowerShell/grep 冷启动超时。\n"
    "下次请直接用 search_code_index(query=\"...\")、rg(pattern=\"...\") 或 read_file，勿再用 terminal 的 Select-String/grep/rg。\n\n"
)


def _gci_recurse_is_code_search(command: str) -> bool:
    """``Get-ChildItem -Recurse`` only when paired with source-file filters (not disk sizing)."""
    cmd = str(command or "")
    if not _GCI_RECURSE_CODE_SEARCH_RE.search(cmd):
        return False
    if _NON_CODE_SEARCH_RE.search(cmd):
        return False
    if re.search(
        r"(?i)(?:-include|-filter|-file)\s+(?:[^\s|;]+,)*[^\s|;]*\."
        r"(?:py|ts|tsx|js|jsx|go|rs|java|kt|cs|cpp|c|h|hpp|rb|php|swift|vue|sql|md|yaml|yml|json|toml|xml|html|css|scss|sh|ps1)\b",
        cmd,
    ):
        return True
    if re.search(r"(?i)\|\s*(?:select-string|sls|findstr|where-object\s+.*\.(?:py|ts|tsx|js|go|rs|java|cs)\b)", cmd):
        return True
    return False


def is_code_search_terminal_command(command: str) -> bool:
    cmd = str(command or "")
    if _NON_CODE_SEARCH_RE.search(cmd):
        return False
    if _CODE_SEARCH_RE.search(cmd):
        return True
    return _gci_recurse_is_code_search(cmd)


def _unquote(raw: str) -> str:
    s = str(raw or "").strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in "\"'":
        return s[1:-1]
    return s


def _flag_value(command: str, flag: str) -> str | None:
    m = re.search(rf"(?i){re.escape(flag)}\s+(?P<val>{_QUOTED}|[^\s|;]+)", command)
    if not m:
        return None
    return _unquote(m.group("val"))


def _match_limit(command: str) -> int:
    m = re.search(r"(?i)select-object\s+-first\s+(\d+)", command)
    if m:
        try:
            return max(1, min(100, int(m.group(1))))
        except ValueError:
            pass
    m = re.search(r"(?i)\bhead\s+-n\s+(\d+)", command)
    if m:
        try:
            return max(1, min(100, int(m.group(1))))
        except ValueError:
            pass
    return 20


def _parse_select_string(command: str) -> tuple[str, list[str]] | None:
    if not re.search(r"(?i)\bselect-string\b|\bsls\b", command):
        return None
    pattern = _flag_value(command, "-Pattern")
    if not pattern:
        return None
    path_raw = _flag_value(command, "-Path")
    paths: list[str] = []
    if path_raw:
        paths = [p.strip() for p in re.split(r"[,;]", path_raw) if p.strip()]
    return pattern, paths


def _parse_grep_like(command: str) -> tuple[str, list[str]] | None:
    if re.search(r"(?i)\bselect-string\b|\bsls\b|\bfindstr\b", command):
        return None
    if not re.search(r"(?i)\b(?:grep|rg|ripgrep|ag|ack)\b", command):
        return None
    # rg pattern [path...]
    m = re.match(
        rf"(?i)\s*(?:\S+\\)?(?:rg|ripgrep)\s+(?:-[a-zA-Z]+\s+)*"
        rf"(?P<pattern>{_QUOTED}|[^\s]+)\s*(?P<rest>.*)$",
        command.strip(),
    )
    if m:
        pattern = _unquote(m.group("pattern"))
        rest = (m.group("rest") or "").strip()
        paths = [_unquote(x) for x in re.findall(_QUOTED, rest)] or (
            [x for x in rest.split() if x and not x.startswith("-")]
        )
        return pattern, paths
    m = re.search(
        rf"(?i)\bgrep\s+(?:-[a-zA-Z]+\s+)*"
        rf"(?P<pattern>{_QUOTED}|[^\s]+)\s*(?P<rest>.*)$",
        command.strip(),
    )
    if m:
        pattern = _unquote(m.group("pattern"))
        rest = (m.group("rest") or "").strip()
        paths = [_unquote(x) for x in re.findall(_QUOTED, rest)] or (
            [x for x in rest.split() if x and not x.startswith("-")]
        )
        return pattern, paths
    return None


def _parse_findstr(command: str) -> tuple[str, list[str]] | None:
    if not re.search(r"(?i)\bfindstr\b", command):
        return None
    m = re.search(
        rf"(?i)\bfindstr\b(?:\s+/[a-z]+)*\s+(?P<pattern>{_QUOTED}|[^\s]+)\s*(?P<rest>.*)$",
        command.strip(),
    )
    if not m:
        return None
    pattern = _unquote(m.group("pattern"))
    rest = (m.group("rest") or "").strip()
    paths = [_unquote(x) for x in re.findall(_QUOTED, rest)] or (
        [x for x in rest.split() if x and not x.startswith("/")]
    )
    return pattern, paths


def parse_code_search_command(command: str) -> tuple[str, list[str]] | None:
    for parser in (_parse_select_string, _parse_findstr, _parse_grep_like):
        parsed = parser(command)
        if parsed:
            return parsed
    return None


def _index_hint_from_pattern(pattern: str) -> str:
    p = str(pattern or "").strip()
    if "|" in p and not re.search(r"[\\.*+?^\[\](){}$]", p.replace("|", "")):
        return p
    if re.search(r"[\\.*+?^\[\](){}$]", p):
        tokens = re.findall(r"[A-Za-z_][A-Za-z0-9_]{2,}", p)
        if len(tokens) >= 2:
            return "|".join(tokens[:8])
        if tokens:
            return tokens[0]
    return p[:120] or "keyword"


def _fast_search_single_file(path: Path, pattern: str, *, max_matches: int) -> str:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        return f"Error: cannot read {path}: {e}"
    try:
        rx = re.compile(pattern, re.IGNORECASE)
    except re.error:
        terms = split_pipe_terms(pattern) if "|" in pattern else [pattern]
        lines_out: list[str] = []
        for i, line in enumerate(text.splitlines(), 1):
            hay = line.casefold()
            if any(t.casefold() in hay for t in terms if t):
                lines_out.append(f"{path}:{i}:{line.rstrip()}")
                if len(lines_out) >= max_matches:
                    break
        if not lines_out:
            return f"No matches for '{pattern}' in {path}"
        return "\n".join(lines_out)

    lines_out = []
    for i, line in enumerate(text.splitlines(), 1):
        if rx.search(line):
            lines_out.append(f"{path}:{i}:{line.rstrip()}")
            if len(lines_out) >= max_matches:
                break
    if not lines_out:
        return f"No matches for '{pattern}' in {path}"
    return "\n".join(lines_out)


def _redirect_to_code_index(
    *,
    pattern: str,
    workspace_root: str,
    thread_id: str | None,
    limit: int,
) -> str:
    from evoflow.code_index.format_results import format_search_index_body
    from evoflow.code_index.store import index_status, merge_search_queries, search_index

    hint = _index_hint_from_pattern(pattern)
    parts = split_pipe_terms(hint) if "|" in hint else [hint]
    primary = parts[0] if parts else hint
    extra = parts[1:] if len(parts) > 1 else []
    label, _explicit = merge_search_queries(primary, queries=extra or None)
    data = search_index(
        workspace_root,
        primary,
        queries=extra or None,
        thread_id=thread_id,
        limit=limit,
    )
    hits = data.get("hits") or []
    symbols = data.get("symbols") or []
    if not hits and not symbols:
        st = index_status(workspace_root=workspace_root, thread_id=thread_id)
        if st.get("building"):
            return _REDIRECT_BANNER + f"No index hits for '{label}' yet — workspace index is still building."
        return _REDIRECT_BANNER + f"No index hits for '{label}'. Try search_code_index with pipe synonyms or read_file on likely paths."
    body = format_search_index_body(data, label=label, limit=limit)
    return _REDIRECT_BANNER + body


def try_terminal_code_search_redirect(*, command: str, runtime: Any) -> str | None:
    """Return redirect message if *command* is shell code search and a fast path exists; else None.

    Never hard-blocks: when redirect is unavailable the caller runs the shell command as-is.
    Opt-in via ``TERMINAL_BLOCK_CODE_SEARCH=1`` (default off).
    """
    if not _code_search_redirect_enabled():
        return None
    cmd = str(command or "").strip()
    if not cmd or not is_code_search_terminal_command(cmd):
        return None

    from evoflow.tools.host_direct.workspace_context import resolve_tool_workspace_root

    root, thread_id = resolve_tool_workspace_root(runtime=runtime)
    parsed = parse_code_search_command(cmd)
    limit = _match_limit(cmd)

    if parsed:
        pattern, paths = parsed
        file_paths = [Path(p) for p in paths if p]
        if len(file_paths) == 1 and file_paths[0].is_file():
            body = _fast_search_single_file(file_paths[0], pattern, max_matches=limit)
            return _REDIRECT_BANNER + body
        if root:
            return _redirect_to_code_index(
                pattern=pattern,
                workspace_root=root,
                thread_id=thread_id,
                limit=max(limit, 15),
            )

    if root and parsed:
        return _redirect_to_code_index(
            pattern=parsed[0],
            workspace_root=root,
            thread_id=thread_id,
            limit=max(limit, 15),
        )
    return None
