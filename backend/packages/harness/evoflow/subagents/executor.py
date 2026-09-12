"""Subagent execution engine."""

import contextvars
import logging
import threading
from collections import OrderedDict
from collections.abc import AsyncIterator, Callable
from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeoutError
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any

from langchain.agents import create_agent
from langchain.tools import BaseTool
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.runnables import RunnableConfig

from evoflow.agents.lead_agent.runtime_context import LeadAgentRuntimeContext
from evoflow.agents.thread_state import SandboxState, ThreadDataState, ThreadState

# Import cancellation support
from evoflow.cancellation import is_task_cancelled
from evoflow.cancellation.exceptions import TaskCancelledError
from evoflow.collab.id_format import make_formatted_id, make_trace_id
from evoflow.models import create_chat_model
from evoflow.models.credential_sanitize import (
    _DEFAULT_REQUEST_TIMEOUT_SEC,
    bind_chat_model_http_clients,
    reset_chat_model_http_clients,
)
from evoflow.platform.isolated_loop import run_coroutine_on_fresh_loop
from evoflow.subagents.config import SubagentConfig, resolve_subagent_recursion_limit

logger = logging.getLogger(__name__)


def _subagent_prompt_logs_repo_root() -> Path:
    """Get repo root for prompt logs. executor.py is at backend/packages/harness/evoflow/subagents/executor.py"""
    return Path(__file__).resolve().parents[5]


def _log_subagent_prompt(
    subagent_name: str,
    system_prompt: str,
    task: str,
    tools: list[str],
    trace_id: str,
) -> None:
    """Append subagent prompt and execution details to a log file."""
    try:
        from evoflow.debug.trace_sink import debug_file_path

        log_path = debug_file_path("subagent_prompts.log")
        log_path.parent.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with log_path.open("a", encoding="utf-8") as f:
            f.write(f"\n\n===== [{timestamp}] Subagent Execution =====\n")
            f.write(f"Trace ID: {trace_id}\n")
            f.write(f"Subagent: {subagent_name}\n")
            f.write(f"Tools: {', '.join(tools)}\n")
            f.write("\n--- System Prompt ---\n")
            f.write(system_prompt)
            f.write("\n\n--- Task Description ---\n")
            f.write(task)
            f.write("\n===== END =====\n")
    except Exception as e:
        logger.warning("Failed to write subagent prompt log: %s", e)


class SubagentStatus(Enum):
    """Status of a subagent execution."""

    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    TIMED_OUT = "timed_out"
    CANCELLED = "cancelled"  # 【新增】任务被取消


@dataclass
class SubagentResult:
    """Result of a subagent execution.

    Attributes:
        task_id: Unique identifier for this execution.
        trace_id: Trace ID for distributed tracing (links parent and subagent logs).
        status: Current status of the execution.
        result: The final result message (if completed).
        error: Error message (if failed).
        started_at: When execution started.
        completed_at: When execution completed.
        ai_messages: List of complete AI messages (as dicts) generated during execution.
        stream_messages: AI + Tool 消息按对话顺序（供 task_running 推送，含工具返回）。
    """

    task_id: str
    trace_id: str
    status: SubagentStatus
    result: str | None = None
    error: str | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    ai_messages: list[dict[str, Any]] | None = None
    stream_messages: list[dict[str, Any]] | None = None

    def __post_init__(self):
        """Initialize mutable defaults."""
        if self.ai_messages is None:
            self.ai_messages = []
        if self.stream_messages is None:
            self.stream_messages = []


# Global storage for background task results
_background_tasks: dict[str, SubagentResult] = {}
_background_tasks_lock = threading.Lock()

# Transcript snapshots kept after cleanup_background_task removes the live entry.
# Frontend SubagentTranscriptModal polls these by task_id long after the subagent
# has finished and the live `_background_tasks` slot was freed.
# Cap entries to prevent unbounded memory growth (FIFO eviction).
_completed_task_snapshots: "OrderedDict[str, SubagentResult]" = OrderedDict()
_completed_task_snapshots_lock = threading.Lock()
_COMPLETED_SNAPSHOTS_CAP = 200

