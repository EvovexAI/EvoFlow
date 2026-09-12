"""Content search: FTS index candidates first, then regex on disk (fallback tree walk)."""

from __future__ import annotations

import atexit
import fnmatch
import re
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeoutError
from pathlib import Path
from typing import Any, Literal

from langchain.tools import ToolRuntime, tool

from evoflow.tools.arg_coerce import split_pipe_terms

_SKIP_DIRS = {
    ".git",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    ".idea",
    ".vscode",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".tox",
    ".eggs",
    ".mypy_cache",
    "site-packages",
}
_MAX_FILE_SIZE = 1_000_000  # 1MB — skip larger files
_MAX_WALL_SECONDS = 45.0
_MAX_FILES_SCAN = 8000
_INDEX_CANDIDATE_CAP = 400

_SEARCH_CONTENT_POOL = ThreadPoolExecutor(max_workers=2, thread_name_prefix="search-content")
atexit.register(lambda: _SEARCH_CONTENT_POOL.shutdown(wait=False, cancel_futures=True))

# Regex constructs that FTS cannot represent — need line-level regex on disk.
_REGEX_COMPLEX_RE = re.compile(r"(?:\\[wWdDsSbBnrtf0-9]|\.(?:\*|\?|\{|\w)|\(\?|[$^]|\[(?:\^)?|{|\}|\+|\*|\?)")


@tool("search_content", parse_docstring=True)
def search_content_hd(
    pattern: str,
    *,
    context_before: int = 0,
    context_after: int = 0,
    case_sensitive: bool = False,
    output_mode: Literal["content", "count", "files_with_matches"] = "content",
    glob_pattern: str | None = None,
    max_results: int = 50,
    max_depth: int = 6,
    runtime: ToolRuntime,
) -> str:
    """**Secondary** workspace search: one **Python regex** over file bodies (index may narrow files first).

    **Do NOT use this like ``search_code_index``**
    - ``|`` here means **regex alternation**, not synonym lists. ``dalle|DALL·E|image/generate`` requires those **exact substrings** in source (``dalle`` does **not** match ``dall-e``).
    - Finding classes, APIs, modules, or ``foo/bar`` path strings → use ``search_code_index`` with ``query="dall-e|dalle|images/generations"`` (pipe = synonyms there).
    - **Always try ``search_code_index`` first** for code/API discovery; use this only after index misses or for log lines / error strings / real regex.

    **When to use**
    - Known regex: ``raise ValueError``, ``TODO\\(.*fixme``, ``https?://``.
    - Escape regex metacharacters in literals: API path ``images/generations`` → ``images/generations`` (``/`` is fine) but ``config\\.yaml`` if you need a dot literally elsewhere.
    - Optional ``glob_pattern`` (e.g. ``*.py``) to limit scope.

    Args:
        pattern: **Single Python regex** (``|`` = OR branches, not keyword synonyms). Not for multi-keyword code search.
        context_before: Lines before each match (like rg -B). Default 0.
        context_after: Lines after each match (like rg -A). Default 0.
        case_sensitive: Case-sensitive search? Default False.
        output_mode: ``content`` | ``count`` | ``files_with_matches``.
        glob_pattern: Filter files, e.g. ``*.py``.
        max_results: Maximum number of results to return.
        max_depth: Max recursion depth when falling back to tree walk. Default 6.
    """
    from evoflow.tools.host_direct.workspace_path_guard import resolve_filesystem_search_root

    root, thread_id = resolve_filesystem_search_root(runtime=runtime)
    try:
        fut = _SEARCH_CONTENT_POOL.submit(
            _run_search_content,
            pattern=pattern,
            path=root,
            thread_id=thread_id,
            context_before=context_before,
            context_after=context_after,
            case_sensitive=case_sensitive,
            output_mode=output_mode,
            glob_pattern=glob_pattern,
            max_results=max_results,
            max_depth=max_depth,
        )
        return fut.result(timeout=_MAX_WALL_SECONDS)
    except FuturesTimeoutError:
        return f"Error: search timed out after {int(_MAX_WALL_SECONDS)}s. Add `glob_pattern` (e.g. '*.py'), lower `max_depth`, or use `search_code_index` for keywords first."
    except Exception as e:
        return f"Error: searching content: {e}"


