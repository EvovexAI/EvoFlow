"""Persistent MCP connection pool（对齐 ZCode 连接池语义）.

langchain-mcp-adapters 的 ``get_tools()`` 语义是"每次 tool call 新建 session"
（stdio 传输下等价于：重新 spawn 子进程 → initialize 握手 → 调用一次 → 进程退出，
见 langchain_mcp_adapters/tools.py 的 per-call ``create_session``）。这既让每次
调用付出 spawn 成本，也让有状态 MCP 服务器每次调用丢失全部上下文。

本模块为每个 server 维护一条常驻 ``ClientSession``：

- 会话固定住在池专属的后台事件循环线程上。任何调用方（Gateway loop、LangGraph
  worker loop、同步 wrapper 的裸线程）都通过 marshal 提交到池 loop，天然规避
  anyio 流与 ``ClientSession`` 的 loop 绑定问题；
- ``ensure_server_tools()`` 返回"池绑定工具"：func/coroutine 已改写为 marshal
  包装，签名与直连工具一致，调用方无感；
- 调用命中连接级错误（子进程崩溃/管道断裂/anyio 资源关闭）时把 entry 标记为
  stale，本次调用照常抛错，下次调用自动重建会话（健康检查语义）；
- 空闲不回收：网关是长驻进程，会话与 mcp 工具缓存同生命周期（reset 时统一关闭）。
  ZCode 的 30s idle grace 面向 CLI 短会话；服务端常驻池保温是特性而非缺陷。
"""

from __future__ import annotations

import asyncio
import atexit
import contextlib
import logging
import os
import threading
from typing import Any, Awaitable, Callable, TypeVar

from langchain_core.tools import BaseTool, StructuredTool
from langchain_mcp_adapters.client import MultiServerMCPClient

logger = logging.getLogger(__name__)

T = TypeVar("T")

# 单次工具调用超时（池侧计时）。per-call session 语义下，挂死的调用随进程退出自然
# 消失；常驻会话下同一条 session 会被一次挂死永久占用，因此超时是必需的。
# 0 = 关闭超时（不推荐）。
_CALL_TIMEOUT_ENV = "EVOFLOW_MCP_CALL_TIMEOUT_SEC"
_CALL_TIMEOUT_DEFAULT_SEC = 120.0


def call_timeout_sec() -> float:
    raw = os.environ.get(_CALL_TIMEOUT_ENV, "").strip()
    if not raw:
        return _CALL_TIMEOUT_DEFAULT_SEC
    try:
        return max(0.0, float(raw))
    except ValueError:
        return _CALL_TIMEOUT_DEFAULT_SEC


def server_timeout_sec_from_config(raw_cfg: dict[str, Any] | None) -> float | None:
    """从 server 原始配置读取 per-server 超时（对齐 Zcode ``timeoutMs``）。

    同时接受 Zcode 风格 ``timeoutMs``（毫秒）与 EvoFlow 旧字段 ``timeout``
    （秒）；两者并存时 ``timeoutMs`` 优先（与 Zcode 的 descriptor 覆盖语义
    一致）。未配置或值不可用时返回 ``None``，由调用方回退到各自的全局默认。
    """
    if not isinstance(raw_cfg, dict):
        return None
    for key, scale in (("timeoutMs", 1000.0), ("timeout", 1.0)):
        value_raw = raw_cfg.get(key)
        if value_raw is None:
            continue
        try:
            value = float(value_raw)
        except (TypeError, ValueError):
            continue
        if value > 0:
            return value / scale
    return None

# 连接级错误特征：按异常类名识别（不 import anyio，避免版本耦合）。
_CONNECTION_ERROR_TYPE_NAMES = frozenset(
    {
        "ClosedResourceError",
        "BrokenResourceError",
        "BrokenPipeError",
        "ConnectionError",
        "ConnectionResetError",
        "ConnectionAbortedError",
        "EndOfStream",
    }
)
# mcp/anyio 断连在消息里的常见特征（ExceptionGroup 展开后匹配）。
_CONNECTION_ERROR_MESSAGE_MARKS = (
    "closed",
    "broken pipe",
    "connection reset",
    "event loop is closed",
    "anyio worker thread",
)


