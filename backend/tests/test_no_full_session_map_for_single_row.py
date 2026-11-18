"""门禁：禁止 `load_session_map().get(k)` 这种「为取一行而重建全表」的写法回潮。

【self-evolution-bot · 2026-11-18 · 第52轮 · 模型:deepseek-v4.1-flash-1017】

为什么必须有这条：
`load_session_map()` 会 SELECT 全部会话行并逐行 `_session_row_to_api`
（重建 effective_policy / preset / context）。本机 550 个会话实测
**冷 5963.9ms / 热 124ms**，而 `get_session_map_entry(key)` 单行稳态 **0.017ms**
——差 4~5 个数量级。它曾被 9 个调用点当成「按 key 取一行」用，其中
`/ensure-thread` 是每次发消息的热路径（实测 2023~3927ms）。

为什么用 AST 而不是 grep：
本仓多处注释与 docstring 里**故意**写着 `load_session_map()` 来解释历史原因
（如 session_repositories / summaries / 本测试自己）。正则会把注释当成调用，
于是「注释里提一句」就能让门禁假绿或假红。AST 只看真实调用节点。

判据：源码里出现 `<...>.load_session_map(...)` 之后再接属性/下标取值（`.get`
/ `[k]`），即视为拿全表当单行用 —— 必须改用 `get_session_map_entry` /
`get_session_row_brief` / `get_proactive_round_id`。

白名单：只有「确实要整张表」的场景可豁免（EvoPanel 侧栏同步等）。
"""

from __future__ import annotations

import ast
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1]

# 只扫描生产代码；tests 里要引用旧函数做反证，不参与本门禁。
_SCAN_ROOTS = ("app", "packages")
_SKIP_PARTS = {"tests", "test", "__pycache__", ".venv", "node_modules"}

# 确实需要整张表、且已被人工确认的调用点（相对 backend 的 posix 路径）。
_ALLOWED = {
    # 目前无豁免项：侧栏同步走前端 loadSessionMap / merge_session_map，
    # 服务端没有「整表返回」的热路径调用。
}


def _is_load_session_map_call(node: ast.AST) -> bool:
    """识别 `...load_session_map` 的**引用**（含带括号调用与裸引用两种形态）。

    裸引用是必须支持的：`(await run_db(sess_repo.load_session_map) or {}).get(k)`
    解包 `run_db` 后拿到的是无括号的 `Attribute`，只认 `ast.Call` 会整条漏过。
    """
    if isinstance(node, ast.Call):
        node = node.func
    if isinstance(node, ast.Attribute):
        return node.attr == "load_session_map"
    if isinstance(node, ast.Name):
        return node.id == "load_session_map"
    return False


def _unwrap_awaits(node: ast.AST) -> ast.AST:
    """剥掉 await / to_thread 包装，找到最终被取值的表达式。

    `(await asyncio.to_thread(sess_repo.load_session_map)).get(k)`
    与 `run_db(sess_repo.load_session_map).get(k)` 都要能识别。
    """
    while True:
        if isinstance(node, ast.Await):
            node = node.value
            continue
        # `(await run_db(fn) or {}).get(k)` —— `or {}` 让被取值的对象变成 BoolOp，
        # 必须剥到最左边的值，否则这条真实写法会整条漏过（第52轮反证抓到）。
        if isinstance(node, ast.BoolOp) and node.values:
            node = node.values[0]
            continue
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            # asyncio.to_thread(fn, ...) / run_db(fn, ...) -> 取被转发的函数
            if node.func.attr in {"to_thread", "run_db", "to_thread_sync"} and node.args:
                node = node.args[0]
                continue
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            if node.func.id in {"run_db", "to_thread"} and node.args:
                node = node.args[0]
                continue
        return node


def _find_offenders(tree: ast.AST) -> list[int]:
    hits: list[int] = []
    for node in ast.walk(tree):
        # 形式一：load_session_map(...).get(k)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            if node.func.attr == "get":
                inner = _unwrap_awaits(node.func.value)
                if _is_load_session_map_call(inner):
                    hits.append(node.lineno)
        # 形式二：load_session_map(...)[k]
        if isinstance(node, ast.Subscript):
            inner = _unwrap_awaits(node.value)
            if _is_load_session_map_call(inner):
                hits.append(node.lineno)
    return sorted(set(hits))


def test_no_full_session_map_used_as_single_row() -> None:
    offenders: list[str] = []
    for root in _SCAN_ROOTS:
        base = _BACKEND / root
        if not base.exists():
            continue
        for path in base.rglob("*.py"):
            if _SKIP_PARTS & set(path.parts):
                continue
            rel = path.relative_to(_BACKEND).as_posix()
            if rel in _ALLOWED:
                continue
            try:
                tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
            except SyntaxError:  # 语法错不归本门禁管
                continue
            for lineno in _find_offenders(tree):
                offenders.append(f"{rel}:{lineno}")
    assert not offenders, (
        "以下位置仍在用 load_session_map() 取单行（为一行重建全部会话行，"
        "实测冷 5963.9ms vs 单行 0.017ms）。请改用 get_session_map_entry(key) /\n"
        + "\n".join(f"  - {o}" for o in offenders)
    )


def test_detector_catches_known_bad_shapes() -> None:
    """反证：识别器必须能抓到四种真实写法，否则上一条门禁是假绿。

    本仓这 9 个调用点当年就是这么写的（含 await / to_thread / run_db 三种包装）。
    """
    bad_sources = [
        "row = sess_repo.load_session_map().get(sk) or {}\n",
        "row = (await run_db(sess_repo.load_session_map) or {}).get(key) or {}\n",
        "row = (await asyncio.to_thread(sess_repo.load_session_map)).get(k) or {}\n",
        "row = sess_repo.load_session_map()[sk]\n",
    ]
    for src in bad_sources:
        assert _find_offenders(ast.parse(src)), f"识别器漏掉了这种写法: {src!r}"


def test_detector_ignores_comments_and_docstrings() -> None:
    """反证：注释/docstring 里提 load_session_map 不算违规。

    这条正是「用 grep 做门禁」会踩的坑——本仓注释里大量出现该函数名。
    """
    src = (
        '"""旧实现走 load_session_map().get(sk)，见 # 注释。"""\n'
        "# row = sess_repo.load_session_map().get(sk)\n"
        "row = sess_repo.get_session_map_entry(sk)\n"
        "# 别再用 load_session_map() 取单行\n"
    )
    assert _find_offenders(ast.parse(src)) == []


def test_whole_map_is_still_allowed() -> None:
    """整表取值（不接 .get/下标）不应被门禁误伤。"""
    src = "m = sess_repo.load_session_map()\n"
    assert _find_offenders(ast.parse(src)) == []
