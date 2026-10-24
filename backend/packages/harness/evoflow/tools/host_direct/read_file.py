"""Read file contents — direct filesystem access, no sandbox overhead."""

import os
from pathlib import Path

from langchain.tools import ToolRuntime, tool
from langgraph.types import Command

from evoflow.tools.host_direct.read_logic import read_file_content
from evoflow.tools.host_direct.workspace_context import resolve_tool_workspace_root
from evoflow.tools.host_direct.workspace_path_guard import (
    _is_absolute_path,
    _resolve_relative_under_root,
    resolve_tool_path,
)
from evoflow.tools.minimal_schema import READ_TOOL_DESCRIPTION
from evoflow.utils.workspace_browse import flatten_bound_workspace_absolute

# Image refs (local paths / http(s) URLs / browser-snapshot refs) dispatch to the
# shared view_image pipeline instead of returning text (ZCode-style Read dispatch).
_IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp")

_SYMBOL_MAX_LINES = 200

_PYTHON_EXTS = {".py", ".pyi"}
_JS_TS_EXTS = {".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"}
_JAVA_EXTS = {".java"}


def _detect_language(path: Path) -> str:
    """Detect language from file extension for symbol matching."""
    ext = path.suffix.lower()
    if ext in _PYTHON_EXTS:
        return "python"
    if ext in _JS_TS_EXTS:
        return "jsts"
    if ext in _JAVA_EXTS:
        return "java"
    return "python"  # default: indentation-based matching works for many languages


def _find_symbol_range(content: str, symbol: str, language: str = "python") -> tuple[int, int] | None:
    """Find the line range (1-based start, exclusive end) of a function/class by name.

    Supports Python (indentation-based body), JS/TS/Java (brace-matched body).
    """
    lines = content.splitlines()
    if language == "python":
        return _find_symbol_python(lines, symbol)
    return _find_symbol_brace(lines, symbol, language)


def _find_symbol_python(lines: list[str], symbol: str) -> tuple[int, int] | None:
    """Python: match def/class, use indentation to find body end."""
    import re

    pattern = re.compile(
        r"^(\s*)(?:async\s+)?(?:def|class)\s+" + re.escape(symbol) + r"\b",
    )
    for i, line in enumerate(lines):
        m = pattern.match(line)
        if not m:
            continue
        indent = len(m.group(1))
        start = i
        end = len(lines)
        for j in range(i + 1, len(lines)):
            line_j = lines[j]
            if line_j.strip() == "":
                continue
            current_indent = len(line_j) - len(line_j.lstrip())
            if current_indent <= indent and line_j.strip():
                end = j
                break
        return (start + 1, end)
    return None


def _find_symbol_brace(lines: list[str], symbol: str, language: str) -> tuple[int, int] | None:
    """JS/TS/Java: match function/class/method, use brace matching for body end."""
    import re

    sym = re.escape(symbol)
    if language == "jsts":
        patterns = [
            re.compile(rf"^(\s*)(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+{sym}\b"),
            re.compile(rf"^(\s*)(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+{sym}\b"),
            re.compile(rf"^(\s*)(?:export\s+)?(?:const|let|var)\s+{sym}\s*=?\s*(?:\(|function|async|=>|\[)"),
        ]
    else:  # java
        patterns = [
            re.compile(rf"^(\s*)(?:\w+\s+)*(?:class|interface|enum)\s+{sym}\b"),
            re.compile(rf"^(\s*)(?:\w+\s+)*\w+(?:\s*<[^>]+>)?\s+{sym}\s*\("),
        ]

    for i, line in enumerate(lines):
        if not any(pat.match(line) for pat in patterns):
            continue
        # Find first opening brace within next 20 lines (handles multi-line params)
        brace_line = -1
        for j in range(i, min(i + 20, len(lines))):
            if "{" in lines[j]:
                brace_line = j
                break
        if brace_line < 0:
            # No brace — abstract method, interface method, or one-liner ending with ;
            end = i + 1
            for j in range(i + 1, min(i + 5, len(lines))):
                if lines[j].rstrip().endswith(";"):
                    end = j + 1
                    break
            return (i + 1, end)
        # Brace matching from brace_line
        depth = 0
        for k in range(brace_line, len(lines)):
            for ch in lines[k]:
                if ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        return (i + 1, k + 1)
        return (i + 1, len(lines))
    return None