def _is_complex_regex(pattern: str) -> bool:
    p = str(pattern or "").strip()
    if not p:
        return True
    return bool(_REGEX_COMPLEX_RE.search(p))


def _fts_search_terms(pattern: str) -> list[str]:
    """Extract index-friendly tokens from a regex or pipe-separated pattern."""
    terms: list[str] = []
    seen: set[str] = set()
    for part in split_pipe_terms(pattern):
        part = str(part or "").strip()
        if not part:
            continue
        if not _is_complex_regex(part):
            key = part.casefold()
            if len(part) >= 2 and key not in seen:
                seen.add(key)
                terms.append(part)
            continue
        for token in re.findall(r"[A-Za-z_][A-Za-z0-9_]{2,}", part):
            key = token.casefold()
            if key not in seen:
                seen.add(key)
                terms.append(token)
    return terms[:12]


_PIPE_LITERAL_RE = re.compile(r"[\\.*+?^${}\[\]|()]")
# Ultra-common tokens that match everywhere in JS/TS and cause rg regex-OR timeouts.
_PIPE_DISK_STOP_TERMS = frozenset(
    {
        "kind",
        "type",
        "name",
        "id",
        "key",
        "val",
        "value",
        "get",
        "set",
        "new",
        "row",
        "col",
        "data",
        "item",
        "list",
        "map",
        "obj",
        "ref",
        "src",
        "dst",
        "log",
        "err",
        "msg",
    }
)


def _is_pipe_literal_keyword_list(pattern: str) -> bool:
    """True when ``|`` separates literal keywords (incl. CJK), not regex alternation."""
    p = str(pattern or "").strip()
    if "|" not in p or _is_complex_regex(p):
        return False
    parts = split_pipe_terms(p)
    if len(parts) < 2:
        return False
    for part in parts:
        if len(part) < 2 or len(part) > 96:
            return False
        if _PIPE_LITERAL_RE.search(part):
            return False
    return True


def _filter_pipe_terms_for_disk_search(parts: list[str]) -> list[str]:
    """Drop poison terms like ``kind`` that make rg scan the whole tree."""
    kept: list[str] = []
    for part in parts:
        low = str(part or "").strip().casefold()
        if not low:
            continue
        if low in _PIPE_DISK_STOP_TERMS and len(low) <= 5:
            continue
        if len(low) < 3 and low.isascii():
            continue
        kept.append(part)
    if kept:
        return kept
    # Prefer longest specific token over a stopword-only list.
    return sorted(parts, key=len, reverse=True)[:1]


def _looks_like_index_keyword_query(pattern: str) -> bool:
    """Detect model misuse: keyword/synonym lists passed as search_content regex."""
    if _is_pipe_literal_keyword_list(pattern):
        return True
    p = str(pattern or "").strip()
    if not p or _is_complex_regex(p):
        return False
    if "|" in p:
        parts = split_pipe_terms(p)
        return len(parts) >= 2 and all(2 <= len(x) <= 96 for x in parts)
    if re.search(r"\s", p) and not re.search(r"[\\.*+?^\[\](){}$]", p):
        words = [w for w in re.split(r"\s+", p) if w.strip()]
        if len(words) < 2 or not all(2 <= len(w) <= 64 for w in words):
            return False
        id_like = sum(1 for w in words if re.fullmatch(r"[\w./-]+", w))
        return id_like >= 2
    return False


def _index_keyword_parts(pattern: str) -> list[str]:
    p = str(pattern or "").strip()
    if "|" in p:
        return [x.strip() for x in split_pipe_terms(p) if x.strip()]
    return [x.strip() for x in re.split(r"\s+", p) if len(x.strip()) >= 2]


