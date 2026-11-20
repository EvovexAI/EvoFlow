"""回归：execution_bridge._run_langgraph 不能因函数内 import 把 asyncio 变成局部名。

【self-evolution-bot · 2026-11-20 · 第98轮 · 模型:deepseek-v4.1-flash-1017】
为什么加这条：2026-11-20 18:26:45 现网堆栈

    File ".../evoflow/proactive/execution_bridge.py", line 209, in _run_langgraph
        await asyncio.to_thread(
    UnboundLocalError: cannot access local variable 'asyncio'

根因是函数体后半段有两处 `import asyncio`，Python 因此把 asyncio 判成整个函数的
局部名，前半段第一次使用就取不到值。结果是「唤醒派发」每次都抛异常、任务
刚落库就结案（summary 就是这句 UnboundLocalError），用户看到的就是"叫醒了但没干活"。

判据选择：不测"函数里有几处 import"（那是形态，换个写法就误报），而是用
stdlib AST 判断「函数体内是否存在对 asyncio 的 Import 节点」——这正是触发
UnboundLocalError 的充分条件。反向验证：把 import 加回去必须变红。
"""

from __future__ import annotations

import ast
from pathlib import Path

SRC = (
    Path(__file__).resolve().parents[1]
    / "packages"
    / "harness"
    / "evoflow"
    / "proactive"
    / "execution_bridge.py"
)


def _function_ast(src: str, name: str) -> ast.AST:
    tree = ast.parse(src)
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            return node
    raise AssertionError(f"函数 {name} 未找到（源码结构变了，请更新本测试的定位方式）")


def _shadowing_imports(fn: ast.AST, name: str) -> list[int]:
    """返回函数体内 import <name> 的行号列表。"""
    hits: list[int] = []
    for node in ast.walk(fn):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == name or alias.name.startswith(name + "."):
                    hits.append(node.lineno)
        elif isinstance(node, ast.ImportFrom) and node.module == name:
            hits.append(node.lineno)
    return hits


def test_run_langgraph_does_not_shadow_asyncio():
    fn = _function_ast(SRC.read_text(encoding="utf-8"), "_run_langgraph")
    hits = _shadowing_imports(fn, "asyncio")
    assert hits == [], (
        "_run_langgraph 内出现局部 import asyncio（行 "
        f"{hits}），会让整个函数里的 asyncio 变成局部名，"
        "前面的 await asyncio.to_thread(...) 必然抛 UnboundLocalError"
    )


def test_wait_for_run_does_not_shadow_asyncio():
    fn = _function_ast(SRC.read_text(encoding="utf-8"), "_wait_for_run")
    hits = _shadowing_imports(fn, "asyncio")
    assert hits == [], (
        f"_wait_for_run 内出现局部 import asyncio（行 {hits}），同上风险"
    )


def test_module_level_asyncio_import_present():
    """模块顶部必须还留着 import asyncio，否则删函数内那两处会把运行路径弄断。"""
    src = SRC.read_text(encoding="utf-8")
    tree = ast.parse(src)
    top_level = [
        node
        for node in tree.body
        if isinstance(node, ast.Import)
        for alias in node.names
        if alias.name == "asyncio"
    ]
    assert top_level, "模块顶部缺少 import asyncio"
