"""CRUD API for custom agents."""

from __future__ import annotations

import asyncio
import logging
import re
import shutil
from typing import Any

from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, model_validator

from evoflow.config import get_app_config
from evoflow.config.agent_tags import default_tags_for_new_agent, infer_tags_for_agent
from evoflow.config.agent_avatars import (
    avatar_path_for,
    avatar_revision_for,
    content_type_for,
    delete_avatar_file,
    has_local_avatar_file,
    save_avatar_bytes,
)
from evoflow.config.avatar_presets import (
    content_type_for_preset,
    is_valid_preset_avatar,
    list_presets,
    parse_preset_avatar,
    pick_random_preset_avatar,
    preset_path,
)
from evoflow.config.agents_config import (
    AgentConfig,
    ensure_builtin_agents_materialized,
    list_custom_agents,
    load_agent_config,
    load_agent_identity,
    load_agent_soul,
    save_agent_config,
    save_agent_identity,
    save_agent_soul,
)
from evoflow.config.paths import get_paths
from evoflow.external_runtime_probe import external_runtime_available_for_agent
from evoflow.persistence import config_repositories as cfg_repo
from evoflow.tools.ui_metadata import collect_native_tool_specs_for_role_ui

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["agents"])

AGENT_NAME_PATTERN = re.compile(r"^[A-Za-z0-9-]+$")


def _normalize_agent_tools_for_api(tools: list[str] | None) -> list[str] | None:
    from evoflow.tools.tool_catalog import normalize_agent_tools_whitelist

    return normalize_agent_tools_whitelist(tools)


def _matches_agent_list_filters(
    agent: AgentResponse,
    *,
    tag: str | None,
    preset_only: bool,
    assignable_only: bool,
) -> bool:
    if preset_only:
        code = str(agent.agent_code or "").strip().lower()
        if code != "main" and (agent.agent_type or "custom") != "custom":
            return False
    if assignable_only:
        code = str(agent.agent_code or "").strip().lower()
        at = (agent.agent_type or "").strip().lower()
        if code != "claude-code" and at not in {"subagent", "acp", "builtin"}:
            return False
    if tag:
        wanted = str(tag).strip()
        if not wanted:
            return True
        if not any(wanted in (t or "") for t in (agent.tags or [])):
            return False
    return True


# Panel / picker lists omit these codes (detail/get by code still works).
# file-worker: delisted from BUILTIN_SUBAGENTS; hide any leftover SQLite rows.
_UI_HIDDEN_AGENT_CODES = frozenset({"claude-code", "file-worker"})


def _agent_runtime_available_for_ui(agent: AgentResponse) -> bool:
    """Hide external-CLI roles from UI lists when the host cannot run them."""
    if agent.requires_external_cli and not agent.external_cli_available:
        return False
    return True


def _filter_agents_for_ui_list(agents: list[AgentResponse]) -> list[AgentResponse]:
    out: list[AgentResponse] = []
    for a in agents:
        code = str(a.agent_code or "").strip().lower()
        if code in _UI_HIDDEN_AGENT_CODES:
            continue
        if not _agent_runtime_available_for_ui(a):
            continue
        out.append(a)
    return out

# 新建自定义智能体且请求未带 skills 时：写入下列「基础技能」与当前已启用技能的交集（顺序固定）
_DEFAULT_SKILLS_FOR_NEW_CUSTOM_AGENT: tuple[str, ...] = (
    "evoflow-intro",
    "evoflow-admin",
    "create-plan",
    "deep-research",
    "article-writer",
    "aihot",  # AI HOT 中文资讯（skills/public/aihot，name: aihot）
)


def _default_skills_for_new_custom_agent() -> list[str]:
    """Wishlist ∩ installed skills that are currently enabled (extensions + loader)."""
    try:
        from evoflow.skills import load_skills

        enabled_names = {s.name for s in load_skills(enabled_only=True)}
    except Exception:
        logger.warning("load_skills failed while computing default skills for new agent", exc_info=True)
        return []
    return [name for name in _DEFAULT_SKILLS_FOR_NEW_CUSTOM_AGENT if name in enabled_names]


def _load_main_agent_config() -> AgentConfig | None:
    """Load main agent config from agents/main/config.yaml.

    Returns:
        AgentConfig instance, or None if not found.
    """
    try:
        return load_agent_config("main")
    except (FileNotFoundError, ValueError) as e:
        logger.debug(f"Main agent config not found: {e}")
        return None


def _save_main_agent_config(updates: dict) -> None:
    """Save main agent config to SQLite ``evoflow_agents``."""
    existing: dict[str, Any] = {}
    try:
        cfg = load_agent_config("main")
        if cfg is not None:
            existing = cfg.model_dump(mode="python", exclude={"name"})
    except FileNotFoundError:
        existing = {"agent_code": "main", "agent_type": "custom"}

    if "description" in updates and updates["description"] is not None:
        existing["description"] = updates["description"]
    if "model" in updates:
        if updates["model"]:
            existing["model"] = updates["model"]
        elif "model" in existing:
            del existing["model"]
    if "tool_groups" in updates:
        if updates["tool_groups"] is not None:
            existing["tool_groups"] = updates["tool_groups"]
        elif "tool_groups" in existing:
            del existing["tool_groups"]
    if "tools" in updates:
        if updates["tools"] is not None:
            existing["tools"] = updates["tools"]
        elif "tools" in existing:
            del existing["tools"]
    if "mcp_servers" in updates:
        if updates["mcp_servers"] is not None:
            existing["mcp_servers"] = updates["mcp_servers"]
        elif "mcp_servers" in existing:
            del existing["mcp_servers"]
    if "skills" in updates:
        if updates["skills"] is not None:
            existing["skills"] = updates["skills"]
        elif "skills" in existing:
            del existing["skills"]
    if "agent_name" in updates:
        existing["agent_name"] = updates["agent_name"]
    if "system_prompt" in updates:
        existing["system_prompt"] = updates["system_prompt"]
    if "avatar" in updates:
        existing["avatar"] = updates["avatar"]
    if "avatar_meta" in updates:
        existing["avatar_meta"] = updates["avatar_meta"]

    existing["agent_code"] = "main"
    save_agent_config("main", existing)