# Thread pool for background task scheduling and orchestration
_scheduler_pool = ThreadPoolExecutor(max_workers=5, thread_name_prefix="subagent-scheduler-")

# Thread pool for actual subagent execution (with timeout support)
# Larger pool to avoid blocking when scheduler submits execution tasks
_execution_pool = ThreadPoolExecutor(max_workers=5, thread_name_prefix="subagent-exec-")


@asynccontextmanager
async def _subagent_loop_local_http_clients() -> AsyncIterator[tuple[Any, Any]]:
    """Bind subagent LLM HTTP to the current event loop (never reuse across loops)."""
    import httpx

    timeout_sec = float(_DEFAULT_REQUEST_TIMEOUT_SEC)
    timeout = httpx.Timeout(connect=10.0, read=timeout_sec, write=timeout_sec, pool=timeout_sec)
    async with httpx.AsyncClient(timeout=timeout) as http_async_client:
        with httpx.Client(timeout=timeout_sec) as http_client:
            yield http_async_client, http_client


def _filter_tools(
    all_tools: list[BaseTool],
    allowed: list[str] | None,
    disallowed: list[str] | None,
) -> list[BaseTool]:
    """Filter tools based on subagent configuration.

    Args:
        all_tools: List of all available tools.
        allowed: Optional allowlist of tool names. If provided, only these tools are included.
        disallowed: Optional denylist of tool names. These tools are always excluded.

    Returns:
        Filtered list of tools.
    """
    filtered = all_tools

    # Apply allowlist if specified
    if allowed is not None:
        allowed_set = set(allowed)
        filtered = [t for t in filtered if t.name in allowed_set]

    # Apply denylist
    if disallowed is not None:
        disallowed_set = set(disallowed)
        filtered = [t for t in filtered if t.name not in disallowed_set]

    return filtered


def _get_model_name(config: SubagentConfig, parent_model: str | None) -> str | None:
    """Resolve the model name for a subagent.

    Args:
        config: Subagent configuration.
        parent_model: The parent agent's model name.

    Returns:
        Model name to use, or None to use default.
    """
    if config.model == "inherit":
        return parent_model
    return config.model