def _walk_exception_tree(exc: BaseException):
    stack = [exc]
    while stack:
        current = stack.pop()
        yield current
        stack.extend(getattr(current, "exceptions", None) or [])


def looks_like_connection_error(exc: BaseException | None) -> bool:
    """进程崩溃 / 管道断裂 / 会话已关闭类错误 → 值得重建会话再试。"""
    if exc is None:
        return False
    for node in _walk_exception_tree(exc):
        if type(node).__name__ in _CONNECTION_ERROR_TYPE_NAMES:
            return True
        text = str(node).strip().lower()
        if text and any(mark in text for mark in _CONNECTION_ERROR_MESSAGE_MARKS):
            return True
    return False


class _ServerEntry:
    """单个 server 的常驻会话与工具集（仅池 loop 线程可变）。"""

    __slots__ = (
        "name",
        "config",
        "client",
        "session",
        "host_task",
        "stop_event",
        "ready_event",
        "error",
        "stale",
        "tools",
        "call_timeout_sec",
    )

    def __init__(self, name: str, config: dict[str, Any], call_timeout_sec: float | None = None) -> None:
        self.name = name
        self.config = config
        self.call_timeout_sec = call_timeout_sec
        self.client: MultiServerMCPClient | None = None
        self.session: Any = None
        self.host_task: asyncio.Task | None = None
        self.stop_event: asyncio.Event | None = None
        self.ready_event: asyncio.Event | None = None
        self.error: BaseException | None = None
        self.stale: bool = False
        self.tools: list[BaseTool] = []