def _main_agent_to_response(include_soul: bool = False) -> AgentResponse:
    """Convert main agent config (from agents/main/config.yaml) to AgentResponse."""
    agent_cfg = _load_main_agent_config()

    soul = None
    identity = None
    if include_soul:
        soul = load_agent_soul("main")
        identity = load_agent_identity("main") or ""

    model = agent_cfg.model if agent_cfg else None

    _main_display = (agent_cfg.agent_name or "").strip() if agent_cfg else ""
    _main_type = (agent_cfg.agent_type if agent_cfg else None) or "custom"
    return AgentResponse(
        agent_code="main",
        agent_name=_main_display or "EvoFlow",
        description=agent_cfg.description if agent_cfg else "",
        model=model,
        tool_groups=agent_cfg.tool_groups if agent_cfg else None,
        tools=_normalize_agent_tools_for_api(agent_cfg.tools if agent_cfg else None),
        mcp_servers=agent_cfg.mcp_servers if agent_cfg else None,
        skills=agent_cfg.skills if agent_cfg else None,
        knowledge_vault_ids=list(getattr(agent_cfg, "knowledge_vault_ids", None) or []) if agent_cfg else [],
        soul=soul,
        identity=identity,
        system_prompt=agent_cfg.system_prompt if agent_cfg else None,
        agent_type=_main_type,
        tags=list(getattr(agent_cfg, "tags", []) or []) if agent_cfg else [],
        requires_external_cli=False,
        external_cli_available=True,
        avatar=agent_cfg.avatar if agent_cfg else None,
        avatar_meta=agent_cfg.avatar_meta if agent_cfg else None,
        tts_speaker=getattr(agent_cfg, "tts_speaker", None) if agent_cfg else None,
        has_avatar_file=has_local_avatar_file("main"),
        avatar_rev=avatar_revision_for("main"),
    )


class AgentResponse(BaseModel):
    """Response model for a custom agent."""

    agent_code: str = Field(..., description="Agent code/identifier (hyphen-case)")
    agent_name: str | None = Field(default=None, description="Optional Chinese display name for UI")
    description: str = Field(default="", description="Agent description")
    model: str | None = Field(default=None, description="Optional model override")
    tool_groups: list[str] | None = Field(default=None, description="Optional tool group whitelist")
    tools: list[str] | None = Field(default=None, description="Optional builtin tool whitelist")
    mcp_servers: list[str] | None = Field(default=None, description="Optional MCP server names")
    skills: list[str] | None = Field(default=None, description="Optional skill names")
    knowledge_vault_ids: list[str] = Field(
        default_factory=list,
        description="Bound knowledge base / vault ids (empty = none)",
    )
    soul: str | None = Field(default=None, description="SOUL.md content (included on GET /{name})")
    identity: str | None = Field(
        default=None,
        description="Person Kernel L0 identity (read-only at runtime; included on GET /{name})",
    )
    system_prompt: str | None = Field(default=None, description="System prompt for the agent")
    agent_type: str | None = Field(
        default=None,
        description="custom | subagent | acp — subagent covers built-in workers (e.g. claude-code); acp is external ACP CLI",
    )
    requires_external_cli: bool = Field(
        default=False,
        description="True when delegating this agent requires a host-installed CLI (e.g. Claude Code); unavailable if not installed",
    )
    external_cli_available: bool = Field(
        default=True,
        description=("False when the **Gateway API** process cannot import the SDK / find the CLI on PATH. Does not probe the LangGraph runtime; chat runs in LangGraph and may need the same venv."),
    )
    external_cli_probe_process: str | None = Field(
        default=None,
        description="If set, names the process that ran the probe (e.g. gateway). Claude Code chat runs in LangGraph.",
    )
    tags: list[str] = Field(default_factory=list, description="Tag labels for grouping/filtering agents")
    avatar: str | None = Field(
        default=None,
        description="UI avatar: preset:mochi|ink|bolt, emoji:🔧, image (uploaded cutout), or null for code default",
    )
    avatar_meta: dict[str, Any] | None = Field(
        default=None,
        description="Optional crop metadata for image avatars (aspect, head_box)",
    )
    tts_speaker: str | None = Field(
        default=None,
        description="Optional Volcengine TTS voice_type for meeting / voice playback",
    )
    has_avatar_file: bool = Field(
        default=False,
        description="True when a custom image file exists at GET /api/agents/{code}/avatar",
    )
    avatar_rev: str | None = Field(
        default=None,
        description="Cache-bust token for the avatar image URL (bundled sha prefix or mtime)",
    )


class AgentsListResponse(BaseModel):
    """Response model for listing all custom agents."""

    agents: list[AgentResponse]


class AgentCreateRequest(BaseModel):
    """Request body for creating a custom agent."""

    agent_code: str = Field(..., description="Agent code (must match ^[A-Za-z0-9-]+$, stored as lowercase)")
    agent_name: str | None = Field(default=None, description="Optional Chinese display name for UI")
    description: str = Field(default="", description="Agent description")
    model: str | None = Field(default=None, description="Optional model override")
    tool_groups: list[str] | None = Field(default=None, description="Optional tool group whitelist")
    tools: list[str] | None = Field(default=None, description="Optional builtin tool whitelist")
    mcp_servers: list[str] | None = Field(default=None, description="Optional MCP server names")
    skills: list[str] | None = Field(default=None, description="Optional skill names")
    knowledge_vault_ids: list[str] | None = Field(
        default=None,
        description="Bound knowledge base / vault ids (empty list clears binding)",
    )
    soul: str = Field(default="", description="SOUL.md content — agent personality and behavioral guardrails")
    system_prompt: str | None = Field(default=None, description="Optional system prompt")
    tags: list[str] | None = Field(default=None, description="Optional tag labels for grouping/filtering")
    avatar: str | None = Field(default=None, description="UI avatar preset / emoji / image")
    avatar_meta: dict[str, Any] | None = Field(default=None, description="Image avatar crop metadata")
    tts_speaker: str | None = Field(default=None, description="Optional Volcengine TTS voice_type")

    @model_validator(mode="before")
    @classmethod
    def _coerce_legacy_create_body(cls, data: Any) -> Any:
        """EvoPanel / dev-api 仍传 ``name``；与 ``agent_code`` 对齐。"""
        if isinstance(data, dict):
            code = data.get("agent_code")
            if (code is None or (isinstance(code, str) and not str(code).strip())) and data.get("name"):
                data = {**data, "agent_code": str(data["name"]).strip()}
        return data


class SkillHubExpertInstallRequest(BaseModel):
    """Install a SkillHub expert package (skillset) as a custom agent + skills."""

    url: str = Field(
        ...,
        description="SkillHub skillspackage URL or slug, e.g. https://www.skillhub.cn/skillspackage/media-script-breakdown",
    )
    agent_code: str | None = Field(
        default=None,
        description="Optional agent code override (default: package slug)",
    )
    force_skills: bool = Field(
        default=False,
        description="Reinstall skills that already exist under custom/",
    )


