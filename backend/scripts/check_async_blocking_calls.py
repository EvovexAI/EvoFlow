"""Async blocking-call guard: keep blocking I/O off the Gateway event loop.

Rule: inside ``async def`` bodies (nested ``def``/``async def`` bodies excluded —
they may legitimately run in a worker thread), calls that block the loop on FS /
sync HTTP / subprocess / time.sleep are violations. The baseline of known
violations lives in backend/scripts/async_blocking_calls_baseline.txt and may
only shrink; a violation line can also carry an inline waiver:

    await to_thread(read_config)          # ok
    cfg = open(path)  # async-block-ok: <reason>   # waived, prefer to_thread

Usage:
    python backend/scripts/check_async_blocking_calls.py            # enforce
    python backend/scripts/check_async_blocking_calls.py --update   # regenerate baseline
    python backend/scripts/check_async_blocking_calls.py --scan     # print all hits

背景：2026-10-26/27 三轮审计确认「同步阻塞调用跑在 Gateway 主事件循环上」
是整系统间歇性卡死（资产/技能扫描冻结全网关、TTS 120s 冻结、读池无限排队）
的共同模式；同类问题已全部 to_thread 化，本脚本防止回归。
"""

from __future__ import annotations

import argparse
import ast
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
SCAN_ROOT = BACKEND_ROOT / "app"
BASELINE = BACKEND_ROOT / "scripts" / "async_blocking_calls_baseline.txt"

# 整名调用（ast.Name -> func）：from-import 后的裸名阻塞调用（高置信度）。
_BARE_NAME_BLOCKERS = {"sleep", "open", "urlopen", "rmtree"}
_BLOCKING_ATTRS_BY_MODULE = {
    "os": {
        "walk", "listdir", "scandir", "remove", "unlink", "rename", "replace",
        "makedirs", "stat", "lstat", "truncate",
    },
    "os.path": {"getsize", "getmtime", "exists", "isdir", "isfile"},
    "shutil": {"rmtree", "copytree", "copy", "copy2", "move", "make_archive", "unpack_archive"},
    "subprocess": {"run", "call", "check_call", "check_output", "Popen"},
    "requests": {"get", "post", "put", "patch", "delete", "head", "options", "request"},
    "httpx": {"get", "post", "put", "patch", "delete", "head", "options", "request", "stream"},
    "tarfile": {"open", "extractall"},
    "zipfile": {"ZipFile"},
    "socket": {"create_connection", "getaddrinfo", "gethostbyname"},
}
# 任意接收者上的方法名：pathlib/文件对象/压缩包的高成本同步成员。
# mkdir/unlink/stat 等微秒级操作判良性不列入（见 docs/design 4.2 白名单约定）。
_BLOCKING_METHODS = {
    "read_text", "read_bytes", "write_text", "write_bytes",
    "iterdir", "rglob", "glob",
    "extractall", "extract",
}
_WAIVER_MARK = "async-block-ok"


def _iter_calls_in_async_bodies(tree: ast.AST):
    """Yield (asyncdef, call) for every Call inside an async def body,
    excluding bodies of functions nested within it."""
    for node in ast.walk(tree):
        if not isinstance(node, (ast.AsyncFunctionDef,)):
            continue
        # 手动遍历：进入 async def 本体，但遇到嵌套函数即剪枝。
        stack = list(ast.iter_child_nodes(node))
        while stack:
            child = stack.pop()
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
                continue
            if isinstance(child, ast.Call):
                yield node, child
            stack.extend(ast.iter_child_nodes(child))


def _call_label(call: ast.Call) -> str | None:
    """Return 'os.walk' / 'Path.read_bytes' / 'sleep' style label, or None."""
    func = call.func
    if isinstance(func, ast.Name):
        name = func.id
        if name in _BARE_NAME_BLOCKERS:
            return name
        return None
    if isinstance(func, ast.Attribute):
        attr = func.attr
        value = func.value
        if isinstance(value, ast.Name):
            mod = value.id
            if mod in _BLOCKING_ATTRS_BY_MODULE and attr in _BLOCKING_ATTRS_BY_MODULE[mod]:
                return f"{mod}.{attr}"
            # from os import walk -> 裸名 walk；维护成本高，交由基线兜底：
            if attr in _BLOCKING_METHODS:
                return f"*.{attr}"
            if mod in {"time"} and attr == "sleep":
                return "time.sleep"
            return None
        if isinstance(value, ast.Attribute) and isinstance(value.value, ast.Name):
            mod = f"{value.value.id}.{value.attr}"  # os.path.exists / urllib.request.urlopen
            if mod in _BLOCKING_ATTRS_BY_MODULE and attr in _BLOCKING_ATTRS_BY_MODULE[mod]:
                return f"{mod}.{attr}"
            return None
        if attr in _BLOCKING_METHODS:
            return f"*.{attr}"
    return None


def _waived(source_lines: list[str], lineno: int) -> bool:
    if lineno - 1 >= len(source_lines):
        return False
    return _WAIVER_MARK in source_lines[lineno - 1]


def scan() -> list[str]:
    hits: list[str] = []
    for path in sorted(SCAN_ROOT.rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        try:
            src = path.read_text(encoding="utf-8")
            tree = ast.parse(src)
        except (OSError, SyntaxError, UnicodeDecodeError):
            continue
        lines = src.splitlines()
        rel = path.relative_to(BACKEND_ROOT).as_posix()
        for _adef, call in _iter_calls_in_async_bodies(tree):
            label = _call_label(call)
            if label is None:
                continue
            lineno = call.lineno
            if _waived(lines, lineno):
                continue
            hits.append(f"{rel}:{lineno}: {label}")
    return hits


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--update", action="store_true", help="Regenerate baseline from current state.")
    parser.add_argument("--scan", action="store_true", help="Print all current hits and exit.")
    args = parser.parse_args()

    current = scan()
    if args.scan:
        for hit in current:
            print(hit)
        print(f"-- {len(current)} hit(s) in {SCAN_ROOT}")
        return 0
    if args.update:
        BASELINE.write_text(
            "# Baseline for check_async_blocking_calls (blocking calls inside async def).\n"
            "# This list may only shrink. Prefer asyncio.to_thread; inline waivers\n"
            f"# use the '{_WAIVER_MARK}: <reason>' comment.\n"
            + "\n".join(current)
            + ("\n" if current else ""),
            encoding="utf-8",
        )
        print(f"baseline updated: {len(current)} entries -> {BASELINE}")
        return 0

    baseline = set(_load_baseline())
    new = [v for v in current if v not in baseline]
    if new:
        print("FAIL: blocking calls inside async def will stall the Gateway event loop.")
        print(f"Found {len(new)} NEW violation(s) not covered by the baseline:")
        for v in new:
            print(f"  {v}")
        print()
        print("Fix: move the work off the loop (asyncio.to_thread / streaming response),")
        print("or add an inline waiver '# async-block-ok: <reason>' if provably cheap.")
        return 1
    fixed = baseline - set(current)
    if fixed:
        print(f"OK: {len(current)} baseline violation(s) remain; {len(fixed)} resolved —")
        print("shrink the baseline via: python backend/scripts/check_async_blocking_calls.py --update")
    else:
        print(f"OK: no new blocking-call violations ({len(current)} covered by baseline).")
    return 0


def _load_baseline() -> list[str]:
    if not BASELINE.exists():
        return []
    return [
        ln.strip()
        for ln in BASELINE.read_text(encoding="utf-8").splitlines()
        if ln.strip() and not ln.startswith("#")
    ]


if __name__ == "__main__":
    sys.exit(main())
