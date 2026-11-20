"""回归：函数体内「先使用、后 import 同名」必崩（UnboundLocalError），全仓防复发。

【self-evolution-bot · 2026-11-20 · 第98轮 · 模型:deepseek-v4.1-flash-1017】

为什么加这条：2026-11-20 18:26:45 现网堆栈

    File ".../evoflow/proactive/execution_bridge.py", line 209, in _run_langgraph
        await asyncio.to_thread(
    UnboundLocalError: cannot access local variable 'asyncio'

同一函数体后半段有一句 `import asyncio`。Python 编译期看到函数内任何 `import asyncio`
就把 asyncio 判成**整个函数的局部名**，前半段第一次使用就取不到值。后果不是"少个功能"，
是整条链路每次都崩：唤醒派发刚落库就结案，summary 正是这句 UnboundLocalError ——
用户看到的就是"叫醒了但没干活"。

同型第二处（本轮一并修）：`app/channels/manager.py` `_handle_wait_chat_body` 第 3315 行
`import asyncio`，使第 3232 行 thread-busy 退避重试 `await asyncio.sleep(0.35)` 必崩。

## 判据（以及一次真实的判据自撞）
第一版我用 `ast.walk(fn)` 收集函数体内的 import，结果扫出 200 多处"必崩"，其中包含
`langgraph_route_logger.py` 这类长期正常运行的模块 —— 说明判据错，不是代码错。
根因：`ast.walk` 会走进**嵌套函数**，把内层 `def` 里的 import 错算到外层函数头上。
改正：只遍历函数**自身语句块**，遇到嵌套 `FunctionDef/AsyncFunctionDef/Lambda/ClassDef`
就停，不进其内部（内层是独立作用域，它自己的遮蔽由它自己那一轮检查）。
修正后全仓 = 0 处（那两处真缺陷已修）。

反向验证（改这条测试必做）：把任一函数的模块级 import 复制一行到函数体末尾，
本测试必须变红；恢复后必须全绿。另附两条自检用例，保证扫描器两边都不瞎。
"""

from __future__ import annotations

import ast
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]

# 只扫生产代码；tests 里故意写坏代码做反证的场景不该被这条规则管
SCAN_ROOTS = [
    BACKEND / "app",
    BACKEND / "packages" / "harness" / "evoflow",
]


def _iter_py_files() -> list[Path]:
    files: list[Path] = []
    for root in SCAN_ROOTS:
        if root.is_dir():
            files.extend(sorted(root.rglob("*.py")))
    return files


def _own_scope_nodes(fn: ast.AST):
    """遍历函数**自身作用域**的节点，不进嵌套函数/类（那是独立作用域）。

    这是本判据的关键：第一版用 ast.walk 走进了嵌套函数，把内层 import 算到外层，
    扫出 200 多处假的"必崩"，连长期正常运行的模块也被判红。
    """
    stack = list(ast.iter_child_nodes(fn))
    while stack:
        node = stack.pop()
        yield node
        if isinstance(
            node,
            (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef),
        ):
            continue  # 独立作用域：停在这里，不进内部
        stack.extend(ast.iter_child_nodes(node))


def _annotation_node_ids(tree: ast.AST) -> set[int]:
    """收集所有**注解位置**的节点 id（含函数签名、变量/参数注解）。

    为什么要排除：第一版把注解读成了"使用"，于是
        def _goal_channel_type(self, channel_name: str) -> GoalChannelType:
            from app.channels.models.goal import GoalChannelType
    这种「签名用 Name、函数体 import」被报成必崩。而本仓文件普遍带
    `from __future__ import annotations`（PEP 563，注解按字符串惰性求值、不解析名字），
    即便没有它，注解报错是**导入期**报错而非运行期 UnboundLocalError，
    与这里要抓的"函数内 import 遮蔽"是两回事。故一律排除。
    """
    ids: set[int] = set()
    for node in ast.walk(tree):
        for attr in ("annotation", "returns"):
            ann = getattr(node, attr, None)
            if isinstance(ann, ast.AST):
                for sub in ast.walk(ann):
                    ids.add(id(sub))
    return ids


