#!/usr/bin/env python3
"""Pre-flight build validation for EvoFlow desktop builds.

Catches common issues before the expensive PyInstaller + Tauri build (60-90 min CI).
Runs in < 10 seconds with only stdlib dependencies.

Usage:
    cd backend && uv run python ../scripts/preflight-build-check.py

Environment variables (all default to "1" = enabled):
    CHECK_GATEWAY_ENTRY    gateway_entry.py static analysis
    CHECK_HIDDEN_IMPORTS   .spec hiddenimports reachability
    CHECK_GITIGNORE        gitignore cross-check
"""

from __future__ import annotations

import ast
import os
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
GATEWAY_ENTRY = REPO_ROOT / "backend" / "packaging" / "windows" / "gateway_entry.py"
GATEWAY_SPEC = REPO_ROOT / "backend" / "packaging" / "windows" / "gateway.spec"
HARNESS_ROOT = REPO_ROOT / "backend" / "packages" / "harness"
PACKAGES_ROOT = REPO_ROOT / "backend" / "packages"

RED = "\033[31m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
RESET = "\033[0m"

errors: list[str] = []
warnings: list[str] = []


def _e(msg: str) -> None:
    errors.append(msg)
    print(f"  {RED}FAIL{RESET}  {msg}")


def _w(msg: str) -> None:
    warnings.append(msg)
    print(f"  {YELLOW}WARN{RESET}  {msg}")


def _ok(msg: str) -> None:
    print(f"  {GREEN}OK{RESET}  {msg}")


# ---------------------------------------------------------------------------
# Check 1: gateway_entry.py static AST analysis
# ---------------------------------------------------------------------------


