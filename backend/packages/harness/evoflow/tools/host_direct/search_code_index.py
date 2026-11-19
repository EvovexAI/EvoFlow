"""Search indexed workspace via FTS5 + symbols."""

from __future__ import annotations

import atexit
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeoutError

from langchain_core.tools import tool

from evoflow.core.tool_runtime_type import ToolRuntime
from evoflow.tools.minimal_schema import SEARCH_CODE_INDEX_DESCRIPTION

_MAX_WALL_SECONDS = 45.0
# 【self-evolution-bot · 2026-11-19 · 第61轮 · 模型:deepseek-v4.1-flash-1017】
# 改了什么：follow-read 兜底 15s → 4s，并给它**独立**的线程池。
# 为什么（现网证据，2026-11-19 01:29 重启后实测）：
#   · 01:30:24 那次 search_code_index 耗时 26357ms，输出里带
#     `[hint] post-search reads timed out after 15s` —— 其中**整整 15s 是干等**；
#     同一批检索 3 分钟后只需 2072ms（重启后 90s 内 avg 15642ms vs 之后 2072ms，差 7.5 倍）。
#   · 根因不是检索慢：裸进程实测 search_index 冷 507ms / 热 87ms，
#     follow_read 冷 2117ms / 热 87ms。慢在**排队**——follow-read 与主检索
#     共用 `_SEARCH_POOL`（4 worker），重启窗口内 owned-KB worker
#     （01:29:59 启动，bge-small-zh 本地嵌入）与其它请求把 GIL/线程占满，
#     follow-read 排不上队，就一路干等到 15s 天花板才放弃。
#   · follow-read 只产出「附赠的代码正文预览」，主结果（符号+命中）早在它之前就已拿到。
#     为一段附赠内容白等 15s 不划算：给不出就诚实说给不出，让调用方自己 read。
# 判据：4s 仍覆盖裸进程冷启实测 2117ms 的 1.9 倍余量；超时文案已提示改用 read_file。
_MAX_READ_WALL_SECONDS = 4.0
_MAX_READ_LIMIT = 4

_SEARCH_POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix="search-code-index")
# 独立池：follow-read 排队时不许占住主检索的 worker，也绝不许把主检索按在池里等它。
_READ_POOL = ThreadPoolExecutor(max_workers=2, thread_name_prefix="search-code-index-read")
atexit.register(lambda: _SEARCH_POOL.shutdown(wait=False, cancel_futures=True))
atexit.register(lambda: _READ_POOL.shutdown(wait=False, cancel_futures=True))


def _now_ms() -> float:
    """单调时钟毫秒（wall clock 会被系统时间调整影响，计时段一律用它）。"""
    import time as _t

    return _t.perf_counter() * 1000.0


def _note_search_timing(
    tool_call_id: str,
    *,
    search_ms: float,
    fmt_ms: float,
    read_ms: float,
    total_ms: float,
    read_limit: int,
    semantic_degraded: str,
) -> None:
    """把分段耗时交给中间件，落进 obs 的 timing_json。

    【self-evolution-bot · 2026-11-19 · 第63轮】纯观测：任何异常都吞掉，
    绝不允许「记日志」把检索搞挂（本仓因旁路逻辑拖垮主路栽过）。
    key 取不到就不上报，避免污染别人的键。
    """
    key = str(tool_call_id or "").strip()
    if not key:
        return
    try:
        from evoflow.observability.tool_timing import note_tool_exec_detail

        note_tool_exec_detail(
            key,
            {
                "kind": "search_code_index",
                "search_ms": round(search_ms, 1),
                "format_ms": round(max(0.0, fmt_ms), 1),
                "follow_read_ms": round(read_ms, 1),
                "body_ms": round(total_ms, 1),
                "read_limit": int(read_limit),
                "semantic_degraded": semantic_degraded or "",
            },
        )
    except Exception:
        pass