def _list_symbols_in_file(content: str, language: str = "python", limit: int = 15) -> list[str]:
    """Extract top-level symbol names for 'did you mean' suggestions."""
    import re

    lines = content.splitlines()
    names: list[str] = []
    if language == "python":
        pat = re.compile(r"^(\s*)(?:async\s+)?(?:def|class)\s+(\w+)")
        grp = 2
    elif language == "jsts":
        pat = re.compile(r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+|class\s+)(\w+)")
        grp = 1
    else:
        pat = re.compile(r"^\s*(?:\w+\s+)*(?:class|interface|enum)\s+(\w+)")
        grp = 1
    for line in lines:
        m = pat.match(line)
        if m:
            name = m.group(grp)
            if name and name not in names:
                names.append(name)
        if len(names) >= limit:
            break
    return names


def _resolve_read_target(path: str, *, runtime: ToolRuntime) -> Path | str:
    """Resolve *path* to a host file without workspace confinement (IDE-like)."""
    raw = str(path or "").strip()
    if not raw:
        return "Error: path is required"

    if raw.startswith("skill:"):
        resolved = resolve_tool_path(
            raw,
            runtime=runtime,
            must_exist=True,
            must_be_file=True,
            allow_skills_install=True,
        )
        return resolved

    expanded = os.path.expanduser(os.path.expandvars(raw))
    if _is_absolute_path(raw, expanded):
        target = Path(expanded).resolve()
        root_s, _tid = resolve_tool_workspace_root(runtime=runtime)
        if root_s:
            root = Path(os.path.expanduser(os.path.expandvars(root_s))).resolve()
            target = flatten_bound_workspace_absolute(target, root)
        if not target.is_file():
            if target.is_dir():
                return f"Error: Path is a directory, not a file: {path}. Use terminal (e.g. dir / ls) to browse, or read with a concrete file path."
            return f"Error: File not found: {path}"
        return target

    root_s, _tid = resolve_tool_workspace_root(runtime=runtime)
    if root_s:
        root = Path(os.path.expanduser(os.path.expandvars(root_s))).resolve()
        if not root.is_dir():
            return f"Error: Workspace root is not a directory: {root}"
        target = _resolve_relative_under_root(root, raw.replace("\\", "/"))
    else:
        target = (Path.cwd() / expanded).resolve()

    if not target.is_file():
        if target.is_dir():
            return f"Error: Path is a directory, not a file: {path}. Use terminal (e.g. dir / ls) to browse, or read with a concrete file path."
        return f"Error: File not found: {path}"
    return target


def _note_model_read(path: Path, *, full_read: bool = True, content_hash: str | None = None) -> None:
    try:
        from evoflow.tools.zcode_port.read_file_state import note_read

        note_read(str(path), full_read=full_read, content_hash=content_hash)
    except Exception:
        return


def _is_image_ref(ref: str) -> bool:
    """True for refs the view_image pipeline can handle: image path / http(s) URL / browser-snapshot."""
    s = str(ref or "").strip().replace("\\", "/")
    if not s:
        return False
    lower = s.lower()
    if lower.startswith(("http://", "https://")) or "/browser-snapshots/" in lower:
        return True
    # Strip URL query/fragment before the extension check.
    return os.path.splitext(lower.split("?", 1)[0].split("#", 1)[0])[1] in _IMAGE_EXTENSIONS


def _resolve_image_ref(ref: str, *, runtime: ToolRuntime) -> str:
    """Resolve a local image ref to an absolute path; URL / snapshot refs pass through.

    Reuses the read tool's own path resolution (workspace-relative paths,
    ``skill:`` paths, env expansion) so image reads behave like text reads.
    """
    lowered = ref.lower()
    if lowered.startswith(("http://", "https://")) or "/browser-snapshots/" in lowered:
        return ref
    resolved = _resolve_read_target(ref, runtime=runtime)
    if isinstance(resolved, str):
        return resolved  # read-style error string, returned verbatim
    return str(resolved)