_INDEX_REDIRECT_BANNER = (
    "[search_content → code index] `pattern` is a keyword/synonym query (not Python regex); "
    "ran tokenized FTS search instead of disk scan.\n"
    "Next time prefer `search_code_index` with the same query.\n\n"
)


def _try_index_keyword_redirect(
    *,
    pattern: str,
    workspace_root: str,
    thread_id: str | None,
    max_results: int,
    path_prefix: str | None = None,
) -> str | None:
    parts = _index_keyword_parts(pattern)
    if len(parts) < 2:
        return None
    from evoflow.code_index.format_results import format_search_index_body
    from evoflow.code_index.store import index_status, merge_search_queries, search_index

    primary, *extra = parts[0], parts[1:]
    label, _explicit = merge_search_queries(primary, queries=extra)
    scoped_primary = primary
    scoped_label = label
    pref = str(path_prefix or "").strip().replace("\\", "/").strip("/")
    if pref:
        scoped_primary = f"path:{pref} {primary}"
        scoped_label = f"path:{pref} {label}"
    data = search_index(
        workspace_root,
        scoped_primary,
        queries=extra or None,
        thread_id=thread_id,
        limit=max_results,
    )
    hits = data.get("hits") or []
    symbols = data.get("symbols") or []
    related = data.get("related_files") or []
    imported_by = data.get("imported_by") or []
    imports = data.get("imports") or []
    ref_users = data.get("internal_ref_users") or []
    type_supers = data.get("type_supertypes") or []
    type_subs = data.get("type_subtypes") or []
    if not any([hits, symbols, related, imported_by, imports, ref_users, type_supers, type_subs]):
        st = index_status(workspace_root=workspace_root, thread_id=thread_id)
        if st.get("building"):
            return (
                _INDEX_REDIRECT_BANNER
                + f"No index hits for '{scoped_label}' yet — workspace index is still building."
            )
        return _INDEX_REDIRECT_BANNER + f"No index hits for '{scoped_label}'."
    body = format_search_index_body(data, label=scoped_label, limit=max_results)
    return _INDEX_REDIRECT_BANNER + body


def _misuse_hint(pattern: str) -> str:
    """Nudge model when pattern looks like a search_code_index synonym list."""
    if "|" not in str(pattern or ""):
        return ""
    parts = split_pipe_terms(pattern)
    if not parts or any(_is_complex_regex(p) for p in parts):
        return ""
    if not all(len(p) < 96 for p in parts):
        return ""
    return (
        "\n\n[hint] Pipe-separated keywords/API paths belong in `search_code_index` "
        f'(query="{pattern[:160]}"), not `search_content`. '
        "`search_content` `pattern` is one Python regex (`|` = OR, exact substring per branch). "
        "Include spelling variants (e.g. `dall-e` not only `dalle`)."
    )


def _attach_no_match_hint(pattern: str, text: str) -> str:
    if not text.strip().endswith("(no matches)"):
        return text
    hint = _misuse_hint(pattern)
    return f"{text}{hint}" if hint else text


def _filter_candidate_paths(
    abs_paths: list[str],
    root: Path,
    glob_pattern: str | None,
) -> list[Path]:
    out: list[Path] = []
    for abs_p in abs_paths:
        p = Path(abs_p)
        if not p.is_file():
            continue
        try:
            if p.stat().st_size > _MAX_FILE_SIZE:
                continue
        except OSError:
            continue
        if glob_pattern and not fnmatch.fnmatch(p.name, glob_pattern):
            continue
        if _is_binary(p):
            continue
        out.append(p)
    return out