class SubagentExecutor:
    """Executor for running subagents."""

    def __init__(
        self,
        config: SubagentConfig,
        tools: list[BaseTool],
        parent_model: str | None = None,
        sandbox_state: SandboxState | None = None,
        thread_data: ThreadDataState | None = None,
        thread_id: str | None = None,
        local_workspace_root: str | None = None,
        trace_id: str | None = None,
        extra_context: dict[str, Any] | None = None,
        parent_chat_stream_writer: Callable[..., Any] | None = None,
    ):
        """Initialize the executor.

        Args:
            config: Subagent configuration.
            tools: List of all available tools (will be filtered).
            parent_model: The parent agent's model name for inheritance.
            sandbox_state: Sandbox state from parent agent.
            thread_data: Thread data from parent agent.
            thread_id: Thread ID for sandbox operations.
            local_workspace_root: Parent session bound workspace (same index as lead agent).
            trace_id: Trace ID from parent for distributed tracing.
            extra_context: Optional dict merged into LangGraph tool/runtime context for one run
                (e.g. collab ids for ``claude_session`` reuse inside ``task``).
            parent_chat_stream_writer: Lead-agent ``get_stream_writer()`` callable when the subagent
                runs off-graph (thread pool). Used so ``claude_session`` ``send`` can emit
                ``trae_stream_delta`` like direct tool calls.
        """
        self.config = config
        self.parent_model = parent_model
        self.sandbox_state = sandbox_state
        self.thread_data = thread_data
        self.thread_id = thread_id
        self.local_workspace_root = str(local_workspace_root or "").strip() or None
        # Generate trace_id if not provided (for top-level calls)
        self.trace_id = trace_id or make_trace_id()
        self.extra_context = extra_context
        self.parent_chat_stream_writer = parent_chat_stream_writer
        # Capture the lead-agent runnable context at construction time (still on
        # the graph node thread). LangGraph's ``stream_writer`` calls
        # ``get_config()`` (a contextvar) when invoked; subagents run on an
        # isolated thread + loop, so replay this context when emitting deltas.
        self.parent_context: contextvars.Context | None = None
        if parent_chat_stream_writer is not None:
            self.parent_context = contextvars.copy_context()

        # Filter tools based on config
        self.tools = _filter_tools(
            tools,
            config.tools,
            config.disallowed_tools,
        )

        logger.info(f"[trace={self.trace_id}] SubagentExecutor initialized: {config.name} with {len(self.tools)} tools")

    def _create_agent(
        self,
        *,
        http_async_client: Any | None = None,
        http_client: Any | None = None,
    ):
        """Create the agent instance."""
        model_name = _get_model_name(self.config, self.parent_model)
        logger.info(
            "[trace=%s] Subagent %s using model=%r (parent_model=%r inherit=%s)",
            self.trace_id,
            self.config.name,
            model_name,
            self.parent_model,
            self.config.model,
        )
        model = create_chat_model(
            name=model_name,
            thinking_enabled=False,
            invocation_kind="subagent",
        )
        reset_chat_model_http_clients(model)
        bind_chat_model_http_clients(
            model,
            http_async_client=http_async_client,
            http_client=http_client,
        )

        from evoflow.agents.middlewares.subagent_turn_limit_middleware import SubagentTurnLimitMiddleware
        from evoflow.agents.middlewares.tool_error_handling_middleware import build_subagent_runtime_middlewares

        # Reuse shared middleware composition with lead agent.
        middlewares = build_subagent_runtime_middlewares(lazy_init=True)
        middlewares.append(SubagentTurnLimitMiddleware(self.config.max_turns))

        return create_agent(
            model=model,
            tools=self.tools,
            middleware=middlewares,
            system_prompt=self.config.system_prompt,
            state_schema=ThreadState,
            context_schema=LeadAgentRuntimeContext,
        )

    def _emit_subagent_token_delta(self, payload: Any, *, task_id: str) -> None:
        """Forward a LangGraph ``messages``-mode chunk to the parent chat stream writer.

        Bridges sub-agent LLM token streams (off-graph, thread-pool) onto the main
        SSE custom event channel via ``parent_chat_stream_writer``, so the UI sees
        token-level streaming without the 5s ``task_tool`` polling delay.

        Event shape (consumed by ``evopanel/src/react/subagent-stream-merge.ts``):
            { "type": "subagent_token_delta",
              "task_id": <bg task id>,
              "text": <delta text>,
              "subagent_type": <config name> }
        """
        writer = self.parent_chat_stream_writer
        if writer is None:
            return
        if not isinstance(payload, tuple) or len(payload) < 1:
            return
        msg_chunk = payload[0]
        try:
            from langchain_core.messages import AIMessage as _AI
            from langchain_core.messages import AIMessageChunk as _AIChunk
        except Exception:
            _AI = None  # type: ignore[assignment]
            _AIChunk = None  # type: ignore[assignment]
        is_ai = False
        if _AIChunk is not None and isinstance(msg_chunk, _AIChunk):
            is_ai = True
        elif _AI is not None and isinstance(msg_chunk, _AI):
            is_ai = True
        if not is_ai:
            return
        text = self._extract_text_from_message_chunk(msg_chunk)
        if not text:
            return
        event: dict[str, Any] = {
            "type": "subagent_token_delta",
            "task_id": task_id,
            "text": text,
            "subagent_type": self.config.name,
        }
        if self.extra_context:
            collab_task = str(self.extra_context.get("collab_task_id") or "").strip()
            collab_sub = str(self.extra_context.get("collab_subtask_id") or "").strip()
            if collab_task:
                event["collab_task_id"] = collab_task
            if collab_sub:
                event["collab_subtask_id"] = collab_sub
        parent_context = self.parent_context
        if parent_context is None:
            return

        def _invoke_with_parent_context() -> None:
            try:
                parent_context.run(writer, event)
            except Exception:
                logger.warning(
                    "[trace=%s] subagent_token_delta WRITER-RAISED task_id=%s",
                    self.trace_id,
                    task_id,
                    exc_info=True,
                )

        try:
            _invoke_with_parent_context()
        except Exception:
            logger.warning(
                "[trace=%s] subagent_token_delta EMIT-FAILED task_id=%s",
                self.trace_id,
                task_id,
                exc_info=True,
            )

    @staticmethod
    def _extract_text_from_message_chunk(msg_chunk: Any) -> str:
        """Pull the textual delta out of an AIMessageChunk (str or content-block list)."""
        content = getattr(msg_chunk, "content", None)
        if content is None:
            return ""
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: list[str] = []
            for block in content:
                if isinstance(block, str):
                    parts.append(block)
                elif isinstance(block, dict):
                    # Anthropic-style: {"type": "text", "text": "..."} / "text_delta"
                    text_val = block.get("text")
                    if isinstance(text_val, str):
                        parts.append(text_val)
            return "".join(parts)
        return ""

    def _build_initial_state(self, task: str) -> dict[str, Any]:
        """Build the initial state for agent execution.

        Args:
            task: The task description.

        Returns:
            Initial state dictionary.
        """
        state: dict[str, Any] = {
            "messages": [HumanMessage(content=task)],
        }

        # Pass through sandbox and thread data from parent
        if self.sandbox_state is not None:
            state["sandbox"] = self.sandbox_state
        if self.thread_data is not None:
            state["thread_data"] = self.thread_data

        return state

    async def _aexecute(self, task: str, result_holder: SubagentResult | None = None) -> SubagentResult:
        """Execute a task asynchronously.

        Args:
            task: The task description for the subagent.
            result_holder: Optional pre-created result object to update during execution.

        Returns:
            SubagentResult with the execution result.
        """
        # Log subagent prompt and execution details
        tool_names = [getattr(t, "name", str(t)) for t in self.tools]
        _log_subagent_prompt(
            subagent_name=self.config.name,
            system_prompt=self.config.system_prompt,
            task=task,
            tools=tool_names,
            trace_id=self.trace_id,
        )

        if result_holder is not None:
            # Use the provided result holder (for async execution with real-time updates)
            result = result_holder
        else:
            # Create a new result for synchronous execution
            task_id = make_formatted_id("SubagentTask")
            result = SubagentResult(
                task_id=task_id,
                trace_id=self.trace_id,
                status=SubagentStatus.RUNNING,
                started_at=datetime.now(),
            )

        try:
            final_state = None
            # 恢复继承的场景（子代理在独立线程运行，ContextVar 不跨线程传播）
            try:
                from evoflow.tools.builtins.scenario_activation import (
                    replace_activated_scenarios_from_mission_list,
                )

                inherited = []
                if self.extra_context:
                    inherited = self.extra_context.get("inherited_scenarios") or []
                if not inherited:
                    inherited = ["workspace"]
                replace_activated_scenarios_from_mission_list(inherited)
                logger.info(
                    f"[trace={self.trace_id}] Subagent {self.config.name} activated_scenarios={inherited}"
                )
            except Exception:
                logger.debug("subagent: failed to set inherited scenarios", exc_info=True)
            async with _subagent_loop_local_http_clients() as (http_async_client, http_client):
                agent = self._create_agent(
                    http_async_client=http_async_client,
                    http_client=http_client,
                )
                state = self._build_initial_state(task)

                # LangGraph recursion_limit is graph super-steps; max_turns is semantic model rounds.
                recursion_limit = resolve_subagent_recursion_limit(
                    self.config.max_turns,
                    self.config.recursion_limit,
                )
                run_config: RunnableConfig = {
                    "recursion_limit": recursion_limit,
                }
                resolved_model_name = _get_model_name(self.config, self.parent_model)
                if resolved_model_name:
                    run_config["metadata"] = {"model_name": resolved_model_name}
                raw_ctx: dict[str, Any] = {}
                if self.extra_context:
                    raw_ctx.update(self.extra_context)
                cfg = run_config.setdefault("configurable", {})
                if not isinstance(cfg, dict):
                    cfg = {}
                    run_config["configurable"] = cfg
                if self.thread_id:
                    cfg["thread_id"] = self.thread_id
                    raw_ctx["thread_id"] = self.thread_id
                if resolved_model_name:
                    cfg["model_name"] = resolved_model_name
                    raw_ctx["model_name"] = resolved_model_name
                if self.local_workspace_root:
                    cfg["local_workspace_root"] = self.local_workspace_root
                    raw_ctx["local_workspace_root"] = self.local_workspace_root
                if self.extra_context:
                    for key in ("collab_task_id", "collab_subtask_id", "parent_thread_id"):
                        val = str(self.extra_context.get(key) or "").strip()
                        if val:
                            cfg[key] = val
                            raw_ctx[key] = val
                context = LeadAgentRuntimeContext.from_mapping(raw_ctx)

                logger.info(
                    f"[trace={self.trace_id}] Subagent {self.config.name} starting async execution "
                    f"max_turns={self.config.max_turns} recursion_limit={recursion_limit}"
                )

                # Use stream instead of invoke to get real-time updates
                # Walk full messages list so we capture ToolMessage (tool results), not only last AIMessage.
                stream_upto = 0
                message_count = 0

                from evoflow.scheduler.subagent_stream import subagent_stream_task_id_ctx
                from evoflow.tools.builtins.claude_session_tool import (
                    parent_chat_stream_writer_ctx,
                    use_claude_session_collab_context,
                )

                with (
                    subagent_stream_task_id_ctx(result.task_id),
                    use_claude_session_collab_context(self.extra_context),
                    parent_chat_stream_writer_ctx(self.parent_chat_stream_writer),
                ):
                    # stream_mode=["values", "messages"]：
                    #   - "values"   → 节点完成后的整态快照，用于累计 stream_messages（与原行为一致）
                    #   - "messages" → LLM token 流，逐 chunk 通过 parent_chat_stream_writer 实时
                    #                  推到主 SSE（C 方案：消除 5s 轮询延迟）
                    async for stream_type, payload in agent.astream(  # type: ignore[arg-type]
                        state,
                        config=run_config,
                        context=context,
                        stream_mode=["values", "messages"],
                    ):
                        # 取消检查点：每若干轮检查一次（含 token chunk，所以阈值放大避免频繁锁）
                        message_count += 1
                        if message_count % 50 == 0 and is_task_cancelled(result.task_id):
                            logger.info(f"[trace={self.trace_id}] Subagent {self.config.name} detected cancellation, stopping")
                            raise TaskCancelledError(result.task_id, "Cancelled during execution")

                        if stream_type == "messages":
                            # payload = (AIMessageChunk | ToolMessage, metadata_dict)
                            if message_count <= 5 or message_count % 20 == 0:
                                msg0 = payload[0] if isinstance(payload, tuple) and payload else None
                                logger.info(
                                    "[trace=%s] astream messages chunk #%d payload_type=%s msg_type=%s",
                                    self.trace_id,
                                    message_count,
                                    type(payload).__name__,
                                    type(msg0).__name__ if msg0 is not None else None,
                                )
                            self._emit_subagent_token_delta(payload, task_id=result.task_id)
                            continue

                        # stream_type == "values" → 节点级状态快照
                        if not isinstance(payload, dict):
                            continue
                        final_state = payload
                        messages = payload.get("messages", [])
                        while stream_upto < len(messages):
                            raw = messages[stream_upto]
                            stream_upto += 1
                            if isinstance(raw, AIMessage):
                                message_dict = raw.model_dump()
                                result.stream_messages.append(message_dict)
                                message_id = message_dict.get("id")
                                is_duplicate = False
                                if message_id:
                                    is_duplicate = any(msg.get("id") == message_id for msg in result.ai_messages)
                                else:
                                    is_duplicate = message_dict in result.ai_messages
                                if not is_duplicate:
                                    result.ai_messages.append(message_dict)
                                    logger.info(f"[trace={self.trace_id}] Subagent {self.config.name} captured AI message #{len(result.ai_messages)}")
                            elif isinstance(raw, ToolMessage):
                                result.stream_messages.append(raw.model_dump())
                                logger.info(f"[trace={self.trace_id}] Subagent {self.config.name} captured tool result name={getattr(raw, 'name', None)}")

            logger.info(f"[trace={self.trace_id}] Subagent {self.config.name} completed async execution")

            if final_state is None:
                logger.warning(f"[trace={self.trace_id}] Subagent {self.config.name} no final state")
                result.result = "No response generated"
            else:
                # Extract the final message - find the last AIMessage
                messages = final_state.get("messages", [])
                logger.info(f"[trace={self.trace_id}] Subagent {self.config.name} final messages count: {len(messages)}")

                # Find the last AIMessage in the conversation
                last_ai_message = None
                for msg in reversed(messages):
                    if isinstance(msg, AIMessage):
                        last_ai_message = msg
                        break

                if last_ai_message is not None:
                    content = last_ai_message.content
                    # Handle both str and list content types for the final result
                    if isinstance(content, str):
                        result.result = content
                    elif isinstance(content, list):
                        # Extract text from list of content blocks for final result only.
                        # Concatenate raw string chunks directly, but preserve separation
                        # between full text blocks for readability.
                        text_parts = []
                        pending_str_parts = []
                        for block in content:
                            if isinstance(block, str):
                                pending_str_parts.append(block)
                            elif isinstance(block, dict):
                                if pending_str_parts:
                                    text_parts.append("".join(pending_str_parts))
                                    pending_str_parts.clear()
                                text_val = block.get("text")
                                if isinstance(text_val, str):
                                    text_parts.append(text_val)
                        if pending_str_parts:
                            text_parts.append("".join(pending_str_parts))
                        result.result = "\n".join(text_parts) if text_parts else "No text content in response"
                    else:
                        result.result = str(content)
                elif messages:
                    # Fallback: use the last message if no AIMessage found
                    last_message = messages[-1]
                    logger.warning(f"[trace={self.trace_id}] Subagent {self.config.name} no AIMessage found, using last message: {type(last_message)}")
                    raw_content = last_message.content if hasattr(last_message, "content") else str(last_message)
                    if isinstance(raw_content, str):
                        result.result = raw_content
                    elif isinstance(raw_content, list):
                        parts = []
                        pending_str_parts = []
                        for block in raw_content:
                            if isinstance(block, str):
                                pending_str_parts.append(block)
                            elif isinstance(block, dict):
                                if pending_str_parts:
                                    parts.append("".join(pending_str_parts))
                                    pending_str_parts.clear()
                                text_val = block.get("text")
                                if isinstance(text_val, str):
                                    parts.append(text_val)
                        if pending_str_parts:
                            parts.append("".join(pending_str_parts))
                        result.result = "\n".join(parts) if parts else "No text content in response"
                    else:
                        result.result = str(raw_content)
                else:
                    logger.warning(f"[trace={self.trace_id}] Subagent {self.config.name} no messages in final state")
                    result.result = "No response generated"

            result.status = SubagentStatus.COMPLETED
            result.completed_at = datetime.now()

        except TaskCancelledError as e:
            # 【新增】处理任务取消
            logger.info(f"[trace={self.trace_id}] Subagent {self.config.name} execution cancelled")
            result.status = SubagentStatus.CANCELLED
            result.error = f"Task cancelled: {e}"
            result.completed_at = datetime.now()

        except Exception as e:
            logger.exception(f"[trace={self.trace_id}] Subagent {self.config.name} async execution failed")
            result.status = SubagentStatus.FAILED
            result.error = str(e)
            result.completed_at = datetime.now()

        return result

    def execute(self, task: str, result_holder: SubagentResult | None = None) -> SubagentResult:
        """Execute a task synchronously (wrapper around async execution).

        This method runs the async execution in a new event loop, allowing
        asynchronous tools (like MCP tools) to be used within the thread pool.

        Args:
            task: The task description for the subagent.
            result_holder: Optional pre-created result object to update during execution.

        Returns:
            SubagentResult with the execution result.
        """
        # Run the async execution in a new event loop
        # This is necessary because:
        # 1. We may have async-only tools (like MCP tools)
        # 2. We're running inside a ThreadPoolExecutor which doesn't have an event loop
        #
        # Note: _aexecute() catches all exceptions internally, so this outer
        # try-except only handles loop bootstrap failures (e.g., if called from
        # an async context where an event loop already exists). Subagent execution
        # errors are handled within _aexecute() and returned as FAILED status.
        try:
            return run_coroutine_on_fresh_loop(self._aexecute(task, result_holder))
        except Exception as e:
            logger.exception(f"[trace={self.trace_id}] Subagent {self.config.name} execution failed")
            # Create a result with error if we don't have one
            if result_holder is not None:
                result = result_holder
            else:
                result = SubagentResult(
                    task_id=make_formatted_id("SubagentTask"),
                    trace_id=self.trace_id,
                    status=SubagentStatus.FAILED,
                )
            result.status = SubagentStatus.FAILED
            result.error = str(e)
            result.completed_at = datetime.now()
            return result

    def _cleanup_on_cancel(self, task_id: str) -> None:
        """Cleanup resources when a task is cancelled.

        Args:
            task_id: The task ID that was cancelled.
        """
        logger.info(f"[trace={self.trace_id}] Cleaning up cancelled task {task_id}")

        # Clean up background task entry
        try:
            cleanup_background_task(task_id)
        except Exception as e:
            logger.warning(f"[trace={self.trace_id}] Failed to cleanup background task {task_id}: {e}")

        # Log cancellation details
        logger.info(f"[trace={self.trace_id}] Task {task_id} cancelled - executor: {self.config.name}")

    def execute_async(self, task: str, task_id: str | None = None) -> str:
        """Start a task execution in the background.

        Args:
            task: The task description for the subagent.
            task_id: Optional task ID to use. If not provided, a random UUID will be generated.

        Returns:
            Task ID that can be used to check status later.
        """
        # Use provided task_id or generate a new one
        if task_id is None:
            task_id = make_formatted_id("SubagentTask")

        # Create initial pending result
        result = SubagentResult(
            task_id=task_id,
            trace_id=self.trace_id,
            status=SubagentStatus.PENDING,
        )

        logger.info(f"[trace={self.trace_id}] Subagent {self.config.name} starting async execution, task_id={task_id}, timeout={self.config.timeout_seconds}s")

        # 【新增】记录任务提交信息
        logger.debug(f"[trace={self.trace_id}] Task {task_id} submitted to scheduler pool for subagent {self.config.name}")

        with _background_tasks_lock:
            _background_tasks[task_id] = result

        # Submit to scheduler pool
        def run_task():
            # 【新增】开始时检查是否已被取消
            if is_task_cancelled(task_id):
                logger.info(f"[trace={self.trace_id}] Subagent {self.config.name} task {task_id} already cancelled before starting")
                with _background_tasks_lock:
                    _background_tasks[task_id].status = SubagentStatus.CANCELLED
                    _background_tasks[task_id].error = "Task cancelled before execution started"
                    _background_tasks[task_id].completed_at = datetime.now()

                # 【新增】调用清理方法
                self._cleanup_on_cancel(task_id)
                return

            with _background_tasks_lock:
                _background_tasks[task_id].status = SubagentStatus.RUNNING
                _background_tasks[task_id].started_at = datetime.now()
                result_holder = _background_tasks[task_id]

                # 【新增】记录任务开始执行
                logger.debug(f"[trace={self.trace_id}] Task {task_id} status changed to RUNNING for subagent {self.config.name}")

            try:
                # Submit execution to execution pool with timeout
                # Pass result_holder so execute() can update it in real-time
                execution_future: Future = _execution_pool.submit(self.execute, task, result_holder)
                try:
                    # Wait for execution with timeout
                    exec_result = execution_future.result(timeout=self.config.timeout_seconds)

                    # 【新增】记录任务完成状态
                    logger.debug(f"[trace={self.trace_id}] Task {task_id} execution completed with status: {exec_result.status.value}")

                    with _background_tasks_lock:
                        ent = _background_tasks.get(task_id)
                        if ent is None:
                            # task_tool cleanup_background_task may have removed the entry first (race).
                            logger.debug(
                                "[trace=%s] background task %s missing after execute (already cleaned up)",
                                self.trace_id,
                                task_id,
                            )
                        else:
                            ent.status = exec_result.status
                            ent.result = exec_result.result
                            ent.error = exec_result.error
                            ent.completed_at = datetime.now()
                            ent.ai_messages = exec_result.ai_messages
                            ent.stream_messages = exec_result.stream_messages
                except FuturesTimeoutError:
                    logger.error(f"[trace={self.trace_id}] Subagent {self.config.name} execution timed out after {self.config.timeout_seconds}s")

                    # 【新增】记录超时详情
                    logger.warning(f"[trace={self.trace_id}] Task {task_id} timed out - subagent: {self.config.name}, timeout: {self.config.timeout_seconds}s")

                    with _background_tasks_lock:
                        _background_tasks[task_id].status = SubagentStatus.TIMED_OUT
                        _background_tasks[task_id].error = f"Execution timed out after {self.config.timeout_seconds} seconds"
                        _background_tasks[task_id].completed_at = datetime.now()
                    # Cancel the future (best effort - may not stop the actual execution)
                    execution_future.cancel()
            except Exception as e:
                logger.exception(f"[trace={self.trace_id}] Subagent {self.config.name} async execution failed")

                # 【新增】记录异常详情
                logger.error(f"[trace={self.trace_id}] Task {task_id} failed with exception: {type(e).__name__}: {e}")

                with _background_tasks_lock:
                    ent = _background_tasks.get(task_id)
                    if ent is not None:
                        ent.status = SubagentStatus.FAILED
                        ent.error = str(e)
                        ent.completed_at = datetime.now()

        _scheduler_pool.submit(run_task)
        return task_id