def _imported_names_in_body(fn: ast.AST) -> dict[str, int]:
    """函数自身作用域内 import 出来的名字 → 该 import 的行号。"""
    out: dict[str, int] = {}
    for node in _own_scope_nodes(fn):
        if isinstance(node, ast.Import):
            for alias in node.names:
                name = alias.asname or alias.name.split(".")[0]
                out[name] = node.lineno
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.name == "*":
                    continue
                out[alias.asname or alias.name] = node.lineno
    return out


def _loads_with_lines(fn: ast.AST, skip_ids: set[int]) -> list[tuple[str, int]]:
    """函数自身作用域内所有「读取某个名字」的位置（排除注解位置）。"""
    loads: list[tuple[str, int]] = []
    for node in _own_scope_nodes(fn):
        if id(node) in skip_ids:
            continue
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
            loads.append((node.id, node.lineno))
    return loads


def _shadowing_in_function(fn: ast.AST, skip_ids: set[int] | None = None) -> list[tuple[str, int, int]]:
    """返回 (名字, 使用行, import 行) —— 仅「先读后 import」。"""
    imported = _imported_names_in_body(fn)
    if not imported:
        return []
    skip = skip_ids or set()
    hits: list[tuple[str, int, int]] = []
    for name, load_line in _loads_with_lines(fn, skip):
        import_line = imported.get(name)
        if import_line is not None and load_line < import_line:
            hits.append((name, load_line, import_line))
    return hits


def _find_shadowing(path: Path) -> list[str]:
    try:
        src = path.read_text(encoding="utf-8")
        tree = ast.parse(src)
    except (SyntaxError, UnicodeDecodeError):
        return []

    skip_ids = _annotation_node_ids(tree)
    problems: list[str] = []
    for fn in ast.walk(tree):
        if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for name, load_line, import_line in _shadowing_in_function(fn, skip_ids):
            rel = path.relative_to(BACKEND).as_posix()
            problems.append(
                f"{rel}:{load_line} 使用 `{name}`，但同一函数第 {import_line} 行才 "
                f"`import {name}` → 该名字在整个函数内是局部名，此行必抛 UnboundLocalError"
            )
    return problems


def test_no_local_import_shadows_earlier_use() -> None:
    files = _iter_py_files()
    assert files, "没扫到任何 py 文件，扫描根路径写错了"

    problems: list[str] = []
    for path in files:
        problems.extend(_find_shadowing(path))

    assert not problems, (
        f"发现 {len(problems)} 处函数内局部 import 遮蔽同名先使用（必崩，非风格问题）：\n  "
        + "\n  ".join(problems)
    )


def test_scanner_detects_known_bad_shape() -> None:
    """自检：喂必然崩的形态必须报出来，否则上面那条是假绿。"""
    bad = ast.parse(
        "import asyncio\n"
        "async def f():\n"
        "    await asyncio.sleep(1)\n"
        "    import asyncio\n"
        "    return 1\n"
    )
    fn = next(n for n in ast.walk(bad) if isinstance(n, ast.AsyncFunctionDef))
    hits = _shadowing_in_function(fn)
    assert [h[0] for h in hits] == ["asyncio"], (
        f"自检失败：扫描器没能识别已知坏形态（hits={hits}）"
    )


def test_scanner_ignores_nested_function_imports() -> None:
    """反证：嵌套函数里的 import 属独立作用域，不许算到外层头上。

    这条是本轮判据自撞后补的：第一版用 ast.walk 走进嵌套函数，把
    `langgraph_route_logger.py` 等长期正常运行的模块扫成"必崩"，200 多假红。
    """
    src = (
        "def outer():\n"
        "    helper()\n"
        "    def inner():\n"
        "        import helper\n"
        "        return helper\n"
        "    return inner\n"
    )
    tree = ast.parse(src)
    outer = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "outer")
    hits = _shadowing_in_function(outer)
    assert hits == [], f"误报：把嵌套函数的 import 算到了外层函数（hits={hits}）"


def test_scanner_accepts_import_then_use() -> None:
    """反证另一侧：先 import 后使用是合法的，不许误报。"""
    good = ast.parse(
        "async def f():\n"
        "    import asyncio\n"
        "    await asyncio.sleep(1)\n"
    )
    fn = next(n for n in ast.walk(good) if isinstance(n, ast.AsyncFunctionDef))
    assert _shadowing_in_function(fn) == [], "误报：先 import 后使用被判成遮蔽"
