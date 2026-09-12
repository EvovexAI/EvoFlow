"""Language-aware lint runners + post-edit auto-lint for code files."""

from __future__ import annotations

import importlib.util
import logging
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_LINT_TIMEOUT = int(os.getenv("LINT_COMMAND_TIMEOUT", "45"))
_POST_EDIT_LINT_TIMEOUT = int(os.getenv("POST_EDIT_LINT_TIMEOUT", "12"))
_AUTO_AFTER_EDIT = os.getenv("LINT_AUTO_AFTER_EDIT", "false").strip().lower() in ("1", "true", "yes", "on")

_PYTHON_SUFFIXES = frozenset({".py", ".pyi"})
_JS_SUFFIXES = frozenset({".js", ".jsx", ".mjs", ".cjs"})
_TS_SUFFIXES = frozenset({".ts", ".tsx", ".mts", ".cts"})
_JAVA_SUFFIXES = frozenset({".java"})
_CODE_SUFFIXES = _PYTHON_SUFFIXES | _JS_SUFFIXES | _TS_SUFFIXES | _JAVA_SUFFIXES

LINTABLE_EXTENSIONS_LABEL = ".py, .pyi, .js, .jsx, .mjs, .cjs, .ts, .tsx, .mts, .cts, .java"


def lint_skip_message(path: str | Path) -> str:
    """Human-readable skip (not an error) for non-code paths."""
    p = Path(path)
    suffix = p.suffix or "(no extension)"
    return (
        f"Skip: {p.name} is not a lintable source file ({suffix}). "
        f"read_lints only diagnoses Python, JavaScript, TypeScript, and Java ({LINTABLE_EXTENSIONS_LABEL}). "
        "Use read_file for .txt, .md, .json, .yaml, and other non-code files."
    )


def read_lints_directory_rejected_message(path: str | Path) -> str:
    p = Path(path)
    return (
        f"Error: read_lints only accepts a single source file, not a directory ({p.name}/). "
        f"Pass a concrete file path with extension in {LINTABLE_EXTENSIONS_LABEL}."
    )


def validate_read_lints_target(path: str | Path) -> str | None:
    """Return an error/skip message, or None if *path* is a lintable file."""
    p = Path(path).expanduser()
    if not p.exists():
        return f"Error: path does not exist: {path}"
    if p.is_dir():
        return read_lints_directory_rejected_message(p)
    if not is_lintable_code_path(p):
        return lint_skip_message(p)
    return None

_ESLINT_MARKERS = (
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs",
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".eslintrc.json",
    ".eslintrc.yaml",
    ".eslintrc.yml",
)
_BIOME_MARKERS = ("biome.json", "biome.jsonc")


def is_lintable_code_path(path: str | Path) -> bool:
    return Path(path).suffix.lower() in _CODE_SUFFIXES


def language_for_path(path: str | Path) -> str | None:
    suf = Path(path).suffix.lower()
    if suf in _PYTHON_SUFFIXES:
        return "python"
    if suf in _JS_SUFFIXES:
        return "javascript"
    if suf in _TS_SUFFIXES:
        return "typescript"
    if suf in _JAVA_SUFFIXES:
        return "java"
    return None


def _find_ancestor_with(start: Path, names: tuple[str, ...], *, max_hops: int = 14) -> Path | None:
    cur = start.resolve()
    if cur.is_file():
        cur = cur.parent
    for _ in range(max_hops):
        if any((cur / n).exists() for n in names):
            return cur
        if cur.parent == cur:
            break
        cur = cur.parent
    return None


def _run(cmd: list[str], *, cwd: Path | None = None, timeout: int = _LINT_TIMEOUT) -> tuple[int, str]:
    try:
        from evoflow.utils.subprocess_platform import subprocess_hide_window_kwargs, subprocess_text_io_kwargs

        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=str(cwd) if cwd else None,
            **subprocess_text_io_kwargs(),
            **subprocess_hide_window_kwargs(),
        )
        out = (proc.stdout or "").strip()
        err = (proc.stderr or "").strip()
        combined = "\n".join(x for x in (out, err) if x)
        return proc.returncode, combined
    except FileNotFoundError:
        return 127, f"Command not found: {cmd[0]}"
    except subprocess.TimeoutExpired:
        return 124, f"Timed out after {timeout}s: {' '.join(cmd[:4])}"
    except Exception as exc:
        return 1, str(exc)


def _which(name: str) -> str | None:
    return shutil.which(name)


def _venv_tool_path(root: Path, name: str) -> Path | None:
    if os.name == "nt":
        p = root / ".venv" / "Scripts" / f"{name}.exe"
    else:
        p = root / ".venv" / "bin" / name
    return p if p.is_file() else None


