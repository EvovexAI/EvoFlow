"""LangChain tools for Hermes-ported external memory providers (mem0, honcho, …)."""

from __future__ import annotations

import logging
from typing import Any

from langchain.tools import BaseTool
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, ConfigDict, Field, create_model

logger = logging.getLogger(__name__)


def _openai_function_schema_to_model(schema: dict) -> type[BaseModel]:
    """Build a Pydantic model from an OpenAI-style function ``parameters`` object."""
    name = schema.get("name", "DynMemTool")
    safe = "".join(c if c.isalnum() or c == "_" else "_" for c in name)
    if not safe:
        safe = "DynMemTool"
    if safe[0].isdigit():
        safe = "T_" + safe

    params = schema.get("parameters") or {}
    props = params.get("properties") or {}
    required = set(params.get("required") or [])
    fields: dict[str, Any] = {}

    for pname, pspec in props.items():
        jt = pspec.get("type", "string")
        desc = str(pspec.get("description", ""))
        if jt == "string":
            py_t: Any = str
        elif jt == "integer":
            py_t = int
        elif jt == "number":
            py_t = float
        elif jt == "boolean":
            py_t = bool
        elif jt == "array":
            py_t = list[Any]
        elif jt == "object":
            py_t = dict[str, Any]
        else:
            py_t = Any

        if pname in required:
            fields[pname] = (py_t, Field(description=desc))
        else:
            fields[pname] = (py_t | None, Field(default=None, description=desc))

    if not fields:
        return create_model(safe, __config__=ConfigDict(extra="forbid"))  # type: ignore[call-overload]

    return create_model(safe, __config__=ConfigDict(extra="forbid"), **fields)  # type: ignore[call-overload]


def build_hermes_external_memory_langchain_tools() -> list[BaseTool]:
    """Schemas from the active Hermes ``MemoryManager``, bound to the process singleton."""
    from langgraph.config import get_config

    from evoflow.agents.memory_plugins.memory_orchestrator import MemoryOrchestrator
    from evoflow.agents.memory_plugins.manager import get_external_memory_plugin_manager
    from evoflow.config.memory_config import get_memory_config

    wanted = (get_memory_config().external_provider or "").strip().lower()
    if not wanted or wanted == "echo":
        return []

    mgr = get_external_memory_plugin_manager()
    if mgr is None or not isinstance(mgr, MemoryOrchestrator):
        return []

    mm = mgr.memory_manager
    out: list[BaseTool] = []

    for schema in mm.get_all_tool_schemas():
        try:
            model = _openai_function_schema_to_model(schema)
        except Exception as e:
            logger.warning("Skip memory tool %r: schema→model failed: %s", schema.get("name"), e)
            continue

        tool_name = schema["name"]

        def _make_runner(tn: str):
            def _run(**kwargs: Any) -> str:
                cfg = get_config()
                tid = ""
                if cfg:
                    tid = str((cfg.get("configurable") or {}).get("thread_id") or "")
                m = get_external_memory_plugin_manager()
                if not isinstance(m, MemoryOrchestrator):
                    return '{"error":"external_hermes_memory_not_active"}'
                m.ensure_thread(tid)
                return m.memory_manager.handle_tool_call(tn, kwargs)

            return _run

        out.append(
            StructuredTool.from_function(
                name=tool_name,
                description=(schema.get("description") or "")[:16000],
                func=_make_runner(tool_name),
                args_schema=model,
            )
        )

    return out