def _cap_read_limit(read_limit: int, read_offset: int) -> tuple[int, str]:
    """Return (capped read_limit, optional hint suffix)."""
    if read_limit <= _MAX_READ_LIMIT:
        return read_limit, ""
    return (
        _MAX_READ_LIMIT,
        (f"\n\n[hint] read_limit capped at {_MAX_READ_LIMIT}; use read_offset={read_offset + _MAX_READ_LIMIT} on a follow-up call to continue."),
    )


def _run_search_index_lookup(
    *,
    root: str,
    thread_id: str | None,
    query: str,
    queries: list[str] | str | None,
    limit: int,
) -> tuple[str | None, dict | None]:
    """Run FTS/symbol search only. Returns (user_message, data) — one side is always None."""
    from evoflow.code_index.store import merge_search_queries, search_index
    from evoflow.tools.arg_coerce import normalize_search_query_inputs

    primary, extra = normalize_search_query_inputs(query, queries)
    label, _explicit = merge_search_queries(primary, queries=extra)
    if not label:
        return "Error: provide `query` (e.g. `飞书|feishu|lark`) and/or `queries`.", None

    data = search_index(root or None, primary, queries=extra, thread_id=thread_id, limit=limit)
    hits = data.get("hits") or []
    symbols = data.get("symbols") or []
    related = data.get("related_files") or []
    imported_by = data.get("imported_by") or []
    imports = data.get("imports") or []
    ref_users = data.get("internal_ref_users") or []
    type_supers = data.get("type_supertypes") or []
    type_subs = data.get("type_subtypes") or []
    if not hits and not symbols and not related and not imported_by and not imports and not ref_users and not type_supers and not type_subs:
        from evoflow.code_index.store import index_status

        st = index_status(workspace_root=root or None, thread_id=thread_id)
        if st.get("building"):
            return (
                f"No index hits for '{label}' yet — workspace index is still building. Retry search_code_index in a few seconds.",
                None,
            )
        if not st.get("ready"):
            return (
                f"No index hits for '{label}'. Workspace index is not ready — open the project in EvoPanel (index build) or wait for background indexing.",
                None,
            )
        return (
            f"No index hits for '{label}'. Try pipe synonyms (dall-e|dalle), shorter symbols, or read_file on likely paths after index miss.",
            None,
        )
    data["label"] = label
    return None, data


def _format_search_data(data: dict, *, limit: int, verbose: bool = False) -> str:
    from evoflow.code_index.format_results import format_search_index_body

    label = str(data.get("label") or data.get("query") or "")
    return format_search_index_body(
        {
            "hits": data.get("hits") or [],
            "symbols": data.get("symbols") or [],
            "related_files": data.get("related_files") or [],
            "imported_by": data.get("imported_by") or [],
            "imports": data.get("imports") or [],
            "internal_ref_users": data.get("internal_ref_users") or [],
            "type_supertypes": data.get("type_supertypes") or [],
            "type_subtypes": data.get("type_subtypes") or [],
            "path_prefix": data.get("path_prefix"),
            "path_scope_relaxed": data.get("path_scope_relaxed"),
            # 【self-evolution-bot · 2026-11-17 · 第33轮】这里显式重建 dict 只挑字段，
            # 不在这里透传 = 新加的索引新鲜度在工具出口处被丢掉（接线漏最后一米）。
            "index_age_seconds": data.get("index_age_seconds"),
            "index_updated_at": data.get("index_updated_at"),
            # 【self-evolution-bot · 2026-11-17 · 第38轮】源码漂移同样要透传。
            # 本轮实测：探针文件 0 行在库、工具却报 ready 且只说「age=475s」看着很新；
            # 不透传这一栏，输出层就没法提示「你改的代码可能还没进索引」。
            "index_source_drift": data.get("index_source_drift"),
            # 【self-evolution-bot · 2026-11-17 · 第40轮 · 模型:deepseek-v4.1-flash-1017】
            # 整句标识符字面没命中 → 输出层要明说「库里没有这个名字」，
            # 而不是把拆词凑出来的 10 条低相关结果当答案递给调用方。
            "literal_query_missing": data.get("literal_query_missing"),
            # 【self-evolution-bot · 2026-11-18 · 第51轮 · 模型:deepseek-v4.1-flash-1017】
            # 同上，这一栏不透传 = 降级提示在工具出口被丢掉（本轮第 3 次踩「最后一米」）。
            "semantic_degraded": data.get("semantic_degraded"),
            "semantic_degraded_detail": data.get("semantic_degraded_detail"),
        },
        label=label,
        limit=limit,
        rebuild_in_progress=bool(data.get("rebuild_in_progress")),
        verbose=verbose,
    )


