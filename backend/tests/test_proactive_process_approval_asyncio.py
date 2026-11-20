"""审批端点回归防护：process_approval 不得在函数作用域内 ``import asyncio``。

背景（2026-11-18 线上故障）：
    ``process_approval`` 内部的条件分支写了 ``import asyncio``（task/initiative
    两条后台执行分支），Python 会把 ``asyncio`` 视为整个函数的局部名——分支尚未
    执行时，函数前部 ``await asyncio.to_thread(...)`` 直接抛
    ``UnboundLocalError``，端点 500。前端只看到 CORS 被拒的
    ``TypeError: Failed to fetch``，极难排查。

规则：函数内使用模块级 ``asyncio`` 时，禁止再写函数级 ``import asyncio``。
"""

from __future__ import annotations

import ast
import inspect

from evoflow.proactive import router


def _local_asyncio_imports(func) -> list[int]:
    """找出函数体内（含 if/for/try 分支，不含嵌套函数/类）直接绑定的 import asyncio 行号。"""
    tree = ast.parse(inspect.getsource(func))
    fn = next(n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)))
    hits: list[int] = []
    skip = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)
    stack = list(ast.iter_child_nodes(fn))
    while stack:
        node = stack.pop()
        if isinstance(node, skip):
            continue
        if isinstance(node, ast.Import) and any(a.name == "asyncio" for a in node.names):
            hits.append(node.lineno)  # 相对源码片段的行号，仅用于报错提示
        stack.extend(ast.iter_child_nodes(node))
    return hits


def test_process_approval_does_not_shadow_asyncio():
    hits = _local_asyncio_imports(router.process_approval)
    assert not hits, (
        f"process_approval 函数内存在 import asyncio（行 {hits}），会把 asyncio 变成"
        "整个函数的局部名，分支未执行时前面的 await asyncio.to_thread(...) 抛 "
        "UnboundLocalError。请删除函数内 import，直接使用模块级导入。"
    )