def check_gateway_entry() -> None:
    print(f"\n[{GREEN}1{RESET}] gateway_entry.py static analysis")

    if not GATEWAY_ENTRY.is_file():
        _e(f"gateway_entry.py not found at {GATEWAY_ENTRY}")
        return

    source = GATEWAY_ENTRY.read_text(encoding="utf-8")
    try:
        tree = ast.parse(source, filename=str(GATEWAY_ENTRY))
    except SyntaxError as exc:
        _e(f"Syntax error parsing gateway_entry.py: {exc}")
        return

    lines = source.splitlines()

    # Locate key nodes.
    atexit_line: int | None = None
    uvicorn_import_line: int | None = None
    no_color_assign_line: int | None = None
    prepare_stdio_func: ast.FunctionDef | None = None

    for node in ast.walk(tree):
        # atexit_done = True
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if (
                    isinstance(target, ast.Attribute)
                    and target.attr == "atexit_done"
                    and isinstance(node.value, ast.Constant)
                    and node.value.value is True
                ):
                    atexit_line = node.lineno

        # import uvicorn
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == "uvicorn":
                    uvicorn_import_line = node.lineno

        # os.environ["NO_COLOR"] = "1"
        if isinstance(node, ast.Assign):
            if (
                isinstance(node.targets[0], ast.Subscript)
                and isinstance(node.targets[0].value, ast.Attribute)
                and isinstance(node.targets[0].value.value, ast.Name)
                and node.targets[0].value.value.id == "os"
                and node.targets[0].value.attr == "environ"
                and isinstance(node.targets[0].slice, ast.Constant)
                and node.targets[0].slice.value == "NO_COLOR"
            ):
                no_color_assign_line = node.lineno

        # def _prepare_stdio_for_frozen
        if isinstance(node, ast.FunctionDef) and node.name == "_prepare_stdio_for_frozen":
            prepare_stdio_func = node

    # Assertion 1: atexit_done is set before import uvicorn
    if atexit_line is None:
        _e("Missing 'colorama.initialise.atexit_done = True' assignment")
    elif uvicorn_import_line is None:
        _e("Missing 'import uvicorn' statement")
    elif atexit_line > uvicorn_import_line:
        _e(
            f"colorama atexit_done (line {atexit_line}) must be set BEFORE "
            f"import uvicorn (line {uvicorn_import_line})"
        )
    else:
        _ok(f"atexit_done (line {atexit_line}) before import uvicorn (line {uvicorn_import_line})")

    # Assertion 2: NO_COLOR is forced assignment, not setdefault
    if no_color_assign_line is None:
        _e("Missing 'os.environ[\"NO_COLOR\"] = \"1\"' forced assignment (line 18)")
    else:
        line_text = lines[no_color_assign_line - 1].strip()
        if "setdefault" in line_text:
            _e(
                f"NO_COLOR uses setdefault (line {no_color_assign_line}), "
                "must use forced assignment 'os.environ[\"NO_COLOR\"] = \"1\"'"
            )
        else:
            _ok(f"NO_COLOR forced assignment (line {no_color_assign_line})")

    # Assertion 3: frozen stdio bootstrap runs before import uvicorn
    prepare_frozen_call_lines: list[int] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Name) and func.id == "prepare_frozen_process_stdio":
            prepare_frozen_call_lines.append(node.lineno)
        elif isinstance(func, ast.Attribute) and func.attr == "prepare_frozen_process_stdio":
            prepare_frozen_call_lines.append(node.lineno)

    early_prepare_line: int | None = None
    if uvicorn_import_line is not None:
        before_uvicorn = [ln for ln in prepare_frozen_call_lines if ln < uvicorn_import_line]
        early_prepare_line = min(before_uvicorn) if before_uvicorn else None
    elif prepare_frozen_call_lines:
        early_prepare_line = min(prepare_frozen_call_lines)

    if prepare_stdio_func is None:
        _e("Missing '_prepare_stdio_for_frozen' function definition")
    elif early_prepare_line is None:
        _e(
            "Missing prepare_frozen_process_stdio() call before import uvicorn in gateway_entry.py"
        )
    else:
        _ok(
            f"prepare_frozen_process_stdio() (line {early_prepare_line}) "
            f"before import uvicorn (line {uvicorn_import_line})"
        )

    # Assertion 4: FORCE_COLOR = "0" is also forced
    force_color_line: int | None = None
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            if (
                isinstance(node.targets[0], ast.Subscript)
                and isinstance(node.targets[0].value, ast.Attribute)
                and isinstance(node.targets[0].value.value, ast.Name)
                and node.targets[0].value.value.id == "os"
                and node.targets[0].value.attr == "environ"
                and isinstance(node.targets[0].slice, ast.Constant)
                and node.targets[0].slice.value == "FORCE_COLOR"
            ):
                force_color_line = node.lineno
    if force_color_line is None:
        _e("Missing 'os.environ[\"FORCE_COLOR\"] = \"0\"' forced assignment")
    else:
        _ok(f"FORCE_COLOR forced assignment (line {force_color_line})")


# ---------------------------------------------------------------------------
# Check 2: .spec hiddenimports reachability
# ---------------------------------------------------------------------------


def check_hidden_imports() -> None:
    print(f"\n[{GREEN}2{RESET}] .spec hiddenimports reachability")

    if not GATEWAY_SPEC.is_file():
        _e(f"gateway.spec not found at {GATEWAY_SPEC}")
        return

    spec_text = GATEWAY_SPEC.read_text(encoding="utf-8")

    # Extract _filesystem_submodules() calls: find the second positional argument.
    # Exclude the function definition (def _filesystem_submodules(...)).
    pattern = re.compile(
        r"(?<!def )_filesystem_submodules\s*\([^,]+,\s*(.+?)\)"
    )
    matches = pattern.findall(spec_text)

    if not matches:
        _w("No _filesystem_submodules() calls found in .spec (may be intentional)")
        return

    for expr in matches:
        expr = expr.strip()
        # Resolve simple path expressions.
        path = _resolve_spec_path(expr)
        if path is None:
            _w(f"Cannot resolve path expression: {expr[:60]}...")
            continue
        if not path.is_dir():
            _e(f"Filesystem submodules path does not exist: {path}")
            continue

        # Scan .py files and check gitignore.
        py_files = sorted(path.rglob("*.py"))
        ignored = []
        for pyf in py_files:
            if pyf.name == "__init__.py":
                continue
            if _is_git_ignored(pyf):
                ignored.append(pyf)

        if ignored:
            for f in ignored:
                _e(
                    f"Module excluded by .gitignore: {f.relative_to(REPO_ROOT)} — "
                    "will be MISSING from PyInstaller bundle"
                )
        else:
            _ok(f"{len(py_files)} files in {path.relative_to(REPO_ROOT)} — all trackable")


