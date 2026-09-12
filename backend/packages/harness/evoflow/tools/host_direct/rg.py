"""Ripgrep-style workspace content search (native ``rg`` when available, Python fallback)."""

from __future__ import annotations

import atexit
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeoutError
from pathlib import Path
from typing import Literal

from langchain.tools import ToolRuntime, tool

from evoflow.tools.minimal_schema import RG_TOOL_DESCRIPTION

_MAX_WALL_SECONDS = 45.0
_MAX_RESULTS_CAP = 200
_RG_POOL = ThreadPoolExecutor(max_workers=2, thread_name_prefix="rg-search")
atexit.register(lambda: _RG_POOL.shutdown(wait=False, cancel_futures=True))


def _subprocess_no_window_kwargs() -> dict:
    """Return kwargs to suppress the console window on Windows."""
    if sys.platform == "win32":
        # CREATE_NO_WINDOW = 0x08000000; hides the console for GUI/parent processes.
        return {"creationflags": subprocess.CREATE_NO_WINDOW}
    return {}


def _find_rg_binary() -> str | None:
    for name in ("rg", "ripgrep", "rg.exe", "ripgrep.exe"):
        found = shutil.which(name)
        if found:
            return found
    from evoflow.utils.bundled_tools import bundled_ripgrep_binary

    return bundled_ripgrep_binary()


def _resolve_search_path(path: str | None, *, runtime: object) -> tuple[str, str | None] | str:
    from evoflow.tools.host_direct.workspace_path_guard import resolve_search_workspace_root

    resolved = resolve_search_workspace_root(runtime=runtime)
    if isinstance(resolved, str):
        return resolved
    workspace_root, thread_id = resolved
    rel = str(path or ".").strip() or "."
    if rel in (".", ""):
        return workspace_root, thread_id
    from evoflow.tools.host_direct.workspace_path_guard import resolve_tool_path

    target = resolve_tool_path(rel, runtime=runtime, must_exist=True)
    if isinstance(target, str):
        return target
    return str(target.resolve()), thread_id


def _run_native_rg(
    *,
    rg_bin: str,
    pattern: str,
    search_path: str,
    glob_pattern: str | None,
    context_before: int,
    context_after: int,
    case_sensitive: bool,
    output_mode: Literal["content", "count", "files_with_matches"],
    max_results: int,
) -> str:
    cmd: list[str] = [rg_bin, "--color=never", "--no-heading"]
    if not case_sensitive:
        cmd.append("-i")
    if context_before > 0:
        cmd.extend(["-B", str(int(context_before))])
    if context_after > 0:
        cmd.extend(["-A", str(int(context_after))])
    if glob_pattern:
        cmd.extend(["--glob", str(glob_pattern)])
    if output_mode == "files_with_matches":
        cmd.append("-l")
    elif output_mode == "count":
        cmd.append("-c")
    cmd.extend(["-m", str(max(1, max_results))])
    cmd.append(pattern)
    cmd.append(search_path)

    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=_MAX_WALL_SECONDS - 2,
            cwd=search_path if Path(search_path).is_dir() else None,
            **_subprocess_no_window_kwargs(),
        )
    except subprocess.TimeoutExpired:
        return (
            f"Error: rg timed out after {int(_MAX_WALL_SECONDS)}s. "
            "Narrow with `path`, `glob`, or a more specific pattern."
        )
    except OSError as e:
        return f"Error: rg failed to run: {e}"

    out = (proc.stdout or "").strip()
    err = (proc.stderr or "").strip()
    if proc.returncode == 1 and not out:
        hint = ""
        if err:
            hint = f"\n{err}"
        return f"(no matches){hint}"
    if proc.returncode not in (0, 1):
        detail = err or out or f"exit {proc.returncode}"
        return f"Error: rg failed: {detail[:2000]}"

    if not out:
        return "(no matches)"
    lines = out.splitlines()
    if len(lines) > max_results and output_mode == "content":
        out = "\n".join(lines[:max_results]) + f"\n… ({len(lines) - max_results} more lines truncated)"
    return out