def _project_roots_with_pyproject(start: Path) -> list[Path]:
    cur = start.resolve()
    if cur.is_file():
        cur = cur.parent
    roots: list[Path] = []
    for _ in range(16):
        if (cur / "pyproject.toml").is_file():
            roots.append(cur)
        if cur.parent == cur:
            break
        cur = cur.parent
    return roots


def _find_venv_tool(name: str, start: Path | None) -> list[str] | None:
    """Walk up from *start* and use the nearest ``.venv`` that contains *name*."""
    if start is None:
        return None
    for root in _project_roots_with_pyproject(start):
        tool = _venv_tool_path(root, name)
        if tool:
            return [str(tool)]
    return None


def _resolve_cli(name: str, *, python_module: str | None = None, search_from: Path | None = None) -> list[str] | None:
    """Resolve CLI argv prefix: absolute binary path or ``[sys.executable, -m, module]``."""
    path = _which(name)
    if path:
        return [path]

    from_venv = _find_venv_tool(name, search_from or Path(__file__).resolve())
    if from_venv:
        return from_venv

    if sys.executable:
        bin_dir = Path(sys.executable).resolve().parent
        for candidate in (bin_dir / name, bin_dir / f"{name}.exe"):
            if candidate.is_file():
                return [str(candidate)]
        mod = (python_module or name).replace("-", "_")
        if importlib.util.find_spec(mod.split(".", 1)[0]) is not None:
            return [sys.executable, "-m", python_module or name]

    return None


def _lint_python(target: Path, *, post_edit: bool = False) -> str:
    timeout = _POST_EDIT_LINT_TIMEOUT if post_edit else _LINT_TIMEOUT
    ruff = _resolve_cli("ruff", python_module="ruff", search_from=target)
    if not ruff:
        return "python: ruff not installed (pip install ruff in backend .venv or PATH)"
    code, out = _run([*ruff, "check", "--output-format=concise", str(target)], timeout=timeout)
    if code == 0:
        return "python (ruff): No issues found."
    if code == 127:
        return f"python: {out}"
    body = out or "ruff reported issues (no stdout)."
    return f"python (ruff):\n{body}"


def _lint_js_ts(target: Path, *, post_edit: bool = False) -> str:
    """Lint JS/TS. ``post_edit=True`` skips whole-project ``tsc`` (often 60–90s on monorepos)."""
    timeout = _POST_EDIT_LINT_TIMEOUT if post_edit else _LINT_TIMEOUT
    lang = language_for_path(target) or "javascript"
    root = _find_ancestor_with(target, ("package.json", *_ESLINT_MARKERS, *_BIOME_MARKERS, "tsconfig.json"))
    rel = target.name
    if root:
        try:
            rel = target.resolve().relative_to(root.resolve()).as_posix()
        except ValueError:
            rel = str(target)

    biome = _resolve_cli("biome", search_from=target)
    if root and any((root / m).exists() for m in _BIOME_MARKERS) and biome:
        code, out = _run([*biome, "check", rel], cwd=root, timeout=timeout)
        if code == 0:
            return f"{lang} (biome): No issues found."
        return f"{lang} (biome):\n{out or 'issues reported'}"

    if root and any((root / m).exists() for m in _ESLINT_MARKERS + ("package.json",)):
        eslint_bin = _resolve_cli("eslint", search_from=target)
        npx = _resolve_cli("npx", search_from=target)
        if eslint_bin:
            cmd = [*eslint_bin, "--no-error-on-unmatched-pattern", "-f", "stylish", rel]
        elif npx:
            cmd = [*npx, "--no-install", "eslint", "--no-error-on-unmatched-pattern", "-f", "stylish", rel]
        else:
            cmd = []
        if cmd:
            code, out = _run(cmd, cwd=root, timeout=timeout)
            if code == 0:
                return f"{lang} (eslint): No issues found."
            if code != 127:
                return f"{lang} (eslint):\n{out or 'issues reported'}"

    if post_edit:
        node = _resolve_cli("node", search_from=target)
        if target.suffix.lower() in _JS_SUFFIXES and node:
            code, out = _run([*node, "--check", str(target.resolve())], timeout=timeout)
            if code == 0:
                return "javascript (node --check): No issues found."
            return f"javascript (node --check):\n{out or 'syntax error'}"
        return (
            f"{lang}: post-edit lint skipped project-wide tsc (too slow). "
            "Call read_lints on this file if you need full typecheck."
        )

    if lang == "typescript" and root:
        tsconfig = root / "tsconfig.json"
        if not tsconfig.is_file():
            found = _find_ancestor_with(target, ("tsconfig.json",))
            if found:
                root = found
                tsconfig = root / "tsconfig.json"
        if tsconfig.is_file():
            tsc_bin = _resolve_cli("tsc", search_from=target)
            npx = _resolve_cli("npx", search_from=target)
            if tsc_bin:
                cmd = [*tsc_bin, "--noEmit", "-p", str(tsconfig)]
            elif npx:
                cmd = [*npx, "--no-install", "tsc", "--noEmit", "-p", str(tsconfig)]
            else:
                cmd = []
            if not cmd:
                return f"{lang}: tsc not found (npm install typescript)"
            code, out = _run(cmd, cwd=root, timeout=max(_LINT_TIMEOUT, 90))
            if code == 0:
                return "typescript (tsc): No issues found."
            if code != 127:
                return f"typescript (tsc):\n{out or 'type errors reported'}"

    node = _resolve_cli("node", search_from=target)
    if target.suffix.lower() in _JS_SUFFIXES and node:
        code, out = _run([*node, "--check", str(target)])
        if code == 0:
            return "javascript (node --check): No issues found."
        return f"javascript (node --check):\n{out or 'syntax error'}"

    return f"{lang}: no eslint/biome/tsconfig found near file; install eslint or add tsconfig.json"


def _lint_java(target: Path) -> str:
    javac = _resolve_cli("javac", search_from=target)
    if not javac:
        return "java: javac not found (install JDK)"

    root = _find_ancestor_with(target, ("pom.xml", "build.gradle", "build.gradle.kts"))
    with tempfile.TemporaryDirectory(prefix="evoflow-javac-") as tmp:
        code, out = _run(
            [*javac, "-Xlint:all", "-encoding", "UTF-8", "-d", tmp, str(target.resolve())],
            cwd=root,
        )
    if code == 0:
        hint = f" (project root: {root})" if root else ""
        return f"java (javac -Xlint){hint}: No issues found."
    return f"java (javac -Xlint):\n{out or 'compile errors'}"


def lint_path(path: str | Path, *, post_edit: bool = False) -> str:
    """Run the best available linter for a single file. Returns human-readable summary."""
    p = Path(path).expanduser()
    if not p.exists():
        return f"Error: path does not exist: {path}"
    if p.is_dir():
        return _lint_directory(p)
    lang = language_for_path(p)
    if not lang:
        return lint_skip_message(p)
    if lang == "python":
        return _lint_python(p, post_edit=post_edit)
    if lang in ("javascript", "typescript"):
        return _lint_js_ts(p, post_edit=post_edit)
    if lang == "java":
        return _lint_java(p)
    return f"Error: no linter for {lang}"


def lint_path_post_edit(path: str | Path) -> str:
    """Fast, file-scoped lint after write/replace (no whole-repo tsc)."""
    return lint_path(path, post_edit=True)


def _lint_directory(directory: Path) -> str:
    """Lint all supported code files under directory (batch per language)."""
    files = [f for f in directory.rglob("*") if f.is_file() and is_lintable_code_path(f)]
    if not files:
        return f"No lintable code files under {directory}"
    by_lang: dict[str, list[Path]] = {}
    for f in files[:80]:
        lang = language_for_path(f) or "unknown"
        by_lang.setdefault(lang, []).append(f)
    parts: list[str] = []
    for lang, paths in sorted(by_lang.items()):
        if lang == "python":
            parts.append(_lint_python(directory))
            continue
        for fp in paths[:12]:
            parts.append(lint_path(fp))
    return "\n\n".join(parts)


def _thread_id_from_runtime(runtime: Any | None) -> str | None:
    if runtime is None:
        return None
    ctx = getattr(runtime, "context", None)
    if isinstance(ctx, dict):
        tid = ctx.get("thread_id")
        return str(tid).strip() if tid else None
    return None


def append_post_edit_lint(path: str, result: str, *, runtime: Any | None = None) -> str:
    """Append scheduler post-edit lint block (parallel read_lints UI rows + context)."""
    if not str(result or "").startswith("OK:"):
        return result
    if not _AUTO_AFTER_EDIT or not is_lintable_code_path(path):
        return result
    try:
        from evoflow.scheduler.post_edit_lint import follow_lint_after_edit

        block = follow_lint_after_edit(path, thread_id=_thread_id_from_runtime(runtime))
    except Exception as exc:
        logger.debug("post_edit lint scheduler failed for %s: %s", path, exc)
        block = ""
    if not block:
        return result
    return f"{result}\n\n{block}"