def _resolve_spec_path(expr: str) -> Path | None:
    """Resolve a .spec file path expression to an absolute Path."""
    # Handle: harness_root / "evoflow" / "agents" / "middlewares"
    expr = expr.strip().rstrip(")")
    # Try common variable names.
    root_map = {
        "harness_root": HARNESS_ROOT,
        "backend_root": REPO_ROOT / "backend",
        "spec_dir": REPO_ROOT / "backend" / "packaging" / "windows",
    }
    for var, root in root_map.items():
        if expr.startswith(var):
            rest = expr[len(var) :].strip()
            if rest.startswith("/"):
                rest = rest[1:]
            parts = []
            for token in re.findall(r'"([^"]*)"', rest):
                parts.append(token)
            if parts:
                return root.joinpath(*parts)
            return root

    # Handle: _harness_evoflow / "agents" / "middlewares"
    var_map = {
        "_harness_evoflow": HARNESS_ROOT / "evoflow",
    }
    for var, root in var_map.items():
        if expr.startswith(var):
            rest = expr[len(var) :].strip()
            parts = []
            for token in re.findall(r'"([^"]*)"', rest):
                parts.append(token)
            if parts:
                return root.joinpath(*parts)
            return root

    # Handle raw string path.
    raw_match = re.match(r'^"([^"]+)"', expr)
    if raw_match:
        p = Path(raw_match.group(1))
        if p.is_absolute():
            return p
        return REPO_ROOT / "backend" / p

    return None


# ---------------------------------------------------------------------------
# Check 3: gitignore cross-check
# ---------------------------------------------------------------------------


def check_gitignore_cross() -> None:
    print(f"\n[{GREEN}3{RESET}] gitignore cross-check for backend/packages/")

    if not PACKAGES_ROOT.is_dir():
        _e(f"backend/packages/ not found at {PACKAGES_ROOT}")
        return

    py_files = sorted(PACKAGES_ROOT.rglob("*.py"))
    ignored = []
    for pyf in py_files:
        if _is_git_ignored(pyf):
            ignored.append(pyf)

    if ignored:
        for f in ignored:
            _e(
                f"Source file excluded by .gitignore: {f.relative_to(REPO_ROOT)} — "
                "will be MISSING from PyInstaller bundle"
            )
    else:
        _ok(f"All {len(py_files)} .py files in backend/packages/ are trackable")


def _is_git_ignored(path: Path) -> bool:
    """Check if a file is ignored by .gitignore (uses git check-ignore)."""
    try:
        result = subprocess.run(
            ["git", "check-ignore", "-q", str(path)],
            cwd=REPO_ROOT,
            capture_output=True,
            timeout=10,
        )
        return result.returncode == 0
    except (subprocess.SubprocessError, FileNotFoundError):
        # If git is not available, skip.
        return False


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    check_map = {
        "CHECK_GATEWAY_ENTRY": (check_gateway_entry, True),
        "CHECK_HIDDEN_IMPORTS": (check_hidden_imports, True),
        "CHECK_GITIGNORE": (check_gitignore_cross, True),
    }

    total = 0
    for env_key, (func, default) in check_map.items():
        enabled = os.environ.get(env_key, str(int(default)))
        if enabled.strip() in ("1", "true", "TRUE", "yes"):
            func()
            total += 1

    print()
    print(f"Results: {len(errors)} errors, {len(warnings)} warnings across {total} checks")

    for w in warnings:
        print(f"  {YELLOW}WARN{RESET}  {w}")

    if errors:
        sys.exit(1)

    print(f"{GREEN}All checks passed.{RESET}")


if __name__ == "__main__":
    main()