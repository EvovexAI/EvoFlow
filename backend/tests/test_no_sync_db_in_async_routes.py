"""async 路由里不许同步调 DB —— 会把整个事件循环按死。

【self-evolution-bot · 2026-11-20 · 第70轮 · 模型:deepseek-v4.1-flash-1017】

现网实证（2026-11-20 07:32:32）：`GET /api/knowledge/owned/bases` 耗时 **7709ms**
（正常 47ms），慢日志同时记 `lag_s=8.109` —— 事件循环真被按住 8 秒，
期间所有端点一起慢。根因：`knowledge_owned.py` 里 63 处 `async def` 路由
**同步**调 `owned_service.*`（SQLite 直查）。

同类第二例：后台 `run_deferred_full_preflight` 用 `asyncio.to_thread`（默认池）
跑 3 个库的全量 integrity_check（5 分 14 秒），把同池的
`/api/tasks`（10s→503）与 `/api/mcp/config`（26s）饿死。

所以判据不是「这个端点快不快」，而是**同步阻塞调用有没有出现在 async 路径上**。
本测试静态扫描，命中即红，改法只有两种：
  - 用 `run_db(...)`（专用池 `evoflow-db`）包起来
  - 或把该端点改成 `def`（FastAPI 会自动丢线程池）
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

APP = Path(__file__).resolve().parents[1] / "app" / "gateway"

# 允许出现在 async 里的已知纯内存调用（不碰 SQLite / 文件 IO）。
_ALLOWED_SYNC_CALLS = {
    "model_dump",
    "dict",
    "str",
    "int",
    "bool",
    "len",
    "sorted",
    "list",
    "print",
    "get",
    "set",
    "append",
    "format",
    "join",
    "strip",
    "split",
}


def _is_sync_blocking_call(node: ast.Call) -> str | None:
    """返回被同步调用的名字（形如 ``x.y``），非阻塞返回 None。"""
    func = node.func
    if isinstance(func, ast.Attribute):
        name = func.attr
        base = func.value
        base_name = getattr(base, "id", None) or getattr(base, "attr", "") or ""
        full = f"{base_name}.{name}" if base_name else name
        # `asyncio.to_thread` / `run_db` / `await` 都不算
        if name in {"to_thread", "run_db", "create_task", "wait_for"}:
            return None
        # 明确的 DB / 服务层调用面
        if base_name.split(".")[0] in {
            "owned_service", "kb_service", "repo", "repository",
        }:
            return full
        return None
    return None


def _awaited_subtree_ids(tree: ast.AST) -> set[int]:
    """收集所有 `await X(...)` 那个 Call **整棵子树**内节点的 id。

    `await run_db(lambda: owned_service.list_bases(...))` 里，
    `owned_service.list_bases` 是 lambda 内的 Call，它本身不在 await 节点上，
    但整棵子树都在 `await run_db(...)` 之下，由线程池执行 —— 安全。
    所以判据取「是否位于某个被 await 的调用子树内」，而不是只看节点本身。
    """
    ids: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Await) and isinstance(node.value, ast.Call):
            for sub in ast.walk(node.value):
                ids.add(id(sub))
    return ids


def _async_handlers(path: Path) -> list[tuple[int, str, list[str]]]:
    """找出该文件里所有 async def 及其内部**未被 await 包住**的同步阻塞调用。"""
    src = path.read_text(encoding="utf-8")
    tree = ast.parse(src)
    awaited = _awaited_subtree_ids(tree)
    out: list[tuple[int, str, list[str]]] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.AsyncFunctionDef):
            continue
        blocked = []
        for sub in ast.walk(node):
            if isinstance(sub, ast.Call):
                hit = _is_sync_blocking_call(sub)
                if not hit:
                    continue
                if id(sub) in awaited:
                    continue
                blocked.append(hit)
        if blocked:
            out.append((node.lineno, node.name, blocked))
    return out


def _router_files() -> list[Path]:
    return sorted(APP.glob("routers/*.py"))


# 已知存量违规（2026-11-20 第70轮扫描结果）。
# 这两个文件共 58 个 async 处理函数同步调 DB —— 是长期存在的存量债，
# 不能靠一次改动全清（风险高：每个点都要确认调用不是纯内存）。
# 处理策略：本清单**只许减不许增**，每轮修掉一批就从这里删一批；
# 新增违规（不在清单里）立即变红，防止继续扩大。
# 最热的两个端点已在本轮修掉（/api/knowledge/owned/bases → run_db）。
# 【self-evolution-bot · 2026-11-20 · 第70轮 · 模型:deepseek-v4.1-flash-1017】
# 原为 {"knowledge.py", "knowledge_owned.py"} 两条存量技术债 xfail 豁免。
# 本轮把这 58 处全部落地清零（53 处 await-free 端点改 def 走 anyio 线程池，
# 5 处含 await 的用 await run_db(...) 包住），存量=0，故白名单清空。
# 保留空集而不是删变量：将来真需要再挂豁免时，必须在这里显式登记、留痕。
# 铁律：只许减不许增 —— 空集就是「一处都不许有」。
_KNOWN_ASYNC_DB_DEBT: set[str] = set()


@pytest.mark.parametrize("path", _router_files(), ids=lambda p: p.name)
def test_no_sync_db_calls_inside_async_handlers(path: Path) -> None:
    """async 路由里同步调 DB = 按住事件循环 = 全站变慢。

    这类缺陷不会报错、不会 5xx，只会「今天感觉有点卡」，
    所以必须静态兜住，别指望端到端探测发现。
    """
    offenders = _async_handlers(path)
    if not offenders:
        return
    if path.name in _KNOWN_ASYNC_DB_DEBT:
        pytest.xfail(
            f"{path.name} 尚存 {len(offenders)} 处存量同步 DB 调用（已登记技术债，只许减不许增）"
        )
    lines = [
        f"  {path.name}:{lineno} async def {name}() 同步调用 {sorted(set(calls))}"
        for lineno, name, calls in offenders
    ]
    pytest.fail(
        "async 路由里出现同步 DB 调用（会阻塞事件循环）"
        f"共 {len(offenders)} 处：\n" + "\n".join(lines) +
        "\n\n改法：用 app.gateway.db_async.run_db(...) 包起来，或把端点改成普通 def。"
    )


def test_known_offender_is_detected() -> None:
    """反向验证：喂一段必然违规的代码，判据必须抓到。

    否则本测试只是在测自己没写错语法。
    """
    import tempfile

    bad = """
async def handler():
    items = owned_service.list_bases(admin=True)
    return {"items": items}
"""
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "bad_router.py"
        p.write_text(bad, encoding="utf-8")
        offenders = _async_handlers(p)
    assert offenders, "判据失效：明知违规的样本没被抓到"
    assert offenders[0][1] == "handler"


def test_correct_pattern_is_clean() -> None:
    """反向的另一半：正确写法（run_db / await / 普通 def）必须不误报。"""
    import tempfile

    good = """
async def handler():
    items = await run_db(lambda: owned_service.list_bases(admin=True))
    return {"items": items}

def sync_handler():
    return owned_service.list_bases(admin=True)
"""
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "good_router.py"
        p.write_text(good, encoding="utf-8")
        offenders = _async_handlers(p)
    assert not offenders, f"误报：正确写法被判违规 {offenders}"