def _follow_read_with_timeout(
    *,
    data: dict,
    read_root: str,
    thread_id: str | None,
    read_offset: int,
    read_limit: int,
) -> str:
    from evoflow.scheduler.search_follow_read import follow_read_after_search

    def _reads() -> str:
        return follow_read_after_search(
            data,
            workspace_root=read_root,
            thread_id=thread_id,
            read_offset=read_offset,
            read_limit=read_limit,
        )

    try:
        fut = _READ_POOL.submit(_reads)
        extra_reads = fut.result(timeout=_MAX_READ_WALL_SECONDS)
    except FuturesTimeoutError:
        return f"\n\n[hint] post-search reads timed out after {int(_MAX_READ_WALL_SECONDS)}s (the search results above are complete); use read_file on catalog paths or lower read_limit."
    except Exception as e:
        return f"\n\n[hint] post-search reads failed: {e}"
    return f"\n\n{extra_reads}" if extra_reads else ""


def _search_code_index_wallclock(
    *,
    root: str,
    thread_id: str | None,
    tool_call_id: str = "",
    query: str,
    queries: list[str] | str | None,
    read_offset: int,
    read_limit: int,
    limit: int,
    verbose: bool = False,
) -> str:
    """Run indexed search with a wall-clock timeout; batch reads use a separate budget."""
    # 【self-evolution-bot · 2026-11-19 · 第63轮 · 模型:deepseek-v4.1-flash-1017】
    # 分段计时写进 obs 的 timing_json。为什么必须做：本轮我为了定位「检索 P50
    # 6.5s 落在哪一段」，现写了 4 个探针、发了十几次 bash —— 而 obs 里这张表的
    # `timing_json` 一直是 **null**（bash/assets 都有分段，只有它没有）。
    # 少一个字段 = 每轮都得重新猜，这本身就是「工具慢」的一部分（我的探针
    # 一天 1345 次、平均 2.4s）。补上之后同类归因一次查询就能出结论。
    # 边界：纯观测，失败一律吞掉，绝不改变返回值/异常/耗时行为。
    _t0 = _now_ms()
    try:
        fut = _SEARCH_POOL.submit(
            _run_search_index_lookup,
            root=root,
            thread_id=thread_id,
            query=query,
            queries=queries,
            limit=limit,
        )
        msg, data = fut.result(timeout=_MAX_WALL_SECONDS)
    except FuturesTimeoutError:
        return f"Error: search_code_index timed out after {int(_MAX_WALL_SECONDS)}s. Lower read_limit (max 4), narrow query, or paginate with read_offset."
    except Exception as e:
        return f"Error: search_code_index failed: {e}"

    _search_ms = _now_ms() - _t0

    if msg is not None:
        return msg
    assert data is not None

    out = _format_search_data(data, limit=limit, verbose=verbose)
    _fmt_ms = _now_ms() - _t0 - _search_ms

    read_root = root
    if not read_root and thread_id:
        try:
            from evoflow.code_index.store import resolve_index_root

            read_root = str(resolve_index_root(workspace_root=None, thread_id=thread_id))
        except ValueError:
            read_root = ""
    _read_ms = 0.0
    if read_root:
        _rt = _now_ms()
        out += _follow_read_with_timeout(
            data=data,
            read_root=read_root,
            thread_id=thread_id,
            read_offset=read_offset,
            read_limit=read_limit,
        )
        _read_ms = _now_ms() - _rt
    elif read_limit > 0:
        out += "\n\n[hint] post-search reads skipped: workspace root unavailable."
    # 【self-evolution-bot · 2026-11-19 · 第63轮】把三段耗时挂到本次调用上。
    # 判读口径：search_ms ≫ 其余 ⇒ 慢在检索本体；read_ms ≫ 其余 ⇒ 慢在附赠读取；
    # 三段之和 ≪ duration_ms ⇒ 慢在调度/排队，别再来检索代码里找。
    _note_search_timing(
        tool_call_id,
        search_ms=_search_ms,
        fmt_ms=_fmt_ms,
        read_ms=_read_ms,
        total_ms=_now_ms() - _t0,
        read_limit=read_limit,
        semantic_degraded=data.get("semantic_degraded") or "",
    )
    return out


# 【self-evolution-bot · 2026-11-19 · 第63轮 · 模型:deepseek-v4.1-flash-1017】
# 为什么给这个工具挂专用线程池（与 assets_tool.py 同型缺陷、同一修法）：
# 本函数是**同步**函数，`ainvoke` 会把它丢进事件循环的默认 executor
# （``loop.run_in_executor(None, ...)``）。桌面 Gateway 上这个默认池会被压缩、
# MCP 同步包装、阻塞 I/O 一起抢；而我自己每一轮都是「多个 bash 并发 + 夹一次
# search_code_index」，正好是抢池最凶的形态。assets 工具挂专用池前实测
# 「本体 <1ms 却整批卡 2s+」，挂后消失——同一机制对检索同样成立。
# 判据：本地直调本工具全链路 68~249ms，而现网 obs P50 6528ms；
# 这个差额不在检索代码里（已逐段排除：read_limit 无关、写索引不挡、
# follow_read 仅 10ms），剩下能解释它的就是「等默认池的槽」。
# 边界：只改调度位置，不改工具签名/返回值/异常；池子满了照样排队，
# 只是不再跟 bash 抢同一条队列。
_SEARCH_TOOL_POOL = ThreadPoolExecutor(
    max_workers=4, thread_name_prefix="search-code-index-tool"
)
atexit.register(lambda: _SEARCH_TOOL_POOL.shutdown(wait=False, cancel_futures=True))


async def _search_code_index_coroutine(*args: object, **kwargs: object) -> object:
    """在专用池上跑同步工具体，不与默认 executor 抢槽。"""
    import asyncio as _asyncio

    # 【self-evolution-bot · 2026-11-19 · 第63轮 · 模型:deepseek-v4.1-flash-1017】
    # 必须取 `.func`：`@tool` 装饰后模块级名字 `search_code_index_hd` 已变成
    # StructuredTool 对象，直接调用它是 `TypeError: 'StructuredTool' object is
    # not callable`（本轮实测撞到，不是猜）。取原始同步函数再进池。
    sync_fn = getattr(search_code_index_hd, "func", None) or search_code_index_hd
    loop = _asyncio.get_running_loop()
    return await loop.run_in_executor(
        _SEARCH_TOOL_POOL, lambda: sync_fn(*args, **kwargs)
    )


@tool("search_code_index", description=SEARCH_CODE_INDEX_DESCRIPTION, parse_docstring=False)
def search_code_index_hd(
    query: str = "",
    queries: list[str] | str | None = None,
    *,
    read_offset: int = 0,
    read_limit: int = 0,
    limit: int = 15,
    verbose: bool = False,
    runtime: ToolRuntime,
) -> str:
    """Search the workspace code index."""
    try:
        read_offset = int(read_offset)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        read_offset = 0
    try:
        read_limit = int(read_limit)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        read_limit = 0
    read_offset = max(0, read_offset)
    read_limit = max(0, read_limit)
    read_limit, read_cap_note = _cap_read_limit(read_limit, read_offset)

    from evoflow.tools.host_direct.workspace_path_guard import resolve_search_workspace_root

    resolved = resolve_search_workspace_root(runtime=runtime)
    if isinstance(resolved, str):
        return resolved
    root, thread_id = resolved

    tid = str(thread_id or "").strip()
    if runtime is not None and getattr(runtime, "context", None):
        tid = str(runtime.context.get("thread_id") or tid or "").strip()
    if tid:
        from evoflow.exploration.exploration_budget import check_tool_budget

        budget_err = check_tool_budget(tid, "search_code_index", {"query": query})
        if budget_err:
            return budget_err

    # 【self-evolution-bot · 2026-11-19 · 第63轮】tool_call_id 走 runtime 取
    # （与 read_file 同一手法）：不新增 InjectedToolCallId 形参，
    # 否则直接 .invoke() 的既有调用会因缺参失败。
    _tcid = str(getattr(runtime, "tool_call_id", "") or "").strip()
    return (
        _search_code_index_wallclock(
            root=root,
            thread_id=thread_id,
            tool_call_id=_tcid,
            query=query,
            queries=queries,
            read_offset=read_offset,
            read_limit=read_limit,
            limit=limit,
            verbose=verbose,
        )
        + read_cap_note
    )


# 【self-evolution-bot · 2026-11-19 · 第63轮 · 模型:deepseek-v4.1-flash-1017】
# 接线：只定义 `_search_code_index_coroutine` 不挂到工具对象上等于没改
# （本岗栽过 4 次「函数层全绿、接线没通」）。mount 失败退回原同步路径，
# 不影响功能，只是继续跟默认池抢槽。
try:
    search_code_index_hd.coroutine = _search_code_index_coroutine
except Exception:  # pragma: no cover - pydantic 冻结时静默跳过
    pass


# 【self-evolution-bot · 2026-11-19 · 第64轮 · 模型:deepseek-v4.1-flash-1017】
# 改了什么：模块加载完就把嵌入暖机拉起来，不再等「第一次检索」才起。
#
# 为什么（现网实测，重启后同一查询在网关里 964ms ~ 8387ms 波动 8.7 倍）：
#   · `_start_embed_warmup()` 全仓只有一个调用点 —— `_embed_query_sync` 内部，
#     也就是**第一次检索发生的那一刻**才启动后台暖机。
#   · 于是进程启动后第一次检索必然吃到完整冷启动（模型加载 ~3.8s + 首次 KNN
#     重建页缓存），而它同一时刻还在被 `_SEARCH_POOL` 线程占着，只能干等。
#   · 观测库证据：重启后 08:21/08:27/08:58 三次检索 4478/11462/7119ms，
#     而间隔几分钟后的同类查询只要 964ms / 1308ms。
#
# 判据：暖机本来就是「后台、单飞、失败只降级不阻塞」的（见 `_start_embed_warmup`），
# 提前到 import 时启动**不改变任何检索语义**，只是把这 3.8s 从「用户那次检索」里
# 挪到「进程还没接活的时候」。工具 import 一定早于任何一次检索，所以覆盖完整。
# 暖机失败仍走原来的 300s 冷却重试，不会因为提前启动就改变降级行为。
def _kick_embed_warmup_on_import() -> None:
    """Best-effort: start the code-index embedding warmup at process load time."""
    try:
        from evoflow.code_index.store import _start_embed_warmup

        _start_embed_warmup()
    except Exception:  # noqa: BLE001 - 暖机是纯加速，任何失败都不该影响工具注册
        return


_kick_embed_warmup_on_import()