@tool("read", description=READ_TOOL_DESCRIPTION, parse_docstring=False)
def read_file_hd(
    path: str | list[str],
    *,
    offset: int | None = None,
    limit: int | None = None,
    symbol: str | None = None,
    pages: str | None = None,
    runtime: ToolRuntime,
) -> str | Command:
    """Read one file (text) or load/analyze image(s) from the local filesystem or URLs."""
    from evoflow.tools.builtins.view_image_tool import (
        normalize_image_path_args,
        run_view_image_refs,
    )

    # Staged-image Commands must carry the originating tool call id; the real
    # graph always provides it via ToolRuntime (node_repl_tool uses the same
    # pattern — no InjectedToolCallId param, so direct ``.invoke()`` keeps working).
    tool_call_id = str(getattr(runtime, "tool_call_id", "") or "").strip()

    # ── Image dispatch ──
    # ``path`` may be a single ref or a list of image refs (batch, view_image semantics).
    # A JSON-array string is accepted and expanded for older callers.
    image_refs = normalize_image_path_args(path)
    if len(image_refs) > 1:
        if not all(_is_image_ref(ref) for ref in image_refs):
            return (
                "Error: read accepts a list only for image paths/URLs "
                "(jpg/jpeg/png/webp, http(s) URLs, browser-snapshot refs); "
                "read text files one at a time."
            )
        resolved_refs: list[str] = []
        for ref in image_refs:
            resolved_ref = _resolve_image_ref(ref, runtime=runtime)
            if resolved_ref.startswith("Error"):
                return resolved_ref
            resolved_refs.append(resolved_ref)
        return run_view_image_refs(runtime=runtime, tool_call_id=tool_call_id, refs=resolved_refs)
    if image_refs and _is_image_ref(image_refs[0]):
        resolved_ref = _resolve_image_ref(image_refs[0], runtime=runtime)
        if resolved_ref.startswith("Error"):
            return resolved_ref
        return run_view_image_refs(runtime=runtime, tool_call_id=tool_call_id, refs=[resolved_ref])

    # ── Text path ──
    resolved = _resolve_read_target(path, runtime=runtime)
    if isinstance(resolved, str):
        return resolved
    # ── PDF path (zcode Read PDF alignment) ──
    # Dispatched before symbol/offset/limit: those are line-oriented and
    # meaningless for PDFs; ``pages`` is the PDF-native page range parameter.
    if resolved.suffix.lower() == ".pdf":
        from evoflow.tools.host_direct.read_pdf import read_pdf_file

        text = read_pdf_file(resolved, pages=pages)
        if not str(text).startswith("Error:"):
            _note_model_read(resolved, full_read=False)
        return text
    if symbol:
        content = resolved.read_text(encoding="utf-8", errors="replace")
        language = _detect_language(resolved)
        result = _find_symbol_range(content, symbol, language=language)
        if result is None:
            available = _list_symbols_in_file(content, language=language)
            hint = ""
            if available:
                hint = f"\n\nAvailable symbols: {', '.join(available[:10])}"
            return f"Error: Symbol '{symbol}' not found in {path}.{hint}\n\nTip: Use offset + limit to read by line range."
        start, end = result
        lines = content.splitlines()
        body_lines = lines[start - 1 : end]
        total = len(body_lines)
        if total > _SYMBOL_MAX_LINES:
            shown = body_lines[:_SYMBOL_MAX_LINES]
            text = "\n".join(f"{start + i}: {line}" for i, line in enumerate(shown))
            remaining = total - _SYMBOL_MAX_LINES
            text += f"\n\n… [symbol '{symbol}' body is {total} lines; showing first {_SYMBOL_MAX_LINES}. Read the rest with offset={start + _SYMBOL_MAX_LINES}, limit={min(_SYMBOL_MAX_LINES, remaining)}]"
            return text
        text = "\n".join(f"{start + i}: {line}" for i, line in enumerate(body_lines))
        _note_model_read(resolved, full_read=False)
        return text
    # ZCode-style file_unchanged short-circuit: a full-text re-read of an
    # unchanged file returns a one-line marker instead of resending content.
    if offset is None and limit is None:
        try:
            from evoflow.tools.zcode_port.read_file_state import unchanged_since_last_read

            if unchanged_since_last_read(resolved):
                return (
                    "Wasted call — file unchanged since your last Read. "
                    "Refer to that earlier tool_result instead. "
                    "If you intentionally want the content again, use offset=1."
                )
        except Exception:
            pass
    text = read_file_content(str(resolved), offset=offset, limit=limit, use_cache=True)
    if not str(text).startswith("Error:"):
        full_read = offset is None and limit is None
        # Hash only meaningful for full views; partial views never qualify for edit.
        content_hash = None
        if full_read:
            import hashlib

            content_hash = hashlib.md5(str(text).encode("utf-8", errors="replace")).hexdigest()
        _note_model_read(resolved, full_read=full_read, content_hash=content_hash)
    return text