MAX_CONCURRENT_SUBAGENTS = 5


def get_background_task_result(task_id: str) -> SubagentResult | None:
    """Get the result of a background task.

    Args:
        task_id: The task ID returned by execute_async.

    Returns:
        SubagentResult if found, None otherwise.
    """
    with _background_tasks_lock:
        return _background_tasks.get(task_id)


def get_background_task_result_or_snapshot(task_id: str) -> SubagentResult | None:
    """Get a task result from the live store, falling back to the post-cleanup snapshot.

    Used by the SubagentTranscriptModal polling endpoint so that users can still
    open the modal after the task_tool has called ``cleanup_background_task``.
    """
    with _background_tasks_lock:
        live = _background_tasks.get(task_id)
    if live is not None:
        return live
    with _completed_task_snapshots_lock:
        return _completed_task_snapshots.get(task_id)


def list_background_tasks() -> list[SubagentResult]:
    """List all background tasks.

    Returns:
        List of all SubagentResult instances.
    """
    with _background_tasks_lock:
        return list(_background_tasks.values())


def cleanup_background_task(task_id: str) -> None:
    """Remove a completed task from background tasks.

    Should be called by task_tool after it finishes polling and returns the result.
    This prevents memory leaks from accumulated completed tasks.

    Only removes tasks that are in a terminal state (COMPLETED/FAILED/TIMED_OUT)
    to avoid race conditions with the background executor still updating the task entry.

    Args:
        task_id: The task ID to remove.
    """
    with _background_tasks_lock:
        result = _background_tasks.get(task_id)
        if result is None:
            # Nothing to clean up; may have been removed already.
            logger.debug("Requested cleanup for unknown background task %s", task_id)
            return

        # Only clean up tasks that are in a terminal state to avoid races with
        # the background executor still updating the task entry.
        is_terminal_status = result.status in {
            SubagentStatus.COMPLETED,
            SubagentStatus.FAILED,
            SubagentStatus.TIMED_OUT,
            SubagentStatus.CANCELLED,
        }
        if is_terminal_status or result.completed_at is not None:
            # Snapshot to the long-lived store before deletion so the frontend
            # SubagentTranscriptModal polling endpoint can still serve transcripts.
            with _completed_task_snapshots_lock:
                _completed_task_snapshots[task_id] = result
                _completed_task_snapshots.move_to_end(task_id)
                while len(_completed_task_snapshots) > _COMPLETED_SNAPSHOTS_CAP:
                    _completed_task_snapshots.popitem(last=False)
            del _background_tasks[task_id]
            logger.debug("Cleaned up background task: %s (snapshot retained)", task_id)
        else:
            logger.debug(
                "Skipping cleanup for non-terminal background task %s (status=%s)",
                task_id,
                result.status.value if hasattr(result.status, "value") else result.status,
            )
