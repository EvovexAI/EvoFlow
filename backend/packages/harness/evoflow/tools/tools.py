import logging
from functools import lru_cache

from langchain.tools import BaseTool

from evoflow.community.baidu_search import web_search_tool
from evoflow.config import get_app_config
from evoflow.persistence.bootstrap import sync_builtin_tools_to_db, sync_tool_groups_to_db
from evoflow.reflection import resolve_variable
from evoflow.sandbox.tools import (
    bash_tool,
    read_file_tool,
)
from evoflow.tools.builtins.knowledge_vault_tools import knowledge_tool
from evoflow.tools.builtins.tool_search import reset_deferred_registry

logger = logging.getLogger(__name__)

# Retired from the LLM tool surface — use unified ``browser`` tool or ``evoflow-admin`` skill + ``terminal`` + ``evoflow`` CLI.
# Agent entity assets (memory / journal / craft / episodic): unified ``assets(action=…)`` only.
# Legacy ``memory_remember`` / ``person_memory_edit`` / ``experience_*`` map to ``assets`` via tool_aliases.
_ADMIN_CLI_REPLACED_TOOL_NAMES: frozenset[str] = frozenset(
    {
        "remember",
        "recall",
        "experience_save",
        "experience_list",
        "experience_get",
        "experience_update",
        "experience_mark_used",
        "experience_delete",
        "memory_remember",
        "person_memory_edit",
        "create_agent",
        "update_agent",
        "list_agents",
        "list_agent_teams",
        "list_assignable_tools",
        "list_skills_catalog",
        "skill_manager",
        "automation",
        "session_search",
    }
)

# Retired from the LLM tool surface — use host-direct catalog names or ``terminal`` / ``search_code_index``.
REMOVED_LEGACY_TOOL_NAMES: frozenset[str] = frozenset(
    {
        *_ADMIN_CLI_REPLACED_TOOL_NAMES,
        "list_dir",
        "ls",
        "write_file",
        "str_replace",
        "search_content",
        "media_image_generate",
        "media_video_generate",
        "media_task_wait",
        "media_voiceover_synthesize",
        "media_subtitle_build",
        "media_subtitle_burn",
        "media_subtitle_extract",
        "image_search",
        "web_fetch",
        "search_tool_trace",
        "process_poll",
        "process_start",
        "process_log",
        "process_wait",
        "process_kill",
        "read_file",
        "write_to_file",
        "write_file",
        "replace_in_file",
        "str_replace",
        "delete_file",
        "find_file",
        # Legacy browser_* tools — use unified ``browser`` tool (deferred under agent mode).
        "preview_url",
        "browser_navigate",
        "browser_click",
        "browser_type",
        "browser_scroll",
        "browser_back",
        "browser_snapshot",
        "browser_close",
        "browser_press",
        "browser_console",
        "browser_get_images",
        "vision_analyze",
    }
)

# Sandbox builtins superseded by host-direct equivalents (avoid duplicate ``read_file`` / ``bash``).
_HOST_DIRECT_SUPERSEDED_SANDBOX_NAMES: frozenset[str] = frozenset({"read_file", "read", "bash"})


def _tool_name(tool: BaseTool | object) -> str:
    return str(getattr(tool, "name", "") or "").strip()


def _drop_removed_tools(tools: list[BaseTool], *, tools_mode: str | None = None) -> list[BaseTool]:
    removed = set(REMOVED_LEGACY_TOOL_NAMES)
    return [t for t in tools if _tool_name(t) not in removed]


def _read_tool_aliases(tools: list[BaseTool]) -> list[BaseTool]:
    """If only sandbox ``read_file`` is registered, expose host-direct name ``read`` (never the reverse)."""
    by_name = {_tool_name(t): t for t in tools}
    if "read" in by_name or "read_file" not in by_name:
        return tools
    src = by_name["read_file"]
    try:
        return [*tools, src.model_copy(update={"name": "read"})]
    except Exception:
        logger.debug("read_file → read alias failed", exc_info=True)
        return tools


def _dedupe_tools_by_name(tools: list[BaseTool]) -> list[BaseTool]:
    out: list[BaseTool] = []
    seen: set[str] = set()
    for t in tools:
        name = _tool_name(t)
        if not name or name in seen:
            continue
        seen.add(name)
        out.append(t)
    return out