def _index_search_bundle(
    workspace_root: str,
    thread_id: str | None,
    pattern: str,
    glob_pattern: str | None,
    *,
    cap: int = _INDEX_CANDIDATE_CAP,
) -> tuple[list[Path] | None, dict[str, Any] | None, str]:
    """Return (candidate files, search_index payload, banner). All None/empty → use tree walk."""
    from evoflow.code_index.store import index_status, search_index
    from evoflow.config.code_index_config import get_code_index_config
    from evoflow.scheduler.search_follow_read import paths_from_search_data

    if not get_code_index_config().enabled:
        return None, None, ""
    st = index_status(workspace_root=workspace_root, thread_id=thread_id)
    if not st.get("ready"):
        if st.get("building"):
            return (
                [],
                {},
                "[index] code index is building — use search_code_index (retry in a few seconds); "
                "avoid full-tree search_content until ready.\n",
            )
        return None, None, ""

    terms = _fts_search_terms(pattern)
    if not terms:
        return None, None, ""

    primary, *extra = terms[0], *terms[1:]
    data = search_index(
        workspace_root,
        primary,
        queries=extra or None,
        thread_id=thread_id,
        limit=min(cap, 120),
    )
    root = Path(workspace_root).resolve()
    abs_paths = paths_from_search_data(data, str(root), max_files=cap)
    files = _filter_candidate_paths(abs_paths, root, glob_pattern)
    if not files:
        return (
            [],
            data,
            "[index] no file candidates from FTS/symbols — not scanning full tree (use search_code_index or refine terms).\n",
        )
    banner = f"[index-backed] FTS narrowed to {len(files)} file(s); applying regex on disk.\n"
    return files, data, banner


def _format_fts_content_hits(data: dict[str, Any], root: Path, max_results: int) -> str:
    lines: list[str] = []
    for h in (data.get("hits") or [])[:max_results]:
        rel = str(h.get("path") or "").strip()
        if not rel:
            continue
        snip = str(h.get("snippet") or "").replace("<b>", "").replace("</b>", "")
        lines.append(f"{root / rel}:1:\n{snip}")
    return "\n".join(lines) if lines else "(no matches)"


def _run_search_content(
    *,
    pattern: str,
    path: str,
    thread_id: str | None,
    context_before: int,
    context_after: int,
    case_sensitive: bool,
    output_mode: Literal["content", "count", "files_with_matches"],
    glob_pattern: str | None,
    max_results: int,
    max_depth: int,
    skip_index: bool = False,
) -> str:
    search_root = Path(path).resolve()
    single_file: Path | None = None
    if search_root.is_file():
        single_file = search_root
        workspace_root = str(search_root.parent)
    else:
        workspace_root = str(search_root)

    if (
        not skip_index
        and context_before == 0
        and context_after == 0
        and not case_sensitive
        and output_mode == "content"
        and _looks_like_index_keyword_query(pattern)
    ):
        redirected = _try_index_keyword_redirect(
            pattern=pattern,
            workspace_root=workspace_root,
            thread_id=thread_id,
            max_results=max_results,
        )
        if redirected is not None:
            return redirected

    flags = 0 if case_sensitive else re.IGNORECASE
    try:
        regex = re.compile(pattern, flags)
    except re.error as e:
        return f"Error: Invalid regex '{pattern}': {e}"

    if skip_index:
        index_files, index_data, banner = None, None, ""
    else:
        index_files, index_data, banner = _index_search_bundle(
            workspace_root,
            thread_id,
            pattern,
            glob_pattern,
        )

    simple = not _is_complex_regex(pattern)
    no_ctx = context_before == 0 and context_after == 0

    if index_files and index_data and simple and not case_sensitive and no_ctx:
        if output_mode == "files_with_matches":
            lines = [str(p) for p in index_files[:max_results]]
            body = "\n".join(lines) if lines else "(no matches)"
            return banner + _attach_no_match_hint(pattern, body)
        if output_mode == "content" and (index_data.get("hits") or []):
            body = _format_fts_content_hits(index_data, search_root if search_root.is_dir() else search_root.parent, max_results)
            return banner + body

    files: list[Path]
    if index_files:
        files = index_files
    elif index_files is not None:
        if banner and "building" in banner.lower():
            return banner.strip()
        if index_data is not None:
            # Index consulted but no file candidates — fail fast (do not scan 8000 files / 45s timeout).
            body = "(no matches)"
            out = f"{banner}{body}" if banner else body
            return _attach_no_match_hint(pattern, out)
    elif single_file is not None:
        files = [single_file]
        banner = ""
    elif search_root.is_file():
        files = [search_root]
        banner = ""
    elif search_root.is_dir():
        files = _collect_files(search_root, glob_pattern, max_depth)
        banner = ""
    else:
        return f"Error: Not a valid workspace path: {path}"

    if output_mode == "files_with_matches":
        body = _search_files_only(files, regex, max_results)
    elif output_mode == "count":
        body = _search_count(files, regex, max_results)
    else:
        body = _search_content(files, regex, context_before, context_after, max_results)

    out = f"{banner}{body}" if banner else body
    return _attach_no_match_hint(pattern, out)


