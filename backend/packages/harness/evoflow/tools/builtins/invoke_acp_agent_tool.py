"""Built-in tool for invoking external ACP-compatible agents."""

import asyncio
import json
import logging
import os
import shutil
from datetime import datetime
from pathlib import Path
from typing import Annotated, Any

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import BaseTool, InjectedToolArg, StructuredTool
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

_ACP_RUNTIME_SESSIONS: dict[str, dict[str, Any]] = {}


def _acp_debug_log_path() -> Path:
    # User-overridable path for debugging stream bridge.
    p = (os.getenv("EVOFLOW_ACP_DEBUG_LOG") or "").strip()
    if p:
        return Path(p)
    default_dir = Path.cwd() / "logs" / "acp_debug"
    if default_dir.exists() or default_dir.parent.exists():
        return default_dir / "acp_bridge_debug.log"
    return Path.cwd() / "logs" / "acp_debug" / "acp_bridge_debug.log"


def _write_acp_debug(event: str, payload: dict[str, Any]) -> None:
    try:
        path = _acp_debug_log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        row = {
            "ts": datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3],
            "event": event,
            **payload,
        }
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    except Exception:
        logger.debug("write acp debug log failed", exc_info=True)


def _to_jsonable(value: Any) -> Any:
    """Best-effort conversion of ACP objects to JSON-friendly structures."""
    try:
        if value is None or isinstance(value, (str, int, float, bool)):
            return value
        if isinstance(value, dict):
            return {str(k): _to_jsonable(v) for k, v in value.items()}
        if isinstance(value, (list, tuple, set)):
            return [_to_jsonable(v) for v in value]
        if hasattr(value, "model_dump") and callable(getattr(value, "model_dump")):
            return _to_jsonable(value.model_dump())
        if hasattr(value, "dict") and callable(getattr(value, "dict")):
            return _to_jsonable(value.dict())
        if hasattr(value, "__dict__"):
            return _to_jsonable(vars(value))
        return str(value)
    except Exception:
        return str(value)


class _InvokeACPAgentInput(BaseModel):
    agent: str = Field(description="Name of the ACP agent to invoke")
    prompt: str = Field(default="", description="The concise task prompt to send to the agent")
    action: str = Field(
        default="send",
        description="ACP session action: send(default), start, status, close, cancel, read",
    )
    supervisor_session_id: str | None = Field(
        default=None,
        description="Supervisor ACP session id for multi-turn conversation reuse",
    )
    task_id: str | None = Field(default=None, description="Optional collab task id")
    subtask_id: str | None = Field(default=None, description="Optional collab subtask id")
    project_path: str | None = Field(
        default=None,
        description="Optional ACP working directory override (preferred on session start)",
    )


def _get_work_dir(thread_id: str | None, project_path: str | None = None) -> str:
    """Get the per-thread ACP workspace directory.

    Each thread gets an isolated workspace under
    ``{base_dir}/threads/{thread_id}/acp-workspace/`` so that concurrent
    sessions cannot read or overwrite each other's ACP agent outputs.

    Falls back to the legacy global ``{base_dir}/acp-workspace/`` when
    ``thread_id`` is not available (e.g. embedded / direct invocation).

    The directory is created automatically if it does not exist.

    Returns:
        An absolute physical filesystem path to use as the working directory.
    """
    from evoflow.config.paths import get_paths

    override = str(project_path or "").strip()
    if override:
        try:
            os.makedirs(override, exist_ok=True)
            logger.info("ACP agent work_dir (override): %s", override)
            return override
        except Exception:
            logger.warning("Invalid ACP project_path %r, fallback to thread workspace", override, exc_info=True)

    paths = get_paths()
    if thread_id:
        try:
            work_dir = paths.acp_workspace_dir(thread_id)
        except ValueError:
            logger.warning("Invalid thread_id %r for ACP workspace, falling back to global", thread_id)
            work_dir = paths.base_dir / "acp-workspace"
    else:
        work_dir = paths.base_dir / "acp-workspace"

    work_dir.mkdir(parents=True, exist_ok=True)
    logger.info("ACP agent work_dir: %s", work_dir)
    return str(work_dir)


def _build_mcp_servers() -> dict[str, dict[str, Any]]:
    """Build ACP ``mcpServers`` config from EvoFlow's enabled MCP servers."""
    from evoflow.config.extensions_config import ExtensionsConfig
    from evoflow.mcp.client import build_servers_config

    return build_servers_config(ExtensionsConfig.from_db())


def _build_permission_response(options: list[Any], *, auto_approve: bool) -> Any:
    """Build an ACP permission response.

    When ``auto_approve`` is True, selects the first ``allow_once`` (preferred)
    or ``allow_always`` option.  When False (the default), always cancels —
    permission requests must be handled by the ACP agent's own policy or the
    agent must be configured to operate without requesting permissions.
    """
    from acp import RequestPermissionResponse
    from acp.schema import AllowedOutcome, DeniedOutcome

    if auto_approve:
        for preferred_kind in ("allow_once", "allow_always"):
            for option in options:
                if getattr(option, "kind", None) != preferred_kind:
                    continue

                option_id = getattr(option, "option_id", None)
                if option_id is None:
                    option_id = getattr(option, "optionId", None)
                if option_id is None:
                    continue

                return RequestPermissionResponse(
                    outcome=AllowedOutcome(outcome="selected", optionId=option_id),
                )

    return RequestPermissionResponse(outcome=DeniedOutcome(outcome="cancelled"))


def _format_invocation_error(agent: str, cmd: str, exc: Exception) -> str:
    """Return a user-facing ACP invocation error with actionable remediation."""
    if not isinstance(exc, FileNotFoundError):
        return f"Error invoking ACP agent '{agent}': {exc}"

    message = f"Error invoking ACP agent '{agent}': Command '{cmd}' was not found on PATH."
    if cmd == "external-agent-acp":
        return (
            f"{message} The installed CLI may not speak ACP directly. "
            "Install an ACP adapter (for example `npx @zed-industries/claude-agent-acp`) "
            f"or update `acp_agents.{agent}.command` and `args` in config.yaml."
        )

    return f"{message} Install the agent binary or update `acp_agents.{agent}.command` in config.yaml."


def build_invoke_acp_agent_tool(agents: dict[str, Any] | None = None) -> BaseTool:
    """Create the ``invoke_acp_agent`` tool with a description generated from configured agents.

    The tool description includes the list of available agents so that the LLM
    knows which agents it can invoke without requiring hardcoded names.

    Returns:
        A LangChain ``BaseTool`` ready to be included in the tool list.
    """
    if agents is None:
        # Load ACP agents from filesystem
        from evoflow.config.agents_config import list_acp_agents

        acp_agent_configs = list_acp_agents()
        agents = {cfg.name: cfg for cfg in acp_agent_configs}

    agent_lines = "\n".join(f"- {name}: {cfg.description}" for name, cfg in agents.items())
    description = (
        "Invoke an external ACP-compatible agent and return its final response.\n\n"
        "Available agents:\n"
        f"{agent_lines}\n\n"
        "IMPORTANT: ACP agents operate in their own independent workspace. "
        "Do NOT include /mnt/user-data paths in the prompt. "
        "Give the agent a self-contained task description — it will produce results in its own workspace. "
        "After the agent completes, its output files are accessible at /mnt/acp-workspace/ (read-only)."
    )

    # Capture agents in closure so the function can reference it
    _agents = dict(agents)

    async def _invoke(agent: str, prompt: str, config: Annotated[RunnableConfig, InjectedToolArg] = None) -> str:
        return await _invoke_with_action(
            agent=agent,
            prompt=prompt,
            action="send",
            supervisor_session_id=None,
            task_id=None,
            subtask_id=None,
            config=config,
        )

    async def _invoke_with_action(
        agent: str,
        prompt: str = "",
        action: str = "send",
        supervisor_session_id: str | None = None,
        task_id: str | None = None,
        subtask_id: str | None = None,
        project_path: str | None = None,
        config: Annotated[RunnableConfig, InjectedToolArg] = None,
    ) -> str:
        _write_acp_debug(
            "invoke_action",
            {
                "agent": agent,
                "action": action,
                "task_id": task_id,
                "subtask_id": subtask_id,
                "supervisor_session_id": supervisor_session_id,
                "prompt_len": len(prompt or ""),
            },
        )
        logger.info("Invoking ACP agent %s (prompt length: %d)", agent, len(prompt))
        logger.debug("Invoking ACP agent %s with prompt: %.200s%s", agent, prompt, "..." if len(prompt) > 200 else "")
        if agent not in _agents:
            available = ", ".join(_agents.keys())
            return f"Error: Unknown agent '{agent}'. Available: {available}"

        agent_config = _agents[agent]
        thread_id: str | None = ((config or {}).get("configurable") or {}).get("thread_id")

        try:
            from acp import PROTOCOL_VERSION, Client, text_block
            from acp.schema import ClientCapabilities, Implementation
        except ImportError:
            return "Error: agent-client-protocol package is not installed. Run `uv sync` to install project dependencies."

        from evoflow.tools.builtins.supervisor.acp_session_registry import (
            close as close_session_record,
        )
        from evoflow.tools.builtins.supervisor.acp_session_registry import (
            get_or_create,
            require_existing,
            update_status,
        )

        act = str(action or "send").strip().lower()
        if act not in {"start", "send", "status", "close", "cancel", "read"}:
            return f"Error: Unsupported action '{action}'. Supported: start, send, status, close, cancel, read"

        # Capture stream writer early so background ACP callbacks can still emit
        # custom events even when get_stream_writer() is unavailable.
        writer_cb = None
        try:
            from langgraph.config import get_stream_writer as _gsw

            writer_cb = _gsw()
        except Exception:
            writer_cb = None

        session_record = None
        if supervisor_session_id:
            session_record = require_existing(supervisor_session_id)
        if session_record is None and (act == "start" or (act == "send" and supervisor_session_id)):
            session_record = get_or_create(
                provider=agent,
                thread_id=thread_id,
                task_id=task_id,
                subtask_id=subtask_id,
            )
            supervisor_session_id = session_record.supervisor_session_id

        class _CollectingClient(Client):
            """Minimal ACP Client that collects streamed text from session updates."""

            def __init__(self, writer_cb) -> None:
                self._chunks: list[str] = []
                self._updates: list[str] = []
                self._writer_cb = writer_cb

            @property
            def collected_text(self) -> str:
                return "".join(self._chunks)

            async def session_update(self, session_id: str, update, **kwargs) -> None:  # type: ignore[override]
                try:
                    from acp.schema import TextContentBlock

                    update_name = getattr(update, "session_update", None) or getattr(update, "sessionUpdate", None) or type(update).__name__
                    self._updates.append(str(update_name))
                    _write_acp_debug(
                        "session_update",
                        {
                            "agent": agent,
                            "update_name": str(update_name),
                            "acp_session_id": session_id,
                            "supervisor_session_id": supervisor_session_id,
                            "task_id": task_id,
                            "subtask_id": subtask_id,
                            "update_raw": _to_jsonable(update),
                        },
                    )
                    if hasattr(update, "content") and isinstance(update.content, TextContentBlock):
                        self._chunks.append(update.content.text)
                        progressive_text = self.collected_text
                        _write_acp_debug(
                            "session_chunk",
                            {
                                "agent": agent,
                                "acp_session_id": session_id,
                                "supervisor_session_id": supervisor_session_id,
                                "task_id": task_id,
                                "subtask_id": subtask_id,
                                "chunk": update.content.text,
                                "chunk_len": len(update.content.text or ""),
                                "progressive_len": len(progressive_text or ""),
                            },
                        )
                        if supervisor_session_id:
                            update_status(supervisor_session_id, chunk_seen=True, status="streaming")
                        # Detached ACP callbacks may run outside LangGraph runtime
                        # (no __pregel_runtime), so do NOT emit custom stream here.
                        # Instead buffer chunks and let monitor_execution_step flush
                        # them with a valid runtime writer.
                        try:
                            if supervisor_session_id:
                                from evoflow.tools.builtins.supervisor.acp_session_registry import append_stream_chunk

                                append_stream_chunk(
                                    supervisor_session_id,
                                    subtask_id=subtask_id,
                                    chunk=update.content.text,
                                )
                        except Exception:
                            pass
                        try:
                            from evoflow.tools.builtins.supervisor.acp_event_bus import emit_acp_stream_delta

                            asyncio.create_task(
                                emit_acp_stream_delta(
                                    main_task_id=task_id,
                                    provider=agent,
                                    supervisor_session_id=supervisor_session_id,
                                    subtask_id=subtask_id,
                                    chunk=update.content.text,
                                    progressive_text=progressive_text,
                                )
                            )
                        except Exception:
                            pass
                except Exception:
                    pass

            async def request_permission(self, options, session_id: str, tool_call, **kwargs):  # type: ignore[override]
                response = _build_permission_response(options, auto_approve=agent_config.auto_approve_permissions)
                outcome = response.outcome.outcome
                if outcome == "selected":
                    logger.info("ACP permission auto-approved for tool call %s in session %s", tool_call.tool_call_id, session_id)
                else:
                    logger.warning("ACP permission denied for tool call %s in session %s (set auto_approve_permissions: true in config.yaml to enable)", tool_call.tool_call_id, session_id)
                return response

        # status/read actions can serve from in-memory registry.
        if act == "status":
            if not supervisor_session_id:
                return json.dumps({"ok": False, "error": "supervisor_session_id is required for status"}, ensure_ascii=False)
            rec = require_existing(supervisor_session_id)
            if not rec:
                return json.dumps({"ok": False, "error": "session not found", "supervisor_session_id": supervisor_session_id}, ensure_ascii=False)
            runtime = _ACP_RUNTIME_SESSIONS.get(supervisor_session_id)
            if runtime:
                proc = runtime.get("proc")
                if proc is not None and getattr(proc, "returncode", None) is not None:
                    update_status(supervisor_session_id, status="failed", error=f"process exited: {proc.returncode}")
                    rec = require_existing(supervisor_session_id)
            return json.dumps(
                {
                    "ok": True,
                    "provider": agent,
                    "supervisor_session_id": supervisor_session_id,
                    "acp_session_id": getattr(rec, "acp_session_id", None),
                    "status": getattr(rec, "status", "unknown"),
                    "turn_index": getattr(rec, "turn_index", 0),
                    "last_error": getattr(rec, "last_error", None),
                },
                ensure_ascii=False,
            )

        if act == "read":
            if not supervisor_session_id:
                return json.dumps({"ok": False, "error": "supervisor_session_id is required for read"}, ensure_ascii=False)
            runtime = _ACP_RUNTIME_SESSIONS.get(supervisor_session_id)
            if not runtime:
                return json.dumps({"ok": False, "error": "no active runtime for this session"}, ensure_ascii=False)
            client = runtime.get("client")
            text = client.collected_text if client else ""
            return json.dumps({"ok": True, "supervisor_session_id": supervisor_session_id, "text": text}, ensure_ascii=False)

        if act in {"close", "cancel"}:
            if not supervisor_session_id:
                return json.dumps({"ok": False, "error": "supervisor_session_id is required"}, ensure_ascii=False)
            runtime = _ACP_RUNTIME_SESSIONS.pop(supervisor_session_id, None)
            if not runtime:
                close_session_record(supervisor_session_id)
                return json.dumps({"ok": True, "supervisor_session_id": supervisor_session_id, "closed": False}, ensure_ascii=False)
            try:
                if act == "cancel":
                    conn = runtime.get("conn")
                    acp_sid = runtime.get("acp_session_id")
                    if conn is not None and acp_sid:
                        try:
                            await conn.cancel(session_id=acp_sid)
                        except Exception:
                            pass
                ctx = runtime.get("ctx")
                if ctx is not None:
                    await ctx.__aexit__(None, None, None)
                close_session_record(supervisor_session_id)
                try:
                    from evoflow.tools.builtins.supervisor.acp_event_bus import emit_acp_status_update

                    await emit_acp_status_update(
                        main_task_id=task_id,
                        provider=agent,
                        supervisor_session_id=supervisor_session_id,
                        subtask_id=subtask_id,
                        status="closed" if act == "close" else "cancelled",
                    )
                except Exception:
                    pass
                return json.dumps({"ok": True, "supervisor_session_id": supervisor_session_id, "closed": True}, ensure_ascii=False)
            except Exception as e:
                update_status(supervisor_session_id, status="failed", error=str(e))
                try:
                    from evoflow.tools.builtins.supervisor.acp_event_bus import emit_acp_stream_error

                    await emit_acp_stream_error(
                        main_task_id=task_id,
                        provider=agent,
                        supervisor_session_id=supervisor_session_id,
                        subtask_id=subtask_id,
                        error=str(e),
                    )
                except Exception:
                    pass
                return json.dumps({"ok": False, "error": str(e), "supervisor_session_id": supervisor_session_id}, ensure_ascii=False)

        client = _CollectingClient(writer_cb)
        cmd = agent_config.command
        args = agent_config.args or []
        physical_cwd = _get_work_dir(thread_id, project_path)
        mcp_servers = _build_mcp_servers()
        agent_env: dict[str, str] | None = None
        if agent_config.env:
            agent_env = {k: (os.environ.get(v[1:], "") if v.startswith("$") else v) for k, v in agent_config.env.items()}

        try:
            from acp import spawn_agent_process

            # Backward-compatible one-shot mode:
            # when action=send and no supervisor_session_id is provided,
            # execute exactly one prompt and return plain text.
            if act == "send" and not supervisor_session_id:
                async with spawn_agent_process(client, cmd, *args, env=agent_env, cwd=physical_cwd) as (conn, proc):
                    logger.info("Spawning ACP agent '%s' with command '%s' and args %s in cwd %s", agent, cmd, args, physical_cwd)
                    await conn.initialize(
                        protocol_version=PROTOCOL_VERSION,
                        client_capabilities=ClientCapabilities(),
                        client_info=Implementation(name="evoflow", title="EvoFlow", version="1.0.0"),
                    )
                    session_kwargs: dict[str, Any] = {"cwd": physical_cwd, "mcp_servers": mcp_servers}
                    if agent_config.model:
                        session_kwargs["model"] = agent_config.model
                    session = await conn.new_session(**session_kwargs)
                    await conn.prompt(
                        session_id=session.session_id,
                        prompt=[text_block(prompt)],
                    )
                result = client.collected_text
                logger.info("ACP agent '%s' returned %s", agent, result[:1000])
                logger.info("ACP agent '%s' returned %d characters", agent, len(result))
                return result or "(no response)"
            runtime = _ACP_RUNTIME_SESSIONS.get(supervisor_session_id or "")
            if runtime is None:
                ctx = spawn_agent_process(client, cmd, *args, env=agent_env, cwd=physical_cwd)
                conn, proc = await ctx.__aenter__()
                logger.info("Spawning ACP agent '%s' with command '%s' and args %s in cwd %s", agent, cmd, args, physical_cwd)
                await conn.initialize(
                    protocol_version=PROTOCOL_VERSION,
                    client_capabilities=ClientCapabilities(),
                    client_info=Implementation(name="evoflow", title="EvoFlow", version="1.0.0"),
                )
                session_kwargs: dict[str, Any] = {"cwd": physical_cwd, "mcp_servers": mcp_servers}
                if agent_config.model:
                    session_kwargs["model"] = agent_config.model
                session = await conn.new_session(**session_kwargs)
                if supervisor_session_id:
                    update_status(supervisor_session_id, acp_session_id=session.session_id, status="running")
                    try:
                        from evoflow.tools.builtins.supervisor.acp_event_bus import emit_acp_status_update

                        await emit_acp_status_update(
                            main_task_id=task_id,
                            provider=agent,
                            supervisor_session_id=supervisor_session_id,
                            subtask_id=subtask_id,
                            status="running",
                        )
                    except Exception:
                        pass
                runtime = {
                    "ctx": ctx,
                    "conn": conn,
                    "proc": proc,
                    "client": client,
                    "acp_session_id": session.session_id,
                    "provider": agent,
                }
                if supervisor_session_id:
                    _ACP_RUNTIME_SESSIONS[supervisor_session_id] = runtime

            conn = runtime["conn"]
            acp_sid = runtime["acp_session_id"]
            if act == "start":
                _write_acp_debug(
                    "session_started",
                    {
                        "agent": agent,
                        "supervisor_session_id": supervisor_session_id,
                        "acp_session_id": acp_sid,
                        "task_id": task_id,
                        "subtask_id": subtask_id,
                        "cwd": physical_cwd,
                    },
                )
                return json.dumps(
                    {
                        "ok": True,
                        "provider": agent,
                        "supervisor_session_id": supervisor_session_id,
                        "acp_session_id": acp_sid,
                        "status": "running",
                    },
                    ensure_ascii=False,
                )

            await conn.prompt(
                session_id=acp_sid,
                prompt=[text_block(prompt)],
            )
            result = runtime["client"].collected_text
            if supervisor_session_id:
                update_status(supervisor_session_id, completed=True, status="completed")
                try:
                    from evoflow.tools.builtins.supervisor.acp_session_registry import set_final_result

                    set_final_result(supervisor_session_id, result=result or "")
                except Exception:
                    pass
            try:
                from langgraph.config import get_stream_writer

                writer = get_stream_writer()
                writer(
                    {
                        "type": "acp_stream_done",
                        "provider": agent,
                        "supervisor_session_id": supervisor_session_id,
                        "task_id": task_id,
                        "subtask_id": subtask_id,
                        "result": result,
                    }
                )
            except Exception:
                pass
            try:
                from evoflow.tools.builtins.supervisor.acp_event_bus import emit_acp_stream_done

                await emit_acp_stream_done(
                    main_task_id=task_id,
                    provider=agent,
                    supervisor_session_id=supervisor_session_id,
                    subtask_id=subtask_id,
                    result=result or "(no response)",
                )
            except Exception:
                pass

            logger.info("ACP agent '%s' returned %s", agent, result[:1000])
            logger.info("ACP agent '%s' returned %d characters", agent, len(result))
            if act == "send" and supervisor_session_id:
                _write_acp_debug(
                    "send_done",
                    {
                        "agent": agent,
                        "supervisor_session_id": supervisor_session_id,
                        "acp_session_id": acp_sid,
                        "task_id": task_id,
                        "subtask_id": subtask_id,
                        "result_len": len(result or ""),
                        "result_preview": (result or "")[:500],
                    },
                )
                return json.dumps(
                    {
                        "ok": True,
                        "provider": agent,
                        "supervisor_session_id": supervisor_session_id,
                        "acp_session_id": acp_sid,
                        "status": "completed",
                        "result": result or "(no response)",
                    },
                    ensure_ascii=False,
                )
            return result or "(no response)"
        except Exception as e:
            logger.error("ACP agent '%s' invocation failed: %s", agent, e)
            if supervisor_session_id:
                update_status(supervisor_session_id, status="failed", error=str(e))
            try:
                from evoflow.tools.builtins.supervisor.acp_event_bus import emit_acp_stream_error

                await emit_acp_stream_error(
                    main_task_id=task_id,
                    provider=agent,
                    supervisor_session_id=supervisor_session_id,
                    subtask_id=subtask_id,
                    error=str(e),
                )
            except Exception:
                pass
            return _format_invocation_error(agent, cmd, e)

    return StructuredTool.from_function(
        name="invoke_acp_agent",
        description=description,
        coroutine=_invoke_with_action,
        args_schema=_InvokeACPAgentInput,
    )