class McpConnectionPool:
    """常驻 MCP 会话池。所有会话住在专属 loop 线程，调用方经 marshal 使用。"""

    def __init__(self) -> None:
        self._entries: dict[str, _ServerEntry] = {}
        self._registry_lock = threading.Lock()
        self._loop_lock = threading.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._loop_ready = threading.Event()
        self._closed = False

    # ── 专属 loop 线程 ──────────────────────────────────────────

    def _ensure_loop(self) -> asyncio.AbstractEventLoop:
        with self._loop_lock:
            if self._loop is not None and self._loop.is_running():
                return self._loop
            self._loop_ready.clear()
            self._thread = threading.Thread(
                target=self._loop_main, name="evoflow-mcp-pool", daemon=True
            )
            self._thread.start()
            if not self._loop_ready.wait(timeout=15):
                raise RuntimeError("MCP connection pool loop failed to start")
            return self._loop

    def _loop_main(self) -> None:
        # Windows 上 mcp stdio 传输依赖子进程支持：默认 policy 即 Proactor，显式
        # set_event_loop 仅为防御外层改过 policy 的场景。
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loop = loop
        self._loop_ready.set()
        try:
            loop.run_forever()
        finally:
            asyncio.set_event_loop(None)
            loop.close()

    def is_pool_thread(self) -> bool:
        return self._thread is not None and threading.current_thread() is self._thread

    # ── marshal：任意线程/loop → 池 loop ────────────────────────

    async def run_on_pool_loop(self, coro: Awaitable[T]) -> T:
        """在池 loop 上执行协程；已身处池 loop 则直接 await。"""
        loop = self._ensure_loop()
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is loop:
            return await coro
        future = asyncio.run_coroutine_threadsafe(_wrap_cancel(coro), loop)
        return await asyncio.wrap_future(future)

    def run_on_pool_loop_sync(self, coro_factory: Callable[[], Awaitable[T]]) -> T:
        """同步上下文提交到池 loop 并阻塞等待（调用线程绝不能是池线程）。"""
        loop = self._ensure_loop()
        if self.is_pool_thread():
            raise RuntimeError(
                "MCP pool sync call attempted from the pool thread; use the async path"
            )
        future = asyncio.run_coroutine_threadsafe(_wrap_cancel(coro_factory()), loop)
        return future.result()

    # ── 会话生命周期（以下协程只应在池 loop 上运行）─────────────

    async def _hold_session(self, entry: _ServerEntry) -> None:
        """host task：进入 client.session() 并持有，直到 stop_event 置位。

        进入与退出必须在同一个 task（anyio cancel scope 约束），因此停用走
        stop_event 而不是 cancel。
        """
        try:
            async with entry.client.session(entry.name) as session:
                entry.session = session
                entry.ready_event.set()
                await entry.stop_event.wait()
        except Exception as exc:  # noqa: BLE001 - 建连失败要带回给调用方
            entry.error = exc
            entry.ready_event.set()
        finally:
            entry.session = None
            entry.host_task = None

    async def _connect_entry(self, entry: _ServerEntry, timeout_sec: float) -> None:
        entry.client = MultiServerMCPClient({entry.name: entry.config}, tool_name_prefix=True)
        entry.stop_event = asyncio.Event()
        entry.ready_event = asyncio.Event()
        entry.error = None
        entry.host_task = asyncio.create_task(
            self._hold_session(entry), name=f"mcp-session-host:{entry.name}"
        )
        try:
            await asyncio.wait_for(entry.ready_event.wait(), timeout=timeout_sec)
        except TimeoutError:
            await self._teardown_entry(entry)
            raise TimeoutError(
                f"Timed out after {timeout_sec:.0f}s establishing persistent MCP session"
            ) from None
        if entry.error is not None:
            await self._teardown_entry(entry)
            raise entry.error
        if entry.session is None:
            await self._teardown_entry(entry)
            raise RuntimeError("MCP session closed immediately after connect")

    async def _teardown_entry(self, entry: _ServerEntry) -> None:
        entry.stale = True
        if entry.stop_event is not None:
            entry.stop_event.set()
        host_task = entry.host_task
        if host_task is not None and not host_task.done() and host_task is not asyncio.current_task():
            try:
                # 优雅退出：stop_event 置位让 host task 走 acm 正常 unwind。
                await asyncio.wait_for(asyncio.shield(host_task), timeout=10)
            except (TimeoutError, Exception):
                # 优雅退出失败（transport 卡死等）→ 硬取消。cancel 的 unwind 仍
                # 发生在 host task 自己的栈上，满足 anyio cancel scope 同 task 约束。
                host_task.cancel()
                with contextlib.suppress(BaseException):
                    await host_task
        entry.session = None
        entry.host_task = None
        with contextlib.suppress(KeyError):
            del self._entries[entry.name]

    async def _ensure_entry_locked(
        self,
        name: str,
        config: dict[str, Any],
        timeout_sec: float,
        call_timeout_sec: float | None = None,
    ) -> _ServerEntry:
        from langchain_mcp_adapters.tools import load_mcp_tools

        entry = self._entries.get(name)
        if entry is not None:
            if entry.stale or entry.error is not None or entry.session is None:
                await self._teardown_entry(entry)
                entry = None
            elif entry.config != config:
                # 配置变了（指纹失效路径已在 cache 层处理；这里兜底配置漂移）。
                await self._teardown_entry(entry)
                entry = None
        if entry is None:
            entry = _ServerEntry(name, config, call_timeout_sec=call_timeout_sec)
            await self._connect_entry(entry, timeout_sec)
            self._entries[name] = entry
            try:
                # tool_name_prefix 与旧 get_tools() 路径一致：名字先带 server 前缀，
                # 再由 tools._normalize_mcp_tool_names 归一为 mcp__<server>__<tool>。
                entry.tools = await load_mcp_tools(
                    entry.session, server_name=name, tool_name_prefix=True
                )
            except Exception:
                await self._teardown_entry(entry)
                raise
            logger.info(
                "MCP persistent session ready: server=%r tools=%d",
                name,
                len(entry.tools),
            )
        return entry

    async def _invoke_tool(self, name: str, original: StructuredTool, kwargs: dict[str, Any]) -> Any:
        entry = self._entries.get(name)
        # 调用超时优先级（对齐 Zcode）：per-server 配置（timeoutMs/timeout）覆盖
        # 全局默认（descriptor.timeoutMs 覆盖默认值）；全局默认可用 env 调整。
        timeout = call_timeout_sec()
        if entry is not None and entry.call_timeout_sec is not None:
            timeout = entry.call_timeout_sec
        try:
            coro = original.coroutine(**kwargs)
            if timeout > 0:
                # 超时在池侧计时：调用方取消不会让挂死调用泄漏在池 loop 上。
                raw = await asyncio.wait_for(coro, timeout=timeout)
            else:
                raw = await coro
        except TimeoutError:
            # 挂死的调用占用常驻 session；按连接级故障处理，下次调用重建会话。
            if entry is not None:
                logger.warning(
                    "MCP call timeout on server %r after %.0fs; session marked stale",
                    name,
                    timeout,
                )
                with contextlib.suppress(Exception):
                    await self._teardown_entry(entry)
            raise RuntimeError(
                f"MCP tool call timed out after {timeout:.0f}s "
                f"(server may be hung; tune the server's timeoutMs in mcp.json "
                f"or {_CALL_TIMEOUT_ENV})"
            ) from None
        except Exception as exc:  # noqa: BLE001
            if looks_like_connection_error(exc) and entry is not None:
                logger.warning(
                    "MCP connection-level failure on server %r; session marked stale for rebuild: %s",
                    name,
                    exc,
                )
                with contextlib.suppress(Exception):
                    await self._teardown_entry(entry)
            raise
        # 结果预算归一化（对齐 Zcode）：大图落盘换占位引用、超预算文本截断，
        # 防止 MCP 返回的大 base64 图片 / 超长输出打爆 provider 请求体。
        from evoflow.mcp.result_budget import normalize_mcp_tool_result

        return normalize_mcp_tool_result(str(getattr(original, "name", "") or name), raw)

    # ── 对外 API ────────────────────────────────────────────────

    async def ensure_server_tools(
        self,
        name: str,
        config: dict[str, Any],
        *,
        timeout_sec: float = 45.0,
        call_timeout_sec: float | None = None,
    ) -> list[BaseTool]:
        """确保 server 的常驻会话可用，返回池绑定（任意 loop 可调）的工具列表。

        ``timeout_sec`` 为建连超时；``call_timeout_sec`` 为该 server 的调用
        超时覆盖（``None`` 表示用池全局默认，见 ``call_timeout_sec()``）。
        """
        await self.run_on_pool_loop(
            self._ensure_entry_locked(name, config, timeout_sec, call_timeout_sec)
        )
        with self._registry_lock:
            entry = self._entries.get(name)
            originals = list(entry.tools) if entry else []
        return [self._bind_pool_tool(name, tool) for tool in originals]

    def _bind_pool_tool(self, server_name: str, original: BaseTool) -> BaseTool:
        """把 session 绑定的工具改写为 marshal 包装；签名/元数据保持不变。"""
        if not isinstance(original, StructuredTool) or original.coroutine is None:
            return original

        async def _arun(**kwargs: Any) -> Any:
            return await self.run_on_pool_loop(self._invoke_tool(server_name, original, kwargs))

        def _srun(**kwargs: Any) -> Any:
            return self.run_on_pool_loop_sync(
                lambda: self._invoke_tool(server_name, original, kwargs)
            )

        return StructuredTool(
            name=original.name,
            description=original.description,
            args_schema=original.args_schema,
            func=_srun,
            coroutine=_arun,
            response_format="content_and_artifact",
            metadata=original.metadata,
        )

    async def _shutdown_async(self) -> None:
        for name in list(self._entries.keys()):
            entry = self._entries.get(name)
            if entry is not None:
                with contextlib.suppress(Exception):
                    await self._teardown_entry(entry)
        logger.info("MCP connection pool shut down (%d session(s) closed)", len(self._entries))

    def shutdown(self, timeout_sec: float = 10.0) -> None:
        """关闭全部常驻会话（同步、任意线程可调；幂等）。"""
        if not self._entries:
            return
        with contextlib.suppress(Exception):
            loop = self._ensure_loop()
            future = asyncio.run_coroutine_threadsafe(self._shutdown_async(), loop)
            future.result(timeout=timeout_sec)


async def _wrap_cancel(coro: Awaitable[T]) -> T:
    return await coro


_POOL: McpConnectionPool | None = None
_POOL_LOCK = threading.Lock()


def get_mcp_connection_pool() -> McpConnectionPool:
    global _POOL
    with _POOL_LOCK:
        if _POOL is None:
            pool = McpConnectionPool()
            atexit.register(pool.shutdown)
            _POOL = pool
        return _POOL


def reset_mcp_connection_pool(timeout_sec: float = 10.0) -> None:
    """关闭并清空全部常驻会话（cache 重置/配置变更时调用）。"""
    global _POOL
    with _POOL_LOCK:
        pool = _POOL
    if pool is not None:
        pool.shutdown(timeout_sec=timeout_sec)