def _collect_files(root: Path, glob_pattern: str | None, max_depth: int) -> list[Path]:
    """Recursively collect files respecting ignores and depth limits."""
    results: list[Path] = []

    def _walk(current: Path, depth: int):
        if depth > max_depth or len(results) >= _MAX_FILES_SCAN:
            return
        try:
            entries = sorted(current.iterdir())
        except PermissionError:
            return

        for entry in entries:
            if len(results) >= _MAX_FILES_SCAN:
                return
            if entry.name.startswith(".") or entry.name in _SKIP_DIRS:
                continue
            if entry.is_dir():
                _walk(entry, depth + 1)
            elif entry.is_file():
                if entry.stat().st_size > _MAX_FILE_SIZE:
                    continue
                if _is_binary(entry):
                    continue
                if glob_pattern and not fnmatch.fnmatch(entry.name, glob_pattern):
                    continue
                results.append(entry)

    _walk(root, 1)
    return results


def _is_binary(p: Path) -> bool:
    """Quick check for binary files (null byte detection)."""
    try:
        with open(p, "rb") as f:
            chunk = f.read(8192)
        return b"\x00" in chunk
    except OSError:
        return True


def _search_files_only(files: list[Path], regex, max_results: int) -> str:
    matched = []
    for f in files[: max_results * 3]:
        try:
            content = f.read_text(encoding="utf-8", errors="skip")
            if regex.search(content):
                matched.append(str(f))
        except (OSError, UnicodeDecodeError):
            continue
        if len(matched) >= max_results:
            break
    return "\n".join(matched) if matched else "(no matches)"


def _search_count(files: list[Path], regex, max_results: int) -> str:
    counts = []
    for f in files[: max_results * 3]:
        try:
            content = f.read_text(encoding="utf-8", errors="skip")
            matches = regex.findall(content)
            if matches:
                counts.append(f"{f}: {len(matches)} match(es)")
        except (OSError, UnicodeDecodeError):
            continue
    return "\n".join(counts) if counts else "(no matches)"


def _search_content(files: list[Path], regex, ctx_b: int, ctx_a: int, max_r: int) -> str:
    results = []
    total = 0
    for f in files[: max_r * 2]:
        try:
            content = f.read_text(encoding="utf-8", errors="skip")
            lines = content.splitlines()
            for i, line in enumerate(lines):
                if regex.search(line):
                    total += 1
                    if len(results) >= max_r:
                        results.append(f"... (truncated, {total} total matches)")
                        return "\n".join(results)

                    start = max(0, i - ctx_b)
                    end = min(len(lines), i + 1 + ctx_a)
                    nums = ",".join(str(n + 1) for n in range(start, end))
                    snippet = "\n".join(lines[start:end])
                    results.append(f"{f}:{nums}:\n{snippet}")
        except (OSError, UnicodeDecodeError):
            continue
    return "\n".join(results) if results else "(no matches)"