def _rg_index_path_prefix(rel_path: str | None, search_path: str) -> str | None:
    rel = str(rel_path or "").strip().replace("\\", "/").strip("/")
    if not rel or rel in (".", ""):
        return None
    sp = Path(search_path)
    if sp.is_file():
        parent = Path(rel).parent.as_posix().strip("/")
        return parent or None
    return rel


def _run_native_rg_fixed_strings(
    *,
    rg_bin: str,
    terms: list[str],
    search_path: str,
    glob_pattern: str | None,
    context_before: int,
    context_after: int,
    case_sensitive: bool,
    max_results: int,
) -> str:
    """Run ``rg -F`` per keyword; avoids regex-OR on poison terms like ``kind``."""
    if not terms:
        return "(no matches)"
    per_term = max(2, min(20, max_results // max(1, len(terms))))
    lines: list[str] = []
    for term in terms:
        if len(lines) >= max_results:
            break
        cmd: list[str] = [rg_bin, "--color=never", "--no-heading", "-F", term]
        if not case_sensitive:
            cmd.append("-i")
        if context_before > 0:
            cmd.extend(["-B", str(int(context_before))])
        if context_after > 0:
            cmd.extend(["-A", str(int(context_after))])
        if glob_pattern:
            cmd.extend(["--glob", str(glob_pattern)])
        cmd.extend(["-m", str(per_term)])
        cmd.append(search_path)
        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=max(5, int(_MAX_WALL_SECONDS // max(1, len(terms))) - 1),
                cwd=search_path if Path(search_path).is_dir() else None,
                **_subprocess_no_window_kwargs(),
            )
        except subprocess.TimeoutExpired:
            lines.append(f"… term {term!r} timed out (skipped)")
            continue
        except OSError as e:
            return f"Error: rg failed to run: {e}"
        out = (proc.stdout or "").strip()
        if out and proc.returncode in (0, 1):
            lines.extend(out.splitlines())
    if not lines:
        return "(no matches)"
    if len(lines) > max_results:
        lines = lines[:max_results] + [f"… ({len(lines) - max_results} more lines truncated)"]
    return "[rg -F keywords]\n" + "\n".join(lines)


def _run_rg_wallclock(
    *,
    pattern: str,
    path: str | None,
    glob_pattern: str | None,
    context_before: int,
    context_after: int,
    case_sensitive: bool,
    output_mode: Literal["content", "count", "files_with_matches"],
    max_results: int,
    runtime: object,
    literal: bool = False,
) -> str:
    resolved = _resolve_search_path(path, runtime=runtime)
    if isinstance(resolved, str):
        return resolved
    search_path, thread_id = resolved

    pat = str(pattern or "").strip()
    if not pat:
        return "Error: pattern is required"

    lim = max(1, min(int(max_results), _MAX_RESULTS_CAP))

    from evoflow.tools.arg_coerce import split_pipe_terms
    from evoflow.tools.host_direct.search_content import (
        _filter_pipe_terms_for_disk_search,
        _is_pipe_literal_keyword_list,
    )

    # Pipe-separated keywords (foo|bar): native rg -F per term — never redirect to FTS.
    if (
        not literal
        and "|" in pat
        and output_mode == "content"
        and not glob_pattern
        and _is_pipe_literal_keyword_list(pat)
    ):
        rg_bin = _find_rg_binary()
        terms = _filter_pipe_terms_for_disk_search(split_pipe_terms(pat))
        if rg_bin and terms:
            body = _run_native_rg_fixed_strings(
                rg_bin=rg_bin,
                terms=terms,
                search_path=search_path,
                glob_pattern=glob_pattern,
                context_before=context_before,
                context_after=context_after,
                case_sensitive=case_sensitive,
                max_results=lim,
            )
            if not body.startswith("Error:"):
                dropped = [t for t in split_pipe_terms(pat) if t not in terms]
                note = ""
                if dropped:
                    note = (
                        f"\n\n[note] Dropped overly broad keyword(s) {dropped!r} "
                        "(use a longer literal or `search_code_index` for those)."
                    )
                return (
                    "[rg → fixed-string] pipe-separated keywords are not regex OR; "
                    "searched each term with `rg -F`.\n"
                    f"{body}{note}"
                )

    rg_bin = _find_rg_binary()
    if rg_bin:
        return _run_native_rg(
            rg_bin=rg_bin,
            pattern=pat,
            search_path=search_path,
            glob_pattern=glob_pattern,
            context_before=context_before,
            context_after=context_after,
            case_sensitive=case_sensitive,
            output_mode=output_mode,
            max_results=lim,
        )

    import re

    from evoflow.tools.host_direct.search_content import _run_search_content

    fallback_pat = pat
    if "|" in pat and _is_pipe_literal_keyword_list(pat):
        terms = _filter_pipe_terms_for_disk_search(split_pipe_terms(pat))
        if terms:
            fallback_pat = "|".join(re.escape(t) for t in terms)

    body = _run_search_content(
        pattern=fallback_pat,
        path=search_path,
        thread_id=thread_id,
        context_before=context_before,
        context_after=context_after,
        case_sensitive=case_sensitive,
        output_mode=output_mode,
        glob_pattern=glob_pattern,
        max_results=lim,
        max_depth=6,
        skip_index=True,
    )
    if body.startswith("Error:"):
        return body
    return f"[rg fallback — install ripgrep (`rg`) on PATH for faster search]\n{body}"


@tool("rg", description=RG_TOOL_DESCRIPTION, parse_docstring=False)
def rg_hd(
    pattern: str,
    *,
    path: str = ".",
    glob: str | None = None,
    context_before: int = 0,
    context_after: int = 0,
    case_sensitive: bool = False,
    output_mode: Literal["content", "count", "files_with_matches"] = "content",
    max_results: int = 50,
    literal: bool = False,
    runtime: ToolRuntime,
) -> str:
    """Search file contents with ripgrep in the bound workspace."""
    tid = ""
    if runtime is not None and getattr(runtime, "context", None):
        tid = str(runtime.context.get("thread_id") or "").strip()
    if tid:
        from evoflow.exploration.exploration_budget import check_tool_budget

        budget_err = check_tool_budget(tid, "rg", {"pattern": pattern, "path": path})
        if budget_err:
            return budget_err
    # Support comma-separated multi-path (优化10)
    if "," in str(path):
        _paths = [p.strip() for p in str(path).split(",") if p.strip()]
        if len(_paths) > 1:
            _sections: list[str] = []
            for _p in _paths:
                try:
                    _fut = _RG_POOL.submit(
                        _run_rg_wallclock,
                        pattern=pattern,
                        path=_p,
                        glob_pattern=glob,
                        context_before=max(0, int(context_before)),
                        context_after=max(0, int(context_after)),
                        case_sensitive=bool(case_sensitive),
                        output_mode=output_mode,
                        max_results=max_results,
                        runtime=runtime,
                        literal=literal,
                    )
                    _result = _fut.result(timeout=_MAX_WALL_SECONDS)
                    if _result and not _result.startswith("Error:"):
                        _sections.append(f"[path: {_p}]\n{_result}")
                except FuturesTimeoutError:
                    _sections.append(f"[path: {_p}]\nError: timed out after {int(_MAX_WALL_SECONDS)}s")
            return "\n\n".join(_sections) if _sections else "(no matches)"
    try:
        fut = _RG_POOL.submit(
            _run_rg_wallclock,
            pattern=pattern,
            path=path,
            glob_pattern=glob,
            context_before=max(0, int(context_before)),
            context_after=max(0, int(context_after)),
            case_sensitive=bool(case_sensitive),
            output_mode=output_mode,
            max_results=max_results,
            runtime=runtime,
            literal=literal,
        )
        return fut.result(timeout=_MAX_WALL_SECONDS)
    except FuturesTimeoutError:
        return (
            f"Error: rg timed out after {int(_MAX_WALL_SECONDS)}s. "
            "Add `glob`, narrow `path`, or simplify the pattern."
        )


# Alias tool for configs/docs that say ``ripgrep`` (catalog alias via tool_aliases.py)