class SkillHubExpertInstallResponse(BaseModel):
    agent_code: str
    agent_name: str
    slug: str
    skills: list[str] = Field(default_factory=list)
    skill_results: list[dict[str, Any]] = Field(default_factory=list)
    avatar_path: str | None = None
    created: bool = True
    agent: AgentResponse | None = None

    @model_validator(mode="before")
    @classmethod
    def _coerce_legacy_create_body(cls, data: Any) -> Any:
        """EvoPanel / dev-api 仍传 ``name``；与 ``agent_code`` 对齐。"""
        if isinstance(data, dict):
            code = data.get("agent_code")
            if (code is None or (isinstance(code, str) and not str(code).strip())) and data.get("name"):
                data = {**data, "agent_code": str(data["name"]).strip()}
        return data


class AgentUpdateRequest(BaseModel):
    """Request body for updating a custom agent."""

    agent_name: str | None = Field(default=None, description="Updated Chinese display name for UI")
    description: str | None = Field(default=None, description="Updated description")
    model: str | None = Field(default=None, description="Updated model override")
    tool_groups: list[str] | None = Field(default=None, description="Updated tool group whitelist")
    tools: list[str] | None = Field(default=None, description="Updated builtin tool whitelist")
    mcp_servers: list[str] | None = Field(default=None, description="Updated MCP server names")
    skills: list[str] | None = Field(default=None, description="Updated skill names")
    knowledge_vault_ids: list[str] | None = Field(
        default=None,
        description="Updated bound knowledge base / vault ids (empty list clears)",
    )
    soul: str | None = Field(default=None, description="Updated SOUL.md content")
    identity: str | None = Field(
        default=None,
        description="Updated Person Kernel L0 identity (admin only; not rewritten by duty wrap-up)",
    )
    system_prompt: str | None = Field(default=None, description="Updated system prompt")
    tags: list[str] | None = Field(default=None, description="Updated tag labels (empty list clears tags)")
    avatar: str | None = Field(default=None, description="Updated UI avatar")
    avatar_meta: dict[str, Any] | None = Field(default=None, description="Updated image avatar metadata")
    tts_speaker: str | None = Field(default=None, description="Updated Volcengine TTS voice_type")


def _validate_agent_name(name: str) -> None:
    """Validate agent name against allowed pattern.

    Args:
        name: The agent name to validate.

    Raises:
        HTTPException: 422 if the name is invalid.
    """
    if not AGENT_NAME_PATTERN.match(name):
        raise HTTPException(
            status_code=422,
            detail=f"Invalid agent name '{name}'. Must match ^[A-Za-z0-9-]+$ (letters, digits, and hyphens only).",
        )


def _normalize_agent_name(name: str) -> str:
    """Normalize agent name to lowercase for filesystem storage."""
    return name.lower()


def _agent_requires_external_cli(agent_cfg: AgentConfig) -> bool:
    """True when capability is delegated to a host CLI/SDK (e.g. Claude Code), not EvoFlow tool/MCP/skills."""
    code = (agent_cfg.agent_code or "").strip().lower()
    if code == "claude-code":
        return True
    return bool(agent_cfg.agent_type == "subagent" and agent_cfg.tools is not None and "claude-code" in agent_cfg.tools)


_CLAUDE_CODE_ENV_NOTE = (
    "【环境】列表中的「外部 CLI 可用」仅在 **Gateway** 进程内检测；"
    "面板直连 Claude Code 时请求由 **LangGraph**（通常为 backend 目录 ``uv run langgraph dev``）执行，"
    "该 Python 环境也需能 ``import claude_agent_sdk``（在 backend 执行 ``uv sync --extra claude-code``）。"
)


def _agent_config_to_response(agent_cfg: AgentConfig, include_soul: bool = False) -> AgentResponse:
    """Convert AgentConfig to AgentResponse."""
    soul: str | None = None
    identity: str | None = None
    if include_soul:
        soul = load_agent_soul(agent_cfg.agent_code) or ""
        identity = load_agent_identity(agent_cfg.agent_code) or ""

    code = agent_cfg.agent_code
    ext_cli = _agent_requires_external_cli(agent_cfg)
    ext_avail = external_runtime_available_for_agent(agent_cfg, agent_code=code, requires_external_cli=ext_cli)
    probe_proc: str | None = "gateway" if str(code or "").strip().lower() == "claude-code" and ext_cli else None
    desc = (agent_cfg.description or "").strip()
    if probe_proc and desc and _CLAUDE_CODE_ENV_NOTE not in desc:
        desc = f"{desc}\n\n{_CLAUDE_CODE_ENV_NOTE}"
    elif probe_proc and not desc:
        desc = _CLAUDE_CODE_ENV_NOTE

    tags = list(getattr(agent_cfg, "tags", []) or [])

    tools = _normalize_agent_tools_for_api(agent_cfg.tools)
    mcp_servers = agent_cfg.mcp_servers
    skills = agent_cfg.skills
    knowledge_vault_ids = list(getattr(agent_cfg, "knowledge_vault_ids", None) or [])
    try:
        from evoflow.agents.xiaomi.identity import is_xiaomi_agent
        from evoflow.config.agents_config import xiaomi_front_desk_capability_defaults

        if is_xiaomi_agent(code):
            caps = xiaomi_front_desk_capability_defaults()
            tools = list(caps["tools"])
            mcp_servers = list(caps["mcp_servers"])
            skills = list(caps["skills"])
            knowledge_vault_ids = []
    except Exception:
        pass

    return AgentResponse(
        agent_code=code,
        agent_name=agent_cfg.agent_name,
        description=desc,
        model=agent_cfg.model,
        tool_groups=agent_cfg.tool_groups,
        tools=tools,
        mcp_servers=mcp_servers,
        skills=skills,
        knowledge_vault_ids=knowledge_vault_ids,
        soul=soul,
        identity=identity,
        system_prompt=agent_cfg.system_prompt,
        agent_type=agent_cfg.agent_type,
        tags=tags,
        requires_external_cli=ext_cli,
        external_cli_available=ext_avail,
        external_cli_probe_process=probe_proc,
        avatar=getattr(agent_cfg, "avatar", None),
        avatar_meta=getattr(agent_cfg, "avatar_meta", None),
        tts_speaker=getattr(agent_cfg, "tts_speaker", None),
        has_avatar_file=has_local_avatar_file(code),
        avatar_rev=avatar_revision_for(code),
    )


@router.get(
    "/agents",
    response_model=AgentsListResponse,
    summary="List Custom Agents",
    description="List all custom agents available in the agents directory, including the main agent.",
)
async def list_agents(
    request: Request,
    tag: str | None = Query(default=None, description="Filter by tag (substring match on tags_json)"),
    preset_only: bool = Query(default=False, description="Only main + custom preset roles"),
    assignable_only: bool = Query(default=False, description="Only subagent/acp/claude-code workers"),
) -> AgentsListResponse:
    """List all custom agents.

    Returns:
        List of all custom agents with their metadata (without soul content).
        Includes the main (default) agent as the first entry.
    """
    try:
        ensure_builtin_agents_materialized()
        # Get main agent first
        main_agent = _main_agent_to_response(include_soul=False)

        # Get custom agents
        custom_agents = list_custom_agents()
        custom_responses = [_agent_config_to_response(a) for a in custom_agents]

        # Combine: main agent first, then custom agents
        all_agents = [main_agent] + custom_responses
        # claude-code is omitted from panel lists via _UI_HIDDEN_AGENT_CODES (no virtual inject).

        filtered = _filter_agents_for_ui_list(
            [
                a
                for a in all_agents
                if _matches_agent_list_filters(a, tag=tag, preset_only=preset_only, assignable_only=assignable_only)
            ]
        )

        # Always isolate: hide other users' personal agents (legacy/unowned stay visible to admins).
        try:
            from evoflow.authz.context import resolve_request_authz
            from evoflow.authz.scope import org_scope, personal_scope
            from evoflow.persistence import config_repositories as _cfg

            ctx = resolve_request_authz(request)
            pid = str((ctx.get("principal") or {}).get("principal_id") or "")
            oid = str(ctx.get("org_id") or "local")
            is_admin = bool(ctx.get("is_org_admin"))
            p_scope = personal_scope(pid) if pid else None
            o_scope = org_scope(oid)
            filtered = [
                a
                for a in filtered
                if _cfg.agent_visible_to_principal(
                    str(getattr(a, "agent_code", None) or getattr(a, "name", "") or ""),
                    pid,
                    is_admin=is_admin,
                    personal_scope=p_scope,
                    org_scope=o_scope,
                )
            ]
        except Exception:
            logger.debug("agent ACL filter skipped", exc_info=True)

        return AgentsListResponse(agents=filtered)
    except Exception as e:
        logger.error(f"Failed to list agents: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to list agents: {str(e)}")


def _validate_agent_avatar_value(avatar: str | None) -> str | None:
    """Normalize / reject avatar strings. Returns value to store (may be None).

    - ``preset:<id>`` must exist in the system gallery (legacy mochi/ink/bolt → None)
    - ``emoji:…``, ``image``, url-like strings pass through
    """
    if avatar is None:
        return None
    raw = str(avatar).strip()
    if not raw:
        return None
    low = raw.lower()
    if low.startswith("preset:"):
        if is_valid_preset_avatar(raw):
            pid = parse_preset_avatar(raw)
            return f"preset:{pid}"
        # Legacy placeholders or unknown ids → treat as unset
        return None
    return raw


@router.get(
    "/agents/check",
    summary="Check Agent Name",
    description="Validate an agent name and check if it is available (case-insensitive).",
)
async def check_agent_name(name: str) -> dict:
    """Check whether an agent name is valid and not yet taken.

    Args:
        name: The agent name to check.

    Returns:
        ``{"available": true/false, "name": "<normalized>"}``

    Raises:
        HTTPException: 422 if the name is invalid.
    """
    _validate_agent_name(name)
    normalized = _normalize_agent_name(name)
    available = not cfg_repo.agent_exists(normalized)
    return {"available": available, "name": normalized}


@router.get(
    "/agents/avatar-presets",
    summary="List System Avatar Presets",
    description="Built-in 3D cutouts users can pick when creating/editing an agent.",
)
async def list_avatar_presets() -> dict[str, Any]:
    presets = [
        {
            "id": row["id"],
            "label": row["label"],
            "url": f"/api/agents/avatar-presets/{row['id']}",
        }
        for row in list_presets()
    ]
    return {"presets": presets, "count": len(presets)}


@router.get(
    "/agents/avatar-presets/{preset_id}",
    summary="Get System Avatar Preset Image",
    responses={404: {"description": "Unknown preset"}},
)
async def get_avatar_preset(preset_id: str):
    path = preset_path(preset_id)
    if not path:
        raise HTTPException(status_code=404, detail=f"Avatar preset '{preset_id}' not found")
    return FileResponse(path, media_type=content_type_for_preset(path))


@router.get(
    "/agents/{name}",
    response_model=AgentResponse,
    summary="Get Custom Agent",
    description="Retrieve details and SOUL.md content for a specific custom agent. Use 'main' for the default agent.",
)
async def get_agent(request: Request, name: str) -> AgentResponse:
    """Get a specific custom agent by name.

    Args:
        name: The agent name. Use 'main' for the default agent.

    Returns:
        Agent details including SOUL.md content.

    Raises:
        HTTPException: 404 if agent not found.
    """
    from evoflow.authz.http_guard import require_agent_visible

    # Special handling for main agent
    if name.lower() == "main":
        return _main_agent_to_response(include_soul=True)

    _validate_agent_name(name)
    name = _normalize_agent_name(name)
    require_agent_visible(request, name)

    try:
        agent_cfg = load_agent_config(name)
        return _agent_config_to_response(agent_cfg, include_soul=True)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Agent '{name}' not found")
    except Exception as e:
        logger.error(f"Failed to get agent '{name}': {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to get agent: {str(e)}")


@router.post(
    "/agents/install-from-skillhub",
    response_model=SkillHubExpertInstallResponse,
    summary="Install SkillHub Expert Package",
    description=(
        "Paste a SkillHub skillspackage URL (or slug). Downloads child skills, "
        "creates/updates a custom agent with soul + skill allowlist, and extracts the expert avatar."
    ),
)
async def install_agent_from_skillhub(request: SkillHubExpertInstallRequest) -> SkillHubExpertInstallResponse:
    from evoflow.skills.skillhub_pack import install_skillhub_expert_pack

    url = str(request.url or "").strip()
    if not url:
        raise HTTPException(status_code=422, detail="url is required")
    try:
        result = await asyncio.to_thread(
            install_skillhub_expert_pack,
            url,
            agent_code=request.agent_code,
            force_skills=bool(request.force_skills),
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except Exception as e:
        logger.error("install-from-skillhub failed: %s", e, exc_info=True)
        raise HTTPException(status_code=502, detail=f"SkillHub install failed: {e}") from e

    try:
        agent_cfg = load_agent_config(result.agent_code)
        agent_resp = _agent_config_to_response(agent_cfg, include_soul=True)
    except Exception:
        agent_resp = None

    return SkillHubExpertInstallResponse(
        agent_code=result.agent_code,
        agent_name=result.agent_name,
        slug=result.slug,
        skills=list(result.skills or []),
        skill_results=[
            {
                "slug": r.slug,
                "status": r.status,
                "skill_name": r.skill_name,
                "message": r.message,
            }
            for r in (result.skill_results or [])
        ],
        avatar_path=result.avatar_path,
        created=bool(result.created),
        agent=agent_resp,
    )


@router.post(
    "/agents",
    response_model=AgentResponse,
    status_code=201,
    summary="Create Custom Agent",
    description="Create a new custom agent with its config and SOUL.md.",
)
async def create_agent_endpoint(http_request: Request, request: AgentCreateRequest) -> AgentResponse:
    """Create a new custom agent.

    Args:
        request: The agent creation request.

    Returns:
        The created agent details.

    Raises:
        HTTPException: 409 if agent already exists, 422 if name is invalid.
    """
    _validate_agent_name(request.agent_code)
    normalized_name = _normalize_agent_name(request.agent_code)

    if cfg_repo.agent_exists(normalized_name):
        raise HTTPException(status_code=409, detail=f"Agent '{normalized_name}' already exists")

    try:
        config_data: dict = {
            "agent_code": normalized_name,
            "agent_type": "custom",
        }
        if request.agent_name:
            config_data["agent_name"] = request.agent_name
        if request.description:
            config_data["description"] = request.description
        if request.model is not None:
            config_data["model"] = request.model
        if request.tool_groups is not None:
            config_data["tool_groups"] = request.tool_groups
        if request.tools is not None:
            config_data["tools"] = _normalize_agent_tools_for_api(request.tools)
        if request.mcp_servers is not None:
            config_data["mcp_servers"] = request.mcp_servers
        if request.skills is not None:
            config_data["skills"] = request.skills
        else:
            config_data["skills"] = _default_skills_for_new_custom_agent()
        if request.knowledge_vault_ids is not None:
            from evoflow.proactive.prompt import validate_agent_knowledge_ids

            try:
                config_data["knowledge_vault_ids"] = validate_agent_knowledge_ids(
                    list(request.knowledge_vault_ids or [])
                )
            except ValueError as e:
                raise HTTPException(status_code=422, detail=str(e)) from e

        if request.system_prompt is not None and str(request.system_prompt).strip():
            config_data["system_prompt"] = str(request.system_prompt).strip()

        if request.tags is not None:
            config_data["tags"] = [str(t).strip() for t in request.tags if str(t).strip()]
        else:
            config_data["tags"] = default_tags_for_new_agent(agent_type="custom")

        avatar = _validate_agent_avatar_value(request.avatar) if request.avatar is not None else None
        if not avatar:
            avatar = pick_random_preset_avatar()
        if avatar:
            config_data["avatar"] = avatar
        if request.avatar_meta is not None:
            config_data["avatar_meta"] = request.avatar_meta
        if request.tts_speaker is not None and str(request.tts_speaker).strip():
            config_data["tts_speaker"] = str(request.tts_speaker).strip()

        save_agent_config(normalized_name, config_data)
        save_agent_soul(normalized_name, request.soul or "")

        # Stamp personal ownership + ensure FS home for this principal.
        try:
            from evoflow.authz.context import resolve_request_principal
            from evoflow.authz.scope import personal_scope
            from evoflow.authz.scope_paths import ensure_principal_home, scope_agents_dir

            principal = resolve_request_principal(http_request)
            ensure_principal_home(principal)
            pid = str(principal.get("principal_id") or "")
            oid = str(principal.get("org_id") or "local")
            if pid:
                cfg_repo.set_agent_owner_scope(
                    normalized_name,
                    org_id=oid,
                    owner_scope_id=personal_scope(pid),
                )
                # Optional FS mirror dir for future per-agent files.
                (scope_agents_dir(personal_scope(pid)) / normalized_name).mkdir(parents=True, exist_ok=True)
        except Exception:
            logger.debug("agent ownership stamp skipped", exc_info=True)

        logger.info("Created agent '%s' in SQLite", normalized_name)

        agent_cfg = load_agent_config(normalized_name)
        return _agent_config_to_response(agent_cfg, include_soul=True)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to create agent '{normalized_name}': {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to create agent: {str(e)}")


@router.put(
    "/agents/{name}",
    response_model=AgentResponse,
    summary="Update Custom Agent",
    description="Update an existing custom agent's config and/or SOUL.md. Use 'main' for the default agent.",
)
async def update_agent(http_request: Request, name: str, request: AgentUpdateRequest) -> AgentResponse:
    """Update an existing custom agent.

    Args:
        name: The agent name. Use 'main' for the default agent.
        request: The update request (all fields optional).

    Returns:
        The updated agent details.

    Raises:
        HTTPException: 404 if agent not found.
    """
    from evoflow.authz.http_guard import require_agent_visible

    # Special handling for main agent
    if name.lower() == "main":
        updates = {}
        # Check if field was explicitly provided (not just not None)
        # For optional fields, we need to distinguish between "not provided" and "explicitly set to None"
        request_dict = request.model_dump(exclude_unset=True)
        if "agent_name" in request_dict:
            updates["agent_name"] = request.agent_name
        if "description" in request_dict:
            updates["description"] = request.description
        if "model" in request_dict:
            updates["model"] = request.model
        if "tools" in request_dict:
            updates["tools"] = _normalize_agent_tools_for_api(request.tools)
        if "mcp_servers" in request_dict:
            updates["mcp_servers"] = request.mcp_servers
        if "skills" in request_dict:
            updates["skills"] = request.skills
        if "knowledge_vault_ids" in request_dict:
            from evoflow.proactive.prompt import validate_agent_knowledge_ids

            try:
                updates["knowledge_vault_ids"] = validate_agent_knowledge_ids(
                    list(request.knowledge_vault_ids or [])
                )
            except ValueError as e:
                raise HTTPException(status_code=422, detail=str(e)) from e
        if "system_prompt" in request_dict:
            updates["system_prompt"] = request.system_prompt
        if "avatar" in request_dict:
            updates["avatar"] = _validate_agent_avatar_value(request.avatar)
            if updates.get("avatar") != "image":
                delete_avatar_file("main")
        if "avatar_meta" in request_dict:
            updates["avatar_meta"] = request.avatar_meta
        if "tts_speaker" in request_dict:
            raw_voice = request.tts_speaker
            updates["tts_speaker"] = (
                str(raw_voice).strip() if raw_voice is not None and str(raw_voice).strip() else None
            )

        _save_main_agent_config(updates)

        if request.soul is not None:
            save_agent_soul("main", request.soul if request.soul.strip() else "")

        return _main_agent_to_response(include_soul=True)

    _validate_agent_name(name)
    name = _normalize_agent_name(name)
    require_agent_visible(http_request, name)

    try:
        agent_cfg = load_agent_config(name)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Agent '{name}' not found")

    try:
        request_set = request.model_dump(exclude_unset=True)
        config_field_names = (
            "agent_name",
            "description",
            "model",
            "tool_groups",
            "tools",
            "mcp_servers",
            "skills",
            "knowledge_vault_ids",
            "system_prompt",
            "tags",
            "avatar",
            "avatar_meta",
            "tts_speaker",
        )
        config_changed = any(k in request_set for k in config_field_names)

        if config_changed:
            updated: dict = {
                "agent_code": agent_cfg.agent_code,
                "agent_type": agent_cfg.agent_type,
                "description": request.description if request.description is not None else agent_cfg.description,
            }
            if request.agent_name is not None:
                updated["agent_name"] = request.agent_name
            elif agent_cfg.agent_name is not None:
                updated["agent_name"] = agent_cfg.agent_name

            if "model" in request_set:
                m = request.model
                if m is not None and str(m).strip():
                    updated["model"] = str(m).strip()
            elif agent_cfg.model is not None:
                updated["model"] = agent_cfg.model

            # 小V：系统前台固定能力面，禁止挂普通工具 / MCP / 技能。
            _is_xiaomi = False
            try:
                from evoflow.agents.xiaomi.identity import is_xiaomi_agent
                from evoflow.config.agents_config import xiaomi_front_desk_capability_defaults

                _is_xiaomi = is_xiaomi_agent(name)
            except Exception:
                _is_xiaomi = False

            if _is_xiaomi:
                caps = xiaomi_front_desk_capability_defaults()
                new_tool_groups = None
                new_tools = list(caps["tools"])
                new_mcp = list(caps["mcp_servers"])
                new_skills = list(caps["skills"])
            elif _agent_requires_external_cli(agent_cfg):
                new_tool_groups = agent_cfg.tool_groups
                new_tools = agent_cfg.tools
                new_mcp = agent_cfg.mcp_servers
                new_skills = agent_cfg.skills
            else:
                new_tool_groups = request.tool_groups if request.tool_groups is not None else agent_cfg.tool_groups
                new_tools = _normalize_agent_tools_for_api(
                    request.tools if request.tools is not None else agent_cfg.tools
                )
                new_mcp = request.mcp_servers if request.mcp_servers is not None else agent_cfg.mcp_servers
                new_skills = request.skills if request.skills is not None else agent_cfg.skills

            if new_tool_groups is not None:
                updated["tool_groups"] = new_tool_groups
            if new_tools is not None:
                updated["tools"] = new_tools
            if new_mcp is not None:
                updated["mcp_servers"] = new_mcp
            if new_skills is not None:
                updated["skills"] = new_skills
            if _is_xiaomi:
                # Empty lists must always persist (None =「全量」).
                updated["tools"] = []
                updated["mcp_servers"] = []
                updated["skills"] = []
                updated["knowledge_vault_ids"] = []
            elif "knowledge_vault_ids" in request_set:
                from evoflow.proactive.prompt import validate_agent_knowledge_ids

                try:
                    updated["knowledge_vault_ids"] = validate_agent_knowledge_ids(
                        list(request.knowledge_vault_ids or [])
                    )
                except ValueError as e:
                    raise HTTPException(status_code=422, detail=str(e)) from e
            else:
                updated["knowledge_vault_ids"] = list(
                    getattr(agent_cfg, "knowledge_vault_ids", None) or []
                )

            new_system_prompt = request.system_prompt if request.system_prompt is not None else agent_cfg.system_prompt
            if new_system_prompt is not None:
                updated["system_prompt"] = new_system_prompt

            if "tags" in request_set:
                raw_tags = request.tags
                if raw_tags is None:
                    updated["tags"] = []
                else:
                    updated["tags"] = [str(t).strip() for t in raw_tags if str(t).strip()]

            if "avatar" in request_set:
                updated["avatar"] = _validate_agent_avatar_value(request.avatar)
                if updated.get("avatar") != "image":
                    delete_avatar_file(name)
            elif agent_cfg.avatar is not None:
                updated["avatar"] = agent_cfg.avatar

            if "avatar_meta" in request_set:
                updated["avatar_meta"] = request.avatar_meta
            elif agent_cfg.avatar_meta is not None:
                updated["avatar_meta"] = agent_cfg.avatar_meta

            if "tts_speaker" in request_set:
                raw_voice = request.tts_speaker
                updated["tts_speaker"] = str(raw_voice).strip() if raw_voice is not None and str(raw_voice).strip() else None
            elif getattr(agent_cfg, "tts_speaker", None):
                updated["tts_speaker"] = agent_cfg.tts_speaker

            save_agent_config(name, updated)

        if request.soul is not None:
            save_agent_soul(name, request.soul)
        if request.identity is not None:
            save_agent_identity(name, request.identity, reason="agent API update")

        logger.info("Updated agent '%s' in SQLite", name)

        refreshed_cfg = load_agent_config(name)
        return _agent_config_to_response(refreshed_cfg, include_soul=True)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to update agent '{name}': {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to update agent: {str(e)}")


@router.get(
    "/agents/{name}/avatar",
    summary="Get Agent Avatar Image",
    description="Serve the uploaded transparent avatar image for an agent.",
    responses={404: {"description": "No avatar file"}},
)
async def get_agent_avatar(name: str):
    _validate_agent_name(name)
    code = _normalize_agent_name(name)
    path = avatar_path_for(code)
    if not path:
        raise HTTPException(status_code=404, detail="Avatar not found")
    rev = avatar_revision_for(code)
    if not rev:
        try:
            rev = str(path.stat().st_mtime_ns)
        except OSError:
            rev = "0"
    return FileResponse(
        path,
        media_type=content_type_for(path),
        headers={
            "Cache-Control": "private, max-age=0, must-revalidate",
            "ETag": f'"{rev}"',
        },
    )


@router.post(
    "/agents/{name}/avatar",
    summary="Upload Agent Avatar Image",
    description="Upload a transparent WebP/PNG cutout; sets avatar to 'image'.",
)
async def upload_agent_avatar(name: str, file: UploadFile = File(...)):
    _validate_agent_name(name)
    code = _normalize_agent_name(name)
    if name.lower() != "main" and not cfg_repo.agent_exists(code):
        raise HTTPException(status_code=404, detail=f"Agent '{code}' not found")
    data = await file.read()
    try:
        save_avatar_bytes(code, data)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    try:
        agent_cfg = load_agent_config(code)
        payload = agent_cfg.model_dump()
        payload["avatar"] = "image"
        save_agent_config(code, payload)
        refreshed = load_agent_config(code)
        return _agent_config_to_response(refreshed, include_soul=False)
    except FileNotFoundError:
        if code == "main":
            _save_main_agent_config({"avatar": "image"})
            return _main_agent_to_response(include_soul=False)
        raise HTTPException(status_code=404, detail=f"Agent '{code}' not found")


@router.delete(
    "/agents/{name}/avatar",
    summary="Delete Agent Avatar Image",
    description="Remove the uploaded avatar file (does not change avatar field).",
    status_code=204,
)
async def delete_agent_avatar_file(name: str):
    _validate_agent_name(name)
    code = _normalize_agent_name(name)
    delete_avatar_file(code)


@router.delete(
    "/agents/{name}",
    status_code=204,
    summary="Delete Custom Agent",
    description="Delete a custom agent and all its files (config, SOUL.md, memory).",
)
async def delete_agent(request: Request, name: str):
    """Delete a custom agent.

    Args:
        name: The agent name.

    Raises:
        HTTPException: 404 if agent not found.
    """
    from evoflow.authz.http_guard import require_agent_visible

    _validate_agent_name(name)
    name = _normalize_agent_name(name)
    require_agent_visible(request, name)

    if not cfg_repo.agent_exists(name):
        raise HTTPException(status_code=404, detail=f"Agent '{name}' not found")

    try:
        from evoflow.admin.agents import delete_agent as admin_delete_agent

        admin_delete_agent(name, confirm_cascade=True)
        logger.info("Deleted agent '%s' from SQLite", name)
    except Exception as e:
        logger.error(f"Failed to delete agent '{name}': {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to delete agent: {str(e)}")


# ============================================================
# Tools / MCP / Skills metadata API
# ============================================================


class ToolInfo(BaseModel):
    """Single tool info for frontend display."""

    name: str = Field(..., description="Tool name (identifier)")
    label: str = Field(..., description="Display label")
    icon: str = Field(default="", description="Emoji icon")
    group: str = Field(default="", description="Tool group")
    description: str = Field(default="", description="Tool description")
    tool_type: str = Field(default="optional", description="Catalog tier: runtime|core|workspace|plan|goal|optional|retired")
    tool_type_label: str = Field(default="", description="Localized tier label for UI")
    role_editor_type_label: str = Field(default="", description="Role editor tier label (workspace→Agent)")


class McpServerInfo(BaseModel):
    """MCP server info for frontend display."""

    value: str = Field(description="Server name (used as form value)")
    label: str = Field(description="Display label")
    icon: str = Field(default="🔌", description="Emoji icon")
    enabled: bool


class SkillInfo(BaseModel):
    """Single skill info for frontend display."""

    name: str = Field(description="Skill identifier / directory name")
    label: str = Field(description="Display name")
    description: str = Field(default="", description="Skill description from SKILL.md frontmatter")
    icon: str = Field(default="🧩", description="Emoji icon")


class ToolListResponse(BaseModel):
    """Response containing available tools, MCP servers and skills."""

    tools: list[ToolInfo]
    mcp_servers: list[McpServerInfo]
    skills: list[SkillInfo]


# Optional Chinese labels/icons for role editor (falls back to tool docstring / Title Case name)
_TOOL_UI_DISPLAY: dict[str, dict] = {
    "ask_clarification": {"label": "等待确认", "icon": "❔", "description": "等待用户确认后再继续"},
    "supervisor": {"label": "任务调度", "icon": "🧭", "description": "创建和管理子任务调度"},
    "task": {"label": "子任务", "icon": "⚡", "description": "委派子任务给其他智能体执行"},
    "view_image": {"label": "查看图片", "icon": "🖼️", "description": "查看和分析图片文件"},
    "invoke_acp_agent": {"label": "ACP 子代理", "icon": "🤖", "description": "调用 ACP 外部代理"},
    "tool_search": {"label": "查找工具", "icon": "🔎", "description": "搜索并调用延迟加载的工具"},
    "read_file": {"label": "读取文件", "icon": "📄", "description": "读取工作区或本地文件内容"},
    "write_to_file": {"label": "写入文件", "icon": "✍️", "description": "写入或追加文件内容"},
    "replace_in_file": {"label": "编辑文件", "icon": "🔧", "description": "在文件中进行精确替换"},
    "delete_file": {"label": "删除文件", "icon": "🗑️", "description": "删除指定文件"},
    "list_dir": {"label": "列出目录", "icon": "📂", "description": "列出目录内容"},
    "search_content": {"label": "搜索内容", "icon": "🔎", "description": "在文件中搜索文本"},
    "execute_command": {"label": "执行命令", "icon": "⌨️", "description": "在本地环境执行 shell 命令"},
    "web_fetch": {"label": "网页抓取", "icon": "🌐", "description": "抓取并读取网页内容"},
    "web_search": {"label": "网络搜索", "icon": "🔍", "description": "联网搜索"},
    "todo": {"label": "待办列表", "icon": "📋", "description": "会话内轻量 checklist（不进任务中心）"},
    "mind_map": {"label": "思维导图", "icon": "🗺️", "description": "维护会话思维导图（workspace 场景）"},
    "process": {"label": "进程管理", "icon": "⚙️", "description": "后台长任务进程 start/log/wait/kill"},
    "automation": {"label": "自动化任务", "icon": "⏰", "description": "创建与管理定时/周期自动化任务"},
    "propose_goal": {
        "label": "目标方案",
        "icon": "🤝",
        "description": "生成 EvoPanel 目标参数（任务目标、轮次、定时等），用户在对话区确认后写入目标面板并可启动",
    },
    "panel_set": {
        "label": "右侧面板",
        "icon": "📺",
        "group": "hosted_panel",
        "description": "打开/关闭 EvoPanel 右侧面板（资讯、网页内嵌、写入内容等）；与 mode_set 对话模式无关；Agent 模式系统必带（非角色可选）",
    },
    "bash": {"label": "终端命令", "icon": "⌨️", "description": "沙箱内执行 shell 命令"},
    "ls": {"label": "列出目录", "icon": "📂", "description": "沙箱内列出目录（树形）"},
    "write_file": {"label": "写入文件", "icon": "✍️", "description": "沙箱内写入或追加文件"},
    "str_replace": {"label": "编辑文件", "icon": "🔧", "description": "沙箱内字符串替换编辑"},
    # Agent management tools
    "create_agent": {"label": "创建智能体", "icon": "🤖", "group": "agent_management", "description": "创建新的自定义智能体，支持中文名、工具/技能配置"},
    "update_agent": {"label": "更新智能体", "icon": "✏️", "group": "agent_management", "description": "更新现有智能体的配置，包括中文名、工具、技能等"},
    "list_agents": {"label": "查询智能体", "icon": "📋", "group": "agent_management", "description": "列出所有可用智能体及其配置信息"},
}


def _get_all_tools() -> list[ToolInfo]:
    """Builtin/native tools for role editor: same name surface as lead agent (minus MCP)."""
    config = get_app_config()
    model_name = config.models[0].name if config.models else None

    specs = collect_native_tool_specs_for_role_ui(model_name=model_name)
    results: list[ToolInfo] = []
    for spec in specs:
        name = str(spec.get("name") or "").strip()
        if not name:
            continue
        disp = _TOOL_UI_DISPLAY.get(name, {})

        # Prefer UI metadata from tool spec, fallback to _TOOL_UI_DISPLAY
        group = str(spec.get("group") or "").strip() or str(disp.get("group") or "").strip()
        label = str(spec.get("label") or "").strip() or str(disp.get("label") or "")
        icon = str(spec.get("icon") or "").strip() or str(disp.get("icon") or "")
        desc = (disp.get("description") or "").strip()
        if not desc:
            desc = str(spec.get("description") or "").strip()
        if not desc and group:
            desc = f"Group: {group}"

        results.append(
            ToolInfo(
                name=name,
                label=label or name.replace("_", " ").title(),
                icon=icon,
                group=group,
                description=desc,
                tool_type=str(spec.get("tool_type") or "optional"),
                tool_type_label=str(spec.get("tool_type_label") or ""),
                role_editor_type_label=str(spec.get("role_editor_type_label") or ""),
            )
        )

    return results


def _get_mcp_servers() -> list[McpServerInfo]:
    """Get configured MCP servers from mcp.json file."""
    servers: list[McpServerInfo] = []
    try:
        from evoflow.mcp.tools import load_mcp_config
        mcp_config = load_mcp_config()
        for name, cfg in mcp_config.items():
            # enabled 默认为 True，除非显式设置为 False
            enabled = cfg.get("enabled", True) is not False
            servers.append(
                McpServerInfo(
                    value=name,
                    label=name,  # mcp.json 中没有 description，使用 name
                    icon="🔌",
                    enabled=enabled,
                )
            )
    except Exception as e:
        logger.warning(f"Failed to load MCP server configs from mcp.json: {e}")
    return servers


def _get_skill_metadata() -> list[SkillInfo]:
    """Get available skill metadata via evoflow loader (skills/public + skills/custom)."""
    from evoflow.skills.loader import load_skills

    _SKILL_ICON_MAP: dict[str, str] = {
        "deep-research": "🔬",
        "data-analysis": "📊",
        "frontend-design": "🎨",
        "pdf": "📄",
        "docx": "📝",
        "pptx": "📽️",
        "xlsx": "📈",
        "video-generation": "🎬",
        "image-generation": "🖼️",
        "ppt-generation": "📊",
        "browser": "🌐",
        "github-deep-research": "💻",
        "consulting-analysis": "📋",
        "chart-visualization": "📉",
        "coding-agent": "💻",
        "playwright": "🎭",
    }
    skills: list[SkillInfo] = []
    try:
        for skill in load_skills(enabled_only=True):
            name = skill.name
            dir_name = skill.skill_dir.name
            icon = _SKILL_ICON_MAP.get(name) or _SKILL_ICON_MAP.get(dir_name, "🧩")
            label = name.replace("-", " ").title()
            description = (skill.description or "").strip()
            if "\n" in description:
                description = description.splitlines()[0].strip()
            skills.append(
                SkillInfo(
                    name=name,
                    label=label,
                    description=description,
                    icon=icon,
                )
            )
    except Exception as e:
        logger.warning(f"Failed to load skill metadata: {e}")
    return skills


@router.get(
    "/tools/metadata",
    response_model=ToolListResponse,
    summary="Get Available Tools Metadata",
    description="Return lists of available builtin tools, MCP servers, and skills for agent configuration UI.",
)
async def get_tools_metadata() -> ToolListResponse:
    """Get metadata about all configurable tools/MCP/skills.

    Returns:
        ToolListResponse with tools, mcp_servers, and skills arrays.
    """
    try:
        return ToolListResponse(
            tools=_get_all_tools(),
            mcp_servers=_get_mcp_servers(),
            skills=_get_skill_metadata(),
        )
    except Exception as e:
        logger.error(f"Failed to get tools metadata: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


class ContextOverheadItem(BaseModel):
    name: str
    tokens: int | None = None
    status: str = "ok"


class ContextOverheadRequest(BaseModel):
    skills: list[str] = Field(default_factory=list)
    tools: list[str] = Field(default_factory=list)
    model: str | None = None
    compact: bool = False
    use_virtual_paths: bool = False


class ContextOverheadResponse(BaseModel):
    skills: list[ContextOverheadItem]
    tools: list[ContextOverheadItem]
    skills_total: int = 0
    tools_total: int = 0
    model: str = ""


@router.post(
    "/agents/context-overhead",
    response_model=ContextOverheadResponse,
    summary="Estimate per-skill / per-tool context tokens",
    description=(
        "Tiktoken (or CJK-aware fallback) estimates matching runtime injection: "
        "skill catalog XML entries in the system prompt, and OpenAI wire tool schemas."
    ),
)
async def post_agents_context_overhead(body: ContextOverheadRequest) -> ContextOverheadResponse:
    try:
        from evoflow.context.capability_token_estimate import estimate_capability_context_tokens

        model = str(body.model or "").strip() or None
        if model is None:
            try:
                cfg = get_app_config()
                if cfg.models:
                    model = cfg.models[0].name
            except Exception:
                model = None
        raw = estimate_capability_context_tokens(
            skills=body.skills,
            tools=body.tools,
            model=model,
            compact=bool(body.compact),
            use_virtual_paths=bool(body.use_virtual_paths),
        )
        return ContextOverheadResponse(
            skills=[ContextOverheadItem(**row) for row in raw.get("skills") or []],
            tools=[ContextOverheadItem(**row) for row in raw.get("tools") or []],
            skills_total=int(raw.get("skills_total") or 0),
            tools_total=int(raw.get("tools_total") or 0),
            model=str(raw.get("model") or model or ""),
        )
    except Exception as e:
        logger.error("context-overhead failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e)) from e