def _finalize_tool_catalog(tools: list[BaseTool], *, tools_mode: str | None = None) -> list[BaseTool]:
    dropped = _drop_removed_tools(tools, tools_mode=tools_mode)
    aliased = _read_tool_aliases(dropped)
    return _dedupe_tools_by_name(aliased)


def _filter_sandbox_superseded_for_host_direct(tools: list[BaseTool]) -> list[BaseTool]:
    skip = _HOST_DIRECT_SUPERSEDED_SANDBOX_NAMES
    return [t for t in tools if _tool_name(t) not in skip]


def _filter_claude_code_if_unavailable(tools: list[BaseTool]) -> list[BaseTool]:
    try:
        from evoflow.external_runtime_probe import is_claude_code_worker_runtime_available

        if is_claude_code_worker_runtime_available():
            return tools
    except Exception:
        return tools
    filtered = [t for t in tools if str(getattr(t, "name", "") or "").strip() != "claude-code"]
    if len(filtered) < len(tools):
        logger.info("claude-code tool omitted — worker runtime not available in this process")
    return filtered


@lru_cache(maxsize=1)
def get_builtin_tools() -> tuple[BaseTool, ...]:
    """Load built-in sandbox tools on first use (avoids eager import of 50+ tool modules)."""
    from evoflow.community.web_fetch.tools import web_fetch_tool as fetch_url_tool
    from evoflow.tools.builtins.clarification_tool import ask_clarification_tool
    from evoflow.tools.builtins.assets_tool import assets_tool
    from evoflow.tools.builtins.browser_tool import browser_tool
    from evoflow.tools.builtins.claude_session_tool import claude_session_tool
    from evoflow.tools.builtins.collab_peer_tools import (
        collab_peer_read_tool,
        collab_peer_reply_tool,
        collab_peer_send_tool,
    )
    from evoflow.tools.builtins.mind_map_tool import mind_map_tool
    from evoflow.tools.builtins.pattern_fix_tool import pattern_fix_tool
    from evoflow.tools.builtins.plan_tool import plan_tool
    from evoflow.tools.builtins.platform_tool import platform_tool
    from evoflow.tools.builtins.process_tool import process_tool
    from evoflow.tools.builtins.propose_goal_tool import propose_goal_tool
    from evoflow.tools.builtins.read_lints_tool import read_lints_tool
    from evoflow.tools.builtins.send_message_tool import send_message_tool
    from evoflow.tools.builtins.session_workspace_tool import session_workspace_tool
    from evoflow.tools.builtins.stage_tool import stage_set_tool
    from evoflow.tools.builtins.subtask_outcome_report_tool import subtask_outcome_report_tool
    from evoflow.tools.builtins.subtask_progress_tool import subtask_progress_report_tool
    from evoflow.tools.builtins.subtask_work_checklist_tool import subtask_work_checklist_tool
    from evoflow.tools.builtins.supervisor_tool import supervisor_tool
    from evoflow.tools.builtins.tasks_tool import tasks_tool
    from evoflow.tools.builtins.todo_tool import todo_tool
    from evoflow.tools.builtins.view_image_tool import view_image_tool

    return (
        plan_tool,
        ask_clarification_tool,
        propose_goal_tool,
        claude_session_tool,
        supervisor_tool,
        subtask_outcome_report_tool,
        subtask_progress_report_tool,
        subtask_work_checklist_tool,
        mind_map_tool,
        tasks_tool,
        platform_tool,
        collab_peer_send_tool,
        collab_peer_read_tool,
        collab_peer_reply_tool,
        todo_tool,
        stage_set_tool,
        session_workspace_tool,
        send_message_tool,
        fetch_url_tool,
        view_image_tool,
        process_tool,
        browser_tool,
        read_lints_tool,
        pattern_fix_tool,
        assets_tool,
        bash_tool,
        read_file_tool,
    )


@lru_cache(maxsize=1)
def get_subagent_tools() -> tuple[BaseTool, ...]:
    from evoflow.tools.builtins.task_tool import task_tool

    return (task_tool,)


class _LazyToolSequence:
    """Backward-compatible lazy sequence for ``BUILTIN_TOOLS`` / ``SUBAGENT_TOOLS``."""

    def __init__(self, loader):
        self._loader = loader

    def __iter__(self):
        return iter(self._loader())

    def __len__(self):
        return len(self._loader())

    def __getitem__(self, index):
        return self._loader()[index]


BUILTIN_TOOLS = _LazyToolSequence(get_builtin_tools)
SUBAGENT_TOOLS = _LazyToolSequence(get_subagent_tools)


def _apply_media_runtime_tool_schemas(tools: list[BaseTool]) -> list[BaseTool]:
    return tools


def _is_trae_agent_tool(tool: object) -> bool:
    """Trae bridge tools are UI/runtime-only; never bind to the chat model."""
    name = str(getattr(tool, "name", "") or "").strip().lower()
    return name.startswith("trae_")


def _without_trae_agent_tools(tools: list[BaseTool]) -> list[BaseTool]:
    return [t for t in tools if not _is_trae_agent_tool(t)]


def _is_jina_tool_config(tool_cfg: object) -> bool:
    """True when a config tool entry references the jina_ai community module."""
    use = str(getattr(tool_cfg, "use", "") or "")
    return "evoflow.community.jina_ai" in use


def _load_supplemental_config_tools(config, existing_names: set[str]) -> list[BaseTool]:
    """Load YAML-configured community tools not covered by HostDirect base set."""
    supplemental: list[BaseTool] = []
    for tool_cfg in config.tools or []:
        if _is_jina_tool_config(tool_cfg):
            continue
        name = str(getattr(tool_cfg, "name", "") or "").strip()
        if not name or name in existing_names or name in REMOVED_LEGACY_TOOL_NAMES:
            continue
        use_path = str(getattr(tool_cfg, "use", "") or "").strip()
        if not use_path.startswith("evoflow.community."):
            continue
        try:
            tool = resolve_variable(use_path, BaseTool)
            tool_name = str(getattr(tool, "name", "") or name).strip()
            if not tool_name or tool_name in existing_names or tool_name in REMOVED_LEGACY_TOOL_NAMES:
                continue
            supplemental.append(tool)
            existing_names.add(tool_name)
            logger.info("HostDirect mode: loaded supplemental community tool '%s'", tool_name)
        except Exception as e:
            logger.warning("HostDirect mode: failed to load supplemental tool %s: %s", name, e)
    return supplemental


@lru_cache(maxsize=32)
def _cached_resolve_tools(
    groups_key: tuple[str, ...] | None,
    include_mcp: bool,
    model_name: str | None,
    subagent_enabled: bool,
    include_search: bool,
    tools_mode: str | None,
    tool_search_enabled: bool,
) -> tuple[BaseTool, ...]:
    """LRU-cached tool resolution — same logic as ``get_available_tools`` body.

    Returns immutable tuple so callers (``get_available_tools``) copy to a fresh list.
    ``tool_search_enabled`` is part of the key so toggling deferred loading invalidates correctly.
    """
    del tool_search_enabled  # key only; live check via is_tool_search_enabled below
    try:
        sync_builtin_tools_to_db()
        sync_tool_groups_to_db()
    except Exception:
        pass

    config = get_app_config()
    try:
        from evoflow.config.tool_search_config import is_tool_search_enabled

        ts_enabled = bool(is_tool_search_enabled())
    except Exception:
        ts_enabled = False

    if tools_mode is None:
        tools_mode = getattr(config, "tools_mode", None) or "host_direct"

    # ── HostDirect mode ──
    if tools_mode == "host_direct":
        return tuple(
            _finalize_tool_catalog(
                _load_host_direct_tools(
                    config=config,
                    model_name=model_name,
                    subagent_enabled=subagent_enabled,
                    include_search=include_search,
                    include_mcp=include_mcp,
                ),
                tools_mode=tools_mode,
            )
        )

    # ── Sandbox mode ──
    tools: list[BaseTool] = list(_filter_claude_code_if_unavailable(list(get_builtin_tools())))
    tools.extend(_knowledge_vault_tools_for_catalog())

    if subagent_enabled:
        tools.extend(list(get_subagent_tools()))

    if include_search:
        names = {getattr(t, "name", "") for t in tools}
        if "web_search" not in names:
            tools.append(web_search_tool)
    else:
        tools = [t for t in tools if getattr(t, "name", "") != "web_search"]

    mcp_tools: list[BaseTool] = []
    reset_deferred_registry()
    if include_mcp:
        try:
            from evoflow.config.extensions_config import ExtensionsConfig
            from evoflow.mcp.cache import get_cached_mcp_tools

            extensions_config = ExtensionsConfig.from_file()
            if extensions_config.get_enabled_mcp_servers():
                mcp_tools = get_cached_mcp_tools()
                if mcp_tools and ts_enabled:
                    from evoflow.tools.builtins.tool_search import DeferredToolRegistry, set_deferred_registry

                    registry = DeferredToolRegistry()
                    for t in mcp_tools:
                        registry.register(t)
                    set_deferred_registry(registry)
        except ImportError:
            pass
        except Exception as e:
            logger.error("Failed to get cached MCP tools: %s", e)

    # Deferred loading spine: independent of include_search (web_search / MCP gate).
    if ts_enabled:
        from evoflow.tools.builtins.tool_search import tool_search as tool_search_tool

        if not any(getattr(t, "name", "") == "tool_search" for t in tools):
            tools.append(tool_search_tool)

    acp_tools: list[BaseTool] = []
    try:
        from evoflow.tools.builtins.invoke_acp_agent_tool import build_invoke_acp_agent_tool

        acp_tools.append(build_invoke_acp_agent_tool())
    except Exception as e:
        logger.warning("Failed to load ACP tool: %s", e)

    plug_memory_tools: list[BaseTool] = []
    try:
        from evoflow.tools.builtins.memory_plugin_tools import build_hermes_external_memory_langchain_tools

        plug_memory_tools = build_hermes_external_memory_langchain_tools()
    except Exception as e:
        logger.warning("Hermes external memory plugin tools not loaded: %s", e)

    combined = _without_trae_agent_tools(tools + mcp_tools + acp_tools + plug_memory_tools)
    return tuple(_finalize_tool_catalog(_apply_media_runtime_tool_schemas(combined), tools_mode=tools_mode))


def invalidate_available_tools_cache() -> None:
    """Clear tool catalog LRU — call when Knowledge Vault config changes."""
    _cached_resolve_tools.cache_clear()


def _knowledge_vault_tools_for_catalog() -> list[BaseTool]:
    """Dynamically register Knowledge Vault tools based on enabled vaults."""
    try:
        from evoflow.knowledge.vault import store as vault_store

        configs = [c for c in vault_store.list_vault_configs() if c.enabled]
    except Exception:
        logger.debug("Knowledge Vault catalog probe failed", exc_info=True)
        return []
    if not configs:
        return []
    # Single dispatcher tool; write/ingest gated at runtime when no read_write vault.
    return [knowledge_tool]


def get_available_tools(
    groups: list[str] | None = None,
    include_mcp: bool = True,
    model_name: str | None = None,
    subagent_enabled: bool = False,
    include_search: bool = True,
    tools_mode: str | None = None,
) -> list[BaseTool]:
    """Get all available tools — all built-in, no config.yaml required.

    Results are LRU-cached keyed by (groups, include_mcp, model_name,
    subagent_enabled, include_search, tools_mode, tool_search_enabled).  Subsequent calls with
    the same parameters return a fresh list copy in O(tool_count) time.

    Args:
        groups: Optional list of tool groups to filter by (legacy, kept for compat).
        include_mcp: Whether to include tools from MCP servers (default: True).
        model_name: Optional model name (legacy compat; vision tools are always included).
        subagent_enabled: Whether to include subagent tools (task, task_status).
        include_search: Whether to include web_search/tool_search and MCP tools (default: False).
        tools_mode: Tool loading mode - 'host_direct' (default) uses direct filesystem tools;
                    'sandbox' uses sandbox-based file/bash tools.

    Returns:
        List of available tools.
    """
    groups_key = tuple(sorted(groups)) if groups else None
    try:
        from evoflow.config.tool_search_config import is_tool_search_enabled

        tool_search_enabled = bool(is_tool_search_enabled())
    except Exception:
        tool_search_enabled = False
    return list(
        _cached_resolve_tools(
            groups_key,
            include_mcp,
            model_name,
            subagent_enabled,
            include_search,
            tools_mode,
            tool_search_enabled,
        )
    )

def _load_host_direct_tools(
    config,
    model_name: str | None = None,
    subagent_enabled: bool = False,
    include_search: bool = True,
    include_mcp: bool = True,
) -> list[BaseTool]:
    """Load tools in HostDirect mode (zero sandbox overhead).

    This replaces the sandbox-based file operation tools with direct filesystem
    tools, while preserving all higher-level tools (supervisor, task, web_search, MCP, ACP).
    """
    from evoflow.tools.host_direct import HOST_DIRECT_TOOLS

    # Core: HostDirect base tools (read/search/terminal/web_fetch)
    tools: list[BaseTool] = list(HOST_DIRECT_TOOLS)

    tools.extend(
        _filter_sandbox_superseded_for_host_direct(_filter_claude_code_if_unavailable(list(get_builtin_tools())))
    )
    tools.extend(_knowledge_vault_tools_for_catalog())

    # Include subagent tools if enabled
    if subagent_enabled:
        tools.extend(list(get_subagent_tools()))
        logger.debug("HostDirect mode: Including subagent tools (task)")

    # Web search
    if include_search:
        names = {getattr(t, "name", "") for t in tools}
        if "web_search" not in names:
            tools.append(web_search_tool)

    # MCP tools
    mcp_tools: list[BaseTool] = []
    supplemental_tools: list[BaseTool] = []
    reset_deferred_registry()
    if include_mcp:
        try:
            from evoflow.config.extensions_config import ExtensionsConfig
            from evoflow.mcp.cache import get_cached_mcp_tools

            extensions_config = ExtensionsConfig.from_file()
            if extensions_config.get_enabled_mcp_servers():
                mcp_tools = get_cached_mcp_tools()
                if mcp_tools:
                    logger.info(f"HostDirect mode: Using {len(mcp_tools)} cached MCP tool(s)")
        except ImportError:
            logger.warning("MCP module not available.")
        except Exception as e:
            logger.error(f"Failed to get cached MCP tools in HostDirect mode: {e}")

    existing_names = {str(getattr(t, "name", "") or "").strip() for t in tools}
    supplemental_tools = _load_supplemental_config_tools(config, existing_names)
    if supplemental_tools:
        tools.extend(supplemental_tools)

    try:
        from evoflow.config.tool_search_config import is_tool_search_enabled

        ts_enabled = bool(is_tool_search_enabled())
    except Exception:
        ts_enabled = False

    if ts_enabled and (mcp_tools or (include_search and supplemental_tools)):
        from evoflow.tools.builtins.tool_search import DeferredToolRegistry, set_deferred_registry

        registry = DeferredToolRegistry()
        for t in mcp_tools:
            registry.register(t)
        if include_search:
            for t in supplemental_tools:
                registry.register(t)
        set_deferred_registry(registry)
        logger.info(
            "HostDirect mode: deferred registry: %s MCP + %s community tool(s)",
            len(mcp_tools),
            len(supplemental_tools) if include_search else 0,
        )

    # Core rule: keep tool_search whenever deferred loading is enabled (not gated by include_search).
    if ts_enabled:
        from evoflow.tools.builtins.tool_search import tool_search as tool_search_tool

        if not any(getattr(t, "name", "") == "tool_search" for t in tools):
            tools.append(tool_search_tool)

    # ACP tools
    try:
        from evoflow.tools.builtins.invoke_acp_agent_tool import build_invoke_acp_agent_tool

        tools.append(build_invoke_acp_agent_tool())
        logger.debug("HostDirect mode: Including invoke_acp_agent tool")
    except Exception as e:
        logger.warning(f"Failed to load ACP tool in HostDirect mode: {e}")

    plug_memory_tools: list[BaseTool] = []
    try:
        from evoflow.tools.builtins.memory_plugin_tools import build_hermes_external_memory_langchain_tools

        plug_memory_tools = build_hermes_external_memory_langchain_tools()
    except Exception as e:
        logger.warning("Hermes external memory plugin tools not loaded (HostDirect): %s", e)

    total = len(tools) + len(mcp_tools) + len(plug_memory_tools)
    logger.debug(
        f"HostDirect mode loaded: {len(HOST_DIRECT_TOOLS)} direct + {len(get_builtin_tools())} builtin + {len(mcp_tools)} MCP + {len(get_subagent_tools()) if subagent_enabled else 0} subagent + {len(plug_memory_tools)} memory plugin = {total} total"
    )
    return _apply_media_runtime_tool_schemas(
        _without_trae_agent_tools(_dedupe_tools_by_name(tools + mcp_tools + plug_memory_tools))
    )


def _apply_web_tool_citation_policies() -> None:
    from evoflow.community.web_citation_policy import append_web_citation_policy
    from evoflow.community.web_fetch.tools import web_fetch_tool as fetch_url_tool
    from evoflow.tools.host_direct.web_fetch import web_fetch_hd

    for tool in (web_search_tool, fetch_url_tool, web_fetch_hd):
        desc = str(getattr(tool, "description", "") or getattr(tool, "__doc__", "") or "")
        tool.description = append_web_citation_policy(desc)


_apply_web_tool_citation_policies()
