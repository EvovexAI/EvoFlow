"""Configuration and loaders for custom agents."""

import logging
import re
import time as _agent_cfg_time
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field, computed_field, model_validator

logger = logging.getLogger(__name__)

_builtin_agents_materialized: bool = False

# Short-TTL cache for load_agent_config — 4+ middlewares (12+ call sites)
# call this during a single model turn. A 10-second TTL eliminates redundant
# SQLite reads while staying fresh for agent config edits.
_agent_config_cache: dict[str, tuple[Any, float]] = {}
_AGENT_CONFIG_CACHE_TTL = 10.0


def invalidate_agent_config_cache(agent_code: str | None = None) -> None:
    """Clear the agent config cache (call after save_agent_config or delete)."""
    if agent_code:
        _agent_config_cache.pop(str(agent_code).strip().lower(), None)
    else:
        _agent_config_cache.clear()
    try:
        from evoflow.session_tool_binding.agent_tools import invalidate_agent_tool_names_cache

        invalidate_agent_tool_names_cache(agent_code)
    except Exception:
        pass

SOUL_FILENAME = "SOUL.md"
AGENT_NAME_PATTERN = re.compile(r"^[A-Za-z0-9-]+$")

# Ship-with-product SOUL.md defaults for built-in agents
_BUNDLED_SOULS_DIR = (
    Path(__file__).resolve().parent.parent / "assets" / "builtin_agent_souls"
)


def bundled_soul_path(agent_code: str) -> Path | None:
    """Return the packaged default SOUL.md for a built-in agent code, if any."""
    try:
        code = str(agent_code or "").strip().lower()
        if not code or not re.match(r"^[a-z0-9-]+$", code):
            return None
    except Exception:
        return None
    p = _BUNDLED_SOULS_DIR / f"{code}.md"
    if p.is_file():
        return p
    return None


def load_bundled_soul(agent_code: str) -> str | None:
    """Load the packaged SOUL.md content for a built-in agent, if available."""
    src = bundled_soul_path(agent_code)
    if src is None:
        return None
    try:
        return src.read_text(encoding="utf-8")
    except OSError:
        logger.warning("failed to read bundled soul for %s from %s", agent_code, src, exc_info=True)
        return None


class AgentConfig(BaseModel):
    """Unified configuration for all types of agents.

    Attributes:
        agent_code: Unique identifier for the agent (hyphen-case, e.g. "online-search-genius").
        agent_name: Chinese display name for UI (e.g. "在线搜索天才").
        description: What the agent does.
        model: Model to use (optional).
        tool_groups: Optional tool group whitelist.
        tools: Optional tool whitelist (builtin tool names).
        mcp_servers: Optional MCP server names.
        skills: Skill names injected into prompt; missing or null means none (see resolve_skill_allowlist_for_lead_prompt).
        agent_type: Type of agent - 'custom', 'subagent', or 'acp'.
        system_prompt: For subagents - the system prompt.
        disallowed_tools: For subagents - optional tool blacklist.
        max_turns: For subagents - maximum number of turns.
        prompt_language: System prompt locale for built-in templates (``zh`` or ``en``; default from env).
        timeout_seconds: For subagents/ACP - timeout in seconds.
        command: For ACP - command to execute.
        args: For ACP - command arguments.
        env: For ACP - environment variables.
        auto_approve_permissions: For ACP - auto-approve permission requests.
    """

    agent_code: str
    agent_name: str | None = None
    description: str = ""
    model: str | None = None
    tool_groups: list[str] | None = None

    # Tool / MCP / Skills / Knowledge configuration
    tools: list[str] | None = None
    mcp_servers: list[str] | None = None
    skills: list[str] | None = None
    # Bound knowledge vault / owned KB ids (empty = none). Unlike tools/MCP, missing is not「全部」.
    knowledge_vault_ids: list[str] = Field(default_factory=list)

    # Agent type discriminator
    agent_type: Literal["custom", "subagent", "acp"] = "custom"
    # Tags (label strings) persisted in ``evoflow_agents.tags_json``; replaces
    # the former ``team_code`` single-bucket grouping (see schema v82).
    tags: list[str] = []

    # Subagent-specific fields
    system_prompt: str | None = None
    disallowed_tools: list[str] | None = None
    max_turns: int = 500
    prompt_language: str | None = None
    timeout_seconds: int = 900

    # ACP-specific fields
    command: str | None = None
    args: list[str] | None = None
    env: dict[str, str] | None = None
    auto_approve_permissions: bool = False

    # UI avatar: preset:mochi|ink|bolt, emoji:🔧, image (uploaded cutout), or null → code-based default
    avatar: str | None = None
    # Optional metadata for custom image avatars (aspect ratio, head crop box)
    avatar_meta: dict[str, Any] | None = None
    # Optional Volcengine TTS voice_type（会议室/语音播报；空则前端按 agent 哈希分配）
    tts_speaker: str | None = None

    @model_validator(mode="before")
    @classmethod
    def _legacy_name_kw(cls, data: Any) -> Any:
        """Accept ``name=`` / YAML ``name:`` as alias for ``agent_code`` (tests and older configs)."""
        if isinstance(data, dict) and "name" in data:
            if "agent_code" not in data:
                data = {**data, "agent_code": data["name"]}
            data = {k: v for k, v in data.items() if k != "name"}
        return data

    @computed_field  # type: ignore[prop-decorator]
    @property
    def name(self) -> str:
        """Alias for :attr:`agent_code` (backward compatible API)."""
        return self.agent_code


def resolve_skill_allowlist_for_lead_prompt(agent_config: AgentConfig | None) -> set[str]:
    """Skill names injected into the lead-agent system prompt (opt-in).

    Formerly, a missing ``skills`` key or missing ``agents/main`` was treated as *all skills*,
    which overloaded fresh installs. Now:

    - No ``agent_config`` (e.g. no ``agents/main/config.yaml`` yet): **no** skills.
    - ``skills`` key absent or null in YAML (**None** in :class:`AgentConfig`): **no** skills.
    - ``skills: []``: **no** skills.
    - ``skills: ["a", "b"]``: only those skills (after strip / drop empty).

    To use every installed skill, list skill names explicitly in ``agents/<code>/config.yaml``.
    """
    if agent_config is None:
        return set()
    if agent_config.skills is None:
        return set()
    return {str(s).strip() for s in agent_config.skills if str(s).strip()}


def parse_preferred_skills_from_context(cfg: dict[str, Any] | None) -> list[str]:
    """User-selected skills from chat composer (per-turn run context)."""
    if not isinstance(cfg, dict):
        return []
    raw = cfg.get("preferred_skills")
    if raw is None:
        single = str(cfg.get("preferred_skill") or "").strip()
        return [single] if single else []
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, (list, tuple)):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in raw:
        name = str(item or "").strip()
        if not name or name in seen:
            continue
        seen.add(name)
        out.append(name)
    return out


def merge_skill_allowlist_with_preferred(
    base: set[str],
    preferred: list[str] | Any,
    *,
    enabled_only: bool = True,
) -> set[str]:
    """Union role skill allowlist with composer-selected skills for this turn."""
    from evoflow.config.agent_resource_validation import valid_skill_names

    names = preferred if isinstance(preferred, list) else parse_preferred_skills_from_context({"preferred_skills": preferred})
    out = set(base)
    if not names:
        return out
    if enabled_only:
        valid = valid_skill_names(enabled_only=enabled_only)
        names = [n for n in names if n in valid]
    out.update(names)
    return out


def _normalize_agent_config_data(data: dict[str, Any], name: str) -> dict[str, Any]:
    if "agent_code" not in data and "name" not in data:
        data["agent_code"] = name
    elif "name" in data:
        data["agent_code"] = data.pop("name")
    if "name_cn" in data:
        data["agent_name"] = data.pop("name_cn")
    if "type" in data and "agent_type" not in data:
        data["agent_type"] = data.pop("type")
    known_fields = set(AgentConfig.model_fields.keys())
    return {k: v for k, v in data.items() if k in known_fields}


def load_agent_config(name: str | None) -> AgentConfig | None:
    """Load agent config from SQLite ``evoflow_agents``.

    Uses a 10-second TTL cache to avoid redundant reads across the middleware chain
    (4+ middlewares call this per model turn). Call ``invalidate_agent_config_cache``
    after ``save_agent_config`` to ensure freshness.
    """
    if name is None:
        return None

    if not AGENT_NAME_PATTERN.match(name):
        raise ValueError(f"Invalid agent name '{name}'. Must match pattern: {AGENT_NAME_PATTERN.pattern}")

    key = name.lower()
    now = _agent_cfg_time.monotonic()
    cached = _agent_config_cache.get(key)
    if cached is not None and now - cached[1] < _AGENT_CONFIG_CACHE_TTL:
        return cached[0]

    from evoflow.persistence import config_repositories as cfg_repo

    data = cfg_repo.get_agent_config(name)
    if data is None:
        raise FileNotFoundError(f"Agent config not found in database: {name!r}")

    data = _normalize_agent_config_data(dict(data), name)
    result = AgentConfig(**data)
    _agent_config_cache[key] = (result, now)
    return result


def save_agent_config(agent_code: str, config_data: dict) -> None:
    """Save agent configuration to SQLite ``evoflow_agents``."""
    if not AGENT_NAME_PATTERN.match(agent_code):
        raise ValueError(f"Invalid agent code '{agent_code}'. Must match pattern: {AGENT_NAME_PATTERN.pattern}")

    from evoflow.persistence import config_repositories as cfg_repo

    agent_code = agent_code.lower()
    payload = config_data.copy()
    payload["agent_code"] = agent_code
    known_fields = set(AgentConfig.model_fields.keys())
    payload = {k: v for k, v in payload.items() if k in known_fields}
    # 若本次只写了 soul 而未提供 system_prompt，自动用 soul 补齐 system_prompt，
    # 避免出现「有灵魂但不可被工作流/任务调度」的 agent（调度器只看 system_prompt）。
    if not str(payload.get("system_prompt") or "").strip():
        soul = str(payload.get("soul") or "").strip() or (load_agent_soul(agent_code) or "").strip()
        if soul:
            payload["system_prompt"] = soul
    # Infer initial tags for non-main agents when none were provided. Tags are
    # persisted via the dedicated ``tags_json`` column (schema v82), replacing
    # the former ``team_code`` single-bucket grouping.
    if agent_code != "main" and not [t for t in (payload.get("tags") or []) if str(t).strip()]:
        from evoflow.config.agent_tags import infer_tags_for_agent

        inferred_tags = infer_tags_for_agent(
            agent_code,
            agent_type=str(payload.get("agent_type") or "custom"),
        )
        if inferred_tags:
            payload["tags"] = inferred_tags
    cfg_repo.upsert_agent(agent_code, payload)
    invalidate_agent_config_cache(agent_code)


# 首次落盘「主会话 main + 通用子智能体 general-purpose」时写入 config.yaml 的技能 wishlist（与已安装且启用的技能求交）。
# 含：自介绍、AI HOT、深度搜索、预设角色、技能编写；生图默认用官方 byted-ark-seedream-skill。
DEFAULT_LEAD_FAMILY_SKILLS_WISHLIST: tuple[str, ...] = (
    "evoflow-intro",
    "evoflow-admin",
    "aihot",
    "deep-research",
    "preset-role-assistant",
    "skill-creator",
    "byted-ark-seedream-skill",
)

# 已有 main / general-purpose 落盘后仍应补上的基础技能（幂等合并，仅追加缺失项）
BASELINE_SKILLS_ALWAYS_MERGE: tuple[str, ...] = ("evoflow-intro", "evoflow-admin")


def resolved_skills_for_materialize(wishlist: tuple[str, ...] | None = None) -> list[str]:
    """Return ``wishlist`` ∩ installed skills that are currently enabled (stable order)."""
    wl = wishlist if wishlist is not None else DEFAULT_LEAD_FAMILY_SKILLS_WISHLIST
    try:
        from evoflow.skills import load_skills

        enabled = {s.name for s in load_skills(enabled_only=True)}
    except Exception:
        logger.warning("load_skills failed while resolving materialize skill wishlist", exc_info=True)
        return []
    return [name for name in wl if name in enabled]


def merge_baseline_skills_into_agent(agent_code: str, *, baseline: tuple[str, ...] | None = None) -> None:
    """Append missing baseline skills (e.g. evoflow-intro) to an existing agent config."""
    from evoflow.persistence import config_repositories as cfg_repo

    codes = (agent_code or "").strip().lower()
    if not codes or not cfg_repo.agent_exists(codes):
        return
    names = baseline if baseline is not None else BASELINE_SKILLS_ALWAYS_MERGE
    if not names:
        return
    try:
        from evoflow.skills import load_skills

        enabled = {s.name for s in load_skills(enabled_only=True)}
    except Exception:
        logger.warning("merge_baseline_skills: load_skills failed", exc_info=True)
        return
    try:
        cfg = load_agent_config(codes)
    except Exception:
        logger.warning("merge_baseline_skills: load_agent_config failed for %r", codes, exc_info=True)
        return
    # skills None = no allowlist yet; still merge baseline intro for main/gp
    skills = list(cfg.skills or [])
    merged: list[str] = []
    for name in reversed(names):
        if name in enabled and name not in skills:
            skills.insert(0, name)
            merged.append(name)
    if not merged:
        return
    payload = cfg.model_dump(mode="python", exclude={"name"})
    payload["skills"] = skills
    save_agent_config(codes, payload)
    logger.info("[BaselineSkills] merged into agent %r: %s", codes, merged)


def merge_baseline_skills_for_lead_family() -> None:
    """Ensure main + general-purpose include baseline skills (idempotent).

    小V（xiaomi）是系统前台，不挂普通技能面——见 :func:`enforce_xiaomi_front_desk_capabilities`。
    """
    for code in ("main", "general-purpose"):
        merge_baseline_skills_into_agent(code)


def xiaomi_front_desk_capability_defaults() -> dict[str, list[str]]:
    """小V 持久化能力面：无角色可配置工具 / MCP / 技能。

    运行时由 ``filter_xiaomi_tools`` + ``get_xiaomi_tools`` 挂载前台系统工具
    （名册 / 看板 / 派发 / 催办 / 知识检索），与普通智能体白名单无关。
    """
    return {
        "tools": [],
        "mcp_servers": [],
        "skills": [],
    }


def enforce_xiaomi_front_desk_capabilities() -> bool:
    """Force existing ``xiaomi`` config off the ordinary agent tool/skill/MCP surface.

    Returns True when the config was written (or already correct after load).
    """
    from evoflow.persistence import config_repositories as cfg_repo

    if not cfg_repo.agent_exists("xiaomi"):
        return False
    try:
        xm_cfg = load_agent_config("xiaomi")
    except FileNotFoundError:
        return False
    caps = xiaomi_front_desk_capability_defaults()
    xm_full = xm_cfg.model_dump(exclude_none=False, exclude={"name"})
    changed = False
    for key, desired in caps.items():
        current = xm_full.get(key)
        if current != desired:
            xm_full[key] = list(desired)
            changed = True
    # Drop stale nulls that UI treats as「全工具 / 全 MCP」
    for key in caps:
        if xm_full.get(key) is None:
            xm_full[key] = []
            changed = True
    if changed:
        # Persist empty lists (exclude_none would drop them and revive「全量」语义).
        save_agent_config("xiaomi", {k: v for k, v in xm_full.items() if v is not None or k in caps})
        logger.info(
            "[Xiaomi] enforced front-desk capabilities tools=%s mcp=%s skills=%s",
            caps["tools"],
            caps["mcp_servers"],
            caps["skills"],
        )
    return True


def sync_skills_then_merge_baseline_for_lead_family() -> None:
    """Startup hook: refresh skill registry from disk, then patch lead-family agents."""
    try:
        from evoflow.persistence.bootstrap import sync_skills_from_filesystem

        sync_skills_from_filesystem()
    except Exception:
        logger.warning("sync_skills_then_merge_baseline: filesystem sync failed", exc_info=True)
    merge_baseline_skills_for_lead_family()


# Display names aligned with evoflow.collab.agent_assignment.BUILTIN_AGENT_UI_NAMES (list_agents / UI).
_BUILTIN_SUBAGENT_UI_NAMES: dict[str, str] = {
    "general-purpose": "通用助手",
    "code-agent": "代码助手",
    "bash": "终端执行",
    "claude-code": "Claude Code",
    "knowledge-retriever": "知识检索",
    "knowledge-curator": "知识整理",
    "project-architect": "项目·方案",
    "project-planner": "项目·计划",
    "project-implementer": "项目·开发",
    "project-reviewer": "项目·审查",
    "project-debugger": "项目·测试",
    "project-qa": "项目·验收",
    "media-screenwriter": "媒体·编剧",
    "media-visual-planner": "媒体·视觉策划",
    "media-artist": "媒体·美术",
    "media-video-director": "媒体·视频导演",
    "media-voice-director": "媒体·配音",
    "media-post": "媒体·后期",
    "hf-developer": "HyperFrames·动画开发",
    "hf-visual-designer": "HyperFrames·视觉设计",
    "hf-director": "HyperFrames·导演",
    "hf-renderer": "HyperFrames·后期",
    "marketing-social-media-operation": "社媒运营",
    "finance-intake": "财务·收单分类",
    "finance-compliance": "财务·合规校验",
    "finance-risk": "财务·风控识别",
    "finance-ledger": "财务·科目汇总",
}

# Default image avatars for built-in agents (and main).
# Format: "image" — file under agents/{code}/avatar.* seeded from packaged cutouts.
# EvoFlow ``main`` 使用平台 logo（builtin_agent_avatars/main.png），非商务卡通人像。
# 小V uses a female gallery preset (not the shared ``main`` cutout).
_XIAOMI_DEFAULT_AVATAR = "preset:analyst"
_BUILTIN_AGENT_AVATARS: dict[str, str] = {
    "main": "image",
    "xiaomi": _XIAOMI_DEFAULT_AVATAR,
    "general-purpose": "image",
    "bash": "image",
    "code-agent": "image",
    "claude-code": "image",
    "project-architect": "image",
    "project-planner": "image",
    "project-implementer": "image",
    "project-reviewer": "image",
    "project-debugger": "image",
    "project-qa": "image",
    "quality-inspector": "image",
    "media-screenwriter": "image",
    "media-visual-planner": "image",
    "media-artist": "image",
    "media-video-director": "image",
    "media-voice-director": "image",
    "media-post": "image",
    "hf-developer": "image",
    "hf-visual-designer": "image",
    "hf-director": "image",
    "hf-renderer": "image",
    "marketing-social-media-operation": "image",
    "finance-intake": "image",
    "finance-compliance": "image",
    "finance-risk": "image",
    "finance-ledger": "image",
    "product-manager": "image",
}

# Custom / role agents without a packaged cutout — stable emoji fallbacks.
_CUSTOM_AGENT_AVATAR_DEFAULTS: dict[str, str] = {}


def _skills_from_wishlist(wishlist: tuple[str, ...]) -> list[str]:
    try:
        from evoflow.skills import load_skills

        enabled = {s.name for s in load_skills(enabled_only=True)}
    except Exception:
        logger.warning("load_skills failed while resolving agent skill wishlist", exc_info=True)
        return []
    return [name for name in wishlist if name in enabled]


def _payload_for_builtin_subagent(code: str, sub: Any, *, gp_skill_bundle: list[str] | None = None) -> dict[str, Any]:
    """Build SQLite payload for one built-in subagent template."""
    from evoflow.config.agent_tags import infer_tags_for_agent
    from evoflow.subagents.builtins.project_crew import PROJECT_AGENT_SKILL_WISHLISTS

    avatar = _BUILTIN_AGENT_AVATARS.get(code)
    payload: dict[str, Any] = {
        "agent_type": "subagent",
        "description": sub.description,
        "system_prompt": sub.system_prompt,
        "disallowed_tools": list(sub.disallowed_tools),
        "max_turns": sub.max_turns,
        "timeout_seconds": sub.timeout_seconds,
        "tags": infer_tags_for_agent(code, agent_type="subagent"),
    }
    ui = _BUILTIN_SUBAGENT_UI_NAMES.get(code)
    if ui:
        payload["agent_name"] = ui
    if avatar:
        payload["avatar"] = avatar
    if sub.tools is not None:
        payload["tools"] = list(sub.tools)
    if sub.model and str(sub.model).strip() and sub.model != "inherit":
        payload["model"] = sub.model

    bundle = list(gp_skill_bundle or [])
    if code == "general-purpose" and bundle:
        payload["skills"] = list(bundle)
    elif code.startswith("media-"):
        if code == "media-artist" and "byted-ark-seedream-skill" in bundle:
            payload["skills"] = ["byted-ark-seedream-skill"]
        elif "media-production" in bundle:
            payload["skills"] = ["media-production"]
    elif code.startswith("hf-"):
        from evoflow.subagents.builtins.hyperframes_crew import HYPERFRAMES_AGENT_SKILL_WISHLISTS

        wishlist = HYPERFRAMES_AGENT_SKILL_WISHLISTS.get(code, ())
        hf_skills = _skills_from_wishlist(wishlist)
        if hf_skills:
            payload["skills"] = hf_skills
    elif code.startswith("project-"):
        wishlist = PROJECT_AGENT_SKILL_WISHLISTS.get(code, ())
        project_skills = _skills_from_wishlist(wishlist)
        if project_skills:
            payload["skills"] = project_skills
    elif code.startswith("finance-"):
        from evoflow.subagents.builtins.finance_crew import FINANCE_AGENT_SKILL_WISHLISTS

        wishlist = FINANCE_AGENT_SKILL_WISHLISTS.get(code, ())
        finance_skills = _skills_from_wishlist(wishlist)
        if finance_skills:
            payload["skills"] = finance_skills
    elif code == "marketing-social-media-operation":
        from evoflow.subagents.builtins.marketing_crew import MARKETING_AGENT_SKILL_WISHLIST

        marketing_skills = _skills_from_wishlist(MARKETING_AGENT_SKILL_WISHLIST)
        if marketing_skills:
            payload["skills"] = marketing_skills
    return payload


def _should_refresh_builtin_ui_name(current: str | None, code: str, desired: str | None) -> bool:
    """True when stored display name is empty, equals code, or legacy name 小蜜."""
    want = str(desired or "").strip()
    if not want:
        return False
    cur = str(current or "").strip()
    if cur == want:
        return False
    if not cur or cur.lower() == code.lower() or cur in {"小蜜", "Xiaomi"}:
        return True
    # Refresh when name drifted from product map (builtins are template-owned).
    return True


def _refresh_builtin_subagent_from_template(
    code: str,
    sub: Any,
    *,
    gp_skill_bundle: list[str] | None = None,
) -> None:
    """Overwrite template-owned fields for an existing built-in subagent row."""
    try:
        existing = load_agent_config(code)
    except FileNotFoundError:
        return
    if existing is None:
        return
    payload = _payload_for_builtin_subagent(code, sub, gp_skill_bundle=gp_skill_bundle)
    full = existing.model_dump(mode="python", exclude_none=False)
    changed = False

    for key in (
        "description",
        "system_prompt",
        "disallowed_tools",
        "max_turns",
        "timeout_seconds",
        "tags",
    ):
        if key not in payload:
            continue
        if full.get(key) != payload[key]:
            full[key] = payload[key]
            changed = True

    # ``tools`` is user-owned after first create (EvoPanel role editor).
    # Do not overwrite an explicit whitelist, and do not clear it back to None when
    # the template uses tools=None (inherit). That clear used to wipe code-agent
    # (and similar) tool edits on every Gateway restart / materialize pass.

    desired_name = payload.get("agent_name")
    if _should_refresh_builtin_ui_name(existing.agent_name, code, desired_name):
        full["agent_name"] = desired_name
        changed = True

    if "skills" in payload and full.get("skills") != payload["skills"]:
        full["skills"] = payload["skills"]
        changed = True

    if changed:
        save_agent_config(code, full)


def _builtin_subagents_registry() -> dict[str, Any]:
    """Load built-in subagent templates without pulling heavy ``subagents.executor`` imports."""
    from evoflow.subagents.builtins import BUILTIN_SUBAGENTS

    return BUILTIN_SUBAGENTS


def materialize_builtin_agent_if_missing(agent_code: str) -> bool:
    """Create one built-in subagent row if missing. Returns True when present afterwards."""
    code = str(agent_code or "").strip().lower()
    if not code:
        return False
    from evoflow.persistence import config_repositories as cfg_repo

    if cfg_repo.agent_exists(code):
        return True
    # System front desk is a lead-family custom agent, not a subagent template.
    if code == "xiaomi":
        try:
            ensure_builtin_agents_materialized()
        except Exception:
            logger.warning("materialize xiaomi via ensure_builtin failed", exc_info=True)
        return cfg_repo.agent_exists("xiaomi")
    try:
        sub = _builtin_subagents_registry().get(code)
    except Exception:
        logger.warning("materialize_builtin_agent_if_missing: builtin registry import failed", exc_info=True)
        return False
    if sub is None:
        return False
    try:
        gp_skill_bundle = resolved_skills_for_materialize()
        save_agent_config(code, _payload_for_builtin_subagent(code, sub, gp_skill_bundle=gp_skill_bundle))
        if cfg_repo.get_agent_soul(code) is None:
            bundled = load_bundled_soul(code)
            cfg_repo.save_agent_soul(code, bundled if bundled else f"# {code}\n\nBuilt-in subagent template (auto-created).")
        logger.info("materialized missing builtin agent code=%s", code)
        return cfg_repo.agent_exists(code)
    except Exception:
        logger.warning("materialize_builtin_agent_if_missing failed code=%s", code, exc_info=True)
        return False


def ensure_builtin_agents_materialized() -> None:
    """Persist built-in subagent templates under ``agents/{code}/`` when ``config.yaml`` is missing.

    Idempotent: once run successfully per process, subsequent calls are no-ops.
    Flag is only set after a successful pass so a failed first attempt can retry.
    """
    global _builtin_agents_materialized
    if _builtin_agents_materialized:
        return

    sync_skills_then_merge_baseline_for_lead_family()

    from evoflow.persistence import config_repositories as cfg_repo

    gp_skill_bundle = resolved_skills_for_materialize()
    builtin_subagents = _builtin_subagents_registry()

    for code, sub in builtin_subagents.items():
        avatar = _BUILTIN_AGENT_AVATARS.get(code)
        if not cfg_repo.agent_exists(code):
            payload = _payload_for_builtin_subagent(code, sub, gp_skill_bundle=gp_skill_bundle)
            save_agent_config(code, payload)
        else:
            # Built-ins: refresh name/description/tags from template; tools stay user-owned.
            try:
                _refresh_builtin_subagent_from_template(code, sub, gp_skill_bundle=gp_skill_bundle)
            except Exception:
                logger.debug("refresh builtin subagent skipped code=%s", code, exc_info=True)

        # Backfill / upgrade avatar for existing agents (null or legacy emoji/preset).
        if avatar and cfg_repo.agent_exists(code):
            try:
                existing = load_agent_config(code)
            except FileNotFoundError:
                existing = None
            if existing is not None and _should_upgrade_builtin_avatar(existing.avatar, avatar):
                full = existing.model_dump(exclude_none=True)
                full["avatar"] = avatar
                save_agent_config(code, full)

        if cfg_repo.get_agent_soul(code) is None:
            bundled = load_bundled_soul(code)
            cfg_repo.save_agent_soul(code, bundled if bundled else f"# {code}\n\nBuilt-in subagent template (auto-created).")

    merge_baseline_skills_for_lead_family()

    # ``main`` = general lead agent (do not hijack as 小V).
    if not cfg_repo.agent_exists("main") and gp_skill_bundle:
        save_agent_config(
            "main",
            {
                "agent_type": "custom",
                "agent_name": "EvoFlow",
                "description": "默认主智能体：问答、改代码、编排任务。",
                "skills": list(gp_skill_bundle),
                "avatar": _BUILTIN_AGENT_AVATARS.get("main"),
            },
        )

    # Backfill avatar + restore main if a prior build renamed it to 小V (legacy front desk).
    if cfg_repo.agent_exists("main"):
        try:
            main_cfg = load_agent_config("main")
        except FileNotFoundError:
            main_cfg = None
        if main_cfg is not None:
            main_full = main_cfg.model_dump(exclude_none=True)
            changed = False
            desired_main_avatar = _BUILTIN_AGENT_AVATARS.get("main")
            if _should_upgrade_builtin_avatar(main_cfg.avatar, desired_main_avatar):
                main_full["avatar"] = desired_main_avatar
                changed = True
            # 旧商务人像 cutout 可能带 head crop meta；几何头像不需要，清掉以免 UI 裁切异常
            # （用户自行上传的 avatar 不碰）
            if main_cfg.avatar_meta and str(main_cfg.avatar or "").strip() in {"", "image"}:
                try:
                    from evoflow.config.agent_avatars import _read_avatar_source

                    src = _read_avatar_source("main") or ""
                except Exception:
                    src = ""
                if src != "user":
                    main_full["avatar_meta"] = None
                    changed = True
            old_name = str(main_cfg.agent_name or "").strip()
            if old_name in {"", "小蜜", "Xiaomi", "main", "超级助手", "Evo Assistant"}:
                main_full["agent_name"] = "EvoFlow"
                changed = True
            old_desc = str(main_cfg.description or "").strip()
            if (not old_desc) or ("全局前台" in old_desc and "传讯" in old_desc):
                main_full["description"] = "默认主智能体：问答、改代码、编排任务。"
                changed = True
            if not str(main_cfg.prompt_language or "").strip():
                main_full["prompt_language"] = "zh"
                changed = True
            if changed:
                save_agent_config("main", main_full)
            # Seed/refresh soul when missing, placeholder, or still the old front-desk text
            # (legacy display name「小蜜」or「小V」mistakenly on main).
            try:
                cur_soul = (load_agent_soul("main") or "").strip()
                bundled = load_bundled_soul("main") or ""
                if bundled and (
                    not cur_soul
                    or cur_soul.startswith("# main")
                    or cur_soul.startswith("# 小蜜")
                    or cur_soul.startswith("# 小V")
                    or cur_soul.startswith("# 超级助手")
                    or "全局前台助手" in cur_soul
                    or "Built-in subagent" in cur_soul
                ):
                    save_agent_soul("main", bundled)
            except Exception:
                logger.debug("main soul backfill skipped", exc_info=True)

    # ``xiaomi`` = system front desk (separate builtin; never overwrite ``main``).
    # Capability surface is fixed: no ordinary tools / MCP / skills (runtime mounts xiaomi_*).
    _xm_caps = xiaomi_front_desk_capability_defaults()
    if not cfg_repo.agent_exists("xiaomi"):
        save_agent_config(
            "xiaomi",
            {
                "agent_type": "custom",
                "agent_name": "小V",
                "description": (
                    "用户的全局前台：接待、传讯、分诊给智能体员工；不亲自做一线工程。"
                ),
                **_xm_caps,
                "avatar": _BUILTIN_AGENT_AVATARS.get("xiaomi"),
            },
        )
    if cfg_repo.agent_exists("xiaomi"):
        try:
            xm_cfg = load_agent_config("xiaomi")
        except FileNotFoundError:
            xm_cfg = None
        if xm_cfg is not None:
            xm_full = xm_cfg.model_dump(exclude_none=False, exclude={"name"})
            xm_changed = False
            desired_xm_avatar = _BUILTIN_AGENT_AVATARS.get("xiaomi") or _XIAOMI_DEFAULT_AVATAR
            if _should_upgrade_xiaomi_avatar(xm_cfg.avatar, desired_xm_avatar):
                xm_full["avatar"] = desired_xm_avatar
                xm_changed = True
                try:
                    from evoflow.config.agent_avatars import delete_avatar_file

                    delete_avatar_file("xiaomi")
                except Exception:
                    logger.debug("xiaomi avatar cutout cleanup skipped", exc_info=True)
            if not str(xm_cfg.agent_name or "").strip() or str(xm_cfg.agent_name or "").strip() in {
                "小蜜",
                "Xiaomi",
                "xiaomi",
            }:
                xm_full["agent_name"] = "小V"
                xm_changed = True
            if not str(xm_cfg.description or "").strip():
                xm_full["description"] = (
                    "用户的全局前台：接待、传讯、分诊给智能体员工；不亲自做一线工程。"
                )
                xm_changed = True
            for key, desired in _xm_caps.items():
                if xm_full.get(key) != desired:
                    xm_full[key] = list(desired)
                    xm_changed = True
            if xm_changed:
                # Keep empty capability lists so UI/API do not treat null as「全量」.
                save_agent_config(
                    "xiaomi",
                    {k: v for k, v in xm_full.items() if v is not None or k in _xm_caps},
                )
        # Idempotent enforce even when only name/avatar were already correct.
        try:
            enforce_xiaomi_front_desk_capabilities()
        except Exception:
            logger.debug("enforce_xiaomi_front_desk_capabilities skipped", exc_info=True)
        try:
            _clear_xiaomi_bundled_male_cutout_if_using_preset()
        except Exception:
            logger.debug("xiaomi male cutout cleanup skipped", exc_info=True)
        try:
            cur_soul = (load_agent_soul("xiaomi") or "").strip()
            bundled = load_bundled_soul("xiaomi") or ""
            if bundled and (
                not cur_soul
                or cur_soul.startswith("# xiaomi")
                or cur_soul.startswith("# 小蜜")
                or cur_soul.startswith("# 小V")
                or "Built-in subagent" in cur_soul
                or "禁止 Markdown" not in cur_soul
            ):
                save_agent_soul("xiaomi", bundled)
        except Exception:
            logger.debug("xiaomi soul backfill skipped", exc_info=True)

    # Copy packaged cutouts into agents/{code}/ so has_avatar_file /api/.../avatar work
    # on fresh installs; also refresh superseded product defaults for existing installs
    # without clobbering user-uploaded avatars.
    try:
        from evoflow.config.agent_avatars import (
            ensure_builtin_avatar_files,
            refresh_stale_builtin_avatars,
        )

        # Seed every file under builtin_agent_avatars/, not only the map keys.
        ensure_builtin_avatar_files(None)
        refresh_stale_builtin_avatars(None)
    except Exception:
        logger.debug("ensure_builtin_avatar_files skipped", exc_info=True)

    # Backfill avatar field for agents that still have null but we know a default.
    try:
        _backfill_missing_agent_avatars()
    except Exception:
        logger.debug("backfill_missing_agent_avatars skipped", exc_info=True)

    # Hire/refresh 小V常驻岗（agent_code=xiaomi）进入智能体员工名册心跳。
    try:
        from evoflow.agents.xiaomi.duty import ensure_xiaomi_proactive_role

        ensure_xiaomi_proactive_role()
    except Exception:
        # Fresh installs must still surface seed failures (not silent debug).
        logger.warning("ensure_xiaomi_proactive_role failed", exc_info=True)

    _builtin_agents_materialized = True


def _clear_xiaomi_bundled_male_cutout_if_using_preset() -> None:
    """When 小V uses a gallery preset, drop the aliased male ``main`` seed on disk.

    Leftover ``agents/xiaomi/avatar.*`` from the old ``xiaomi→main`` alias confuses
    ``has_avatar_file`` and can resurface the male lead face in some UI paths.
    """
    try:
        cfg = load_agent_config("xiaomi")
    except Exception:
        return
    avatar = str(getattr(cfg, "avatar", "") or "").strip()
    if not avatar.startswith("preset:"):
        return
    try:
        from evoflow.config.agent_avatars import (
            _read_avatar_source,
            delete_avatar_file,
            has_local_avatar_file,
        )

        if not has_local_avatar_file("xiaomi"):
            return
        source = _read_avatar_source("xiaomi") or ""
        # Only remove product-seeded cutouts, never a user upload.
        if source.startswith("bundled:") or not source:
            delete_avatar_file("xiaomi")
            logger.info("cleared stale bundled cutout for xiaomi (avatar=%s)", avatar)
    except Exception:
        logger.debug("xiaomi bundled cutout cleanup skipped", exc_info=True)


def _is_legacy_non_image_avatar(avatar: str | None) -> bool:
    """True when stored avatar is empty, emoji, or obsolete UI preset (not a real cutout).

    Valid gallery ``preset:<id>`` values are intentional user choices and must not
    be upgraded back to the packaged ``image`` cutout on every materialize.
    """
    raw = str(avatar or "").strip()
    if not raw:
        return True
    if raw == "image":
        return False
    if raw.startswith("emoji:"):
        return True
    if raw.startswith("preset:"):
        try:
            from evoflow.config.avatar_presets import parse_preset_avatar

            # Known gallery preset → keep; unknown / mochi|ink|bolt → upgrade.
            if parse_preset_avatar(raw):
                return False
        except Exception:
            pass
        return True
    return False


def _should_upgrade_builtin_avatar(current: str | None, desired: str | None) -> bool:
    """Upgrade null/emoji/legacy preset → product default (usually ``image``)."""
    want = str(desired or "").strip()
    if not want:
        return False
    cur = str(current or "").strip()
    if cur == want:
        return False
    return _is_legacy_non_image_avatar(cur)


def _should_upgrade_xiaomi_avatar(current: str | None, desired: str | None = None) -> bool:
    """小V must not keep the shared male lead cutout (``image`` / main alias).

    - Empty / emoji / legacy → product default (``preset:analyst``)
    - ``image`` (bundled male) → product default
    - Another valid gallery ``preset:<id>`` → keep (user choice)
    """
    want = str(desired or _XIAOMI_DEFAULT_AVATAR).strip() or _XIAOMI_DEFAULT_AVATAR
    cur = str(current or "").strip()
    if cur == want:
        return False
    if not cur or cur == "image" or cur.startswith("emoji:"):
        return True
    if cur.startswith("preset:"):
        try:
            from evoflow.config.avatar_presets import parse_preset_avatar

            if parse_preset_avatar(cur):
                return False
        except Exception:
            pass
        return True
    return _is_legacy_non_image_avatar(cur)


def _backfill_missing_agent_avatars() -> None:
    """Set/upgrade avatar for existing agents that still lack a real cutout pointer.

    - Bundled cutouts / ``_BUILTIN_AGENT_AVATARS`` → ``image``
    - Known custom role codes → emoji defaults
    - Also upgrades legacy ``emoji:…`` / ``preset:…`` on builtins so upgrades stop
      showing name-initial / emoji placeholders after packaged cutouts ship.
    """
    from evoflow.config.agent_avatars import bundled_avatar_path
    from evoflow.persistence import config_repositories as cfg_repo

    defaults = dict(_BUILTIN_AGENT_AVATARS)
    defaults.update(_CUSTOM_AGENT_AVATAR_DEFAULTS)
    for code in cfg_repo.list_agent_codes():
        try:
            existing = load_agent_config(code)
        except Exception:
            continue
        if existing is None:
            continue
        avatar = defaults.get(code)
        if not avatar and bundled_avatar_path(code) is not None:
            avatar = "image"
        if not avatar:
            continue
        if code == "xiaomi":
            if not _should_upgrade_xiaomi_avatar(existing.avatar, avatar):
                continue
        elif not _should_upgrade_builtin_avatar(existing.avatar, avatar):
            continue
        full = existing.model_dump(exclude_none=True)
        full["avatar"] = avatar
        save_agent_config(code, full)
        logger.info(
            "backfilled agent avatar code=%s avatar=%s (was %r)",
            code,
            avatar,
            existing.avatar,
        )
        if code == "xiaomi" and str(avatar).startswith("preset:"):
            try:
                from evoflow.config.agent_avatars import delete_avatar_file

                # Drop aliased male lead cutout so has_avatar_file no longer points at it.
                delete_avatar_file("xiaomi")
            except Exception:
                logger.debug("xiaomi stale cutout cleanup skipped", exc_info=True)


def save_agent_soul(agent_code: str, soul_md: str) -> None:
    """Persist agent SOUL markdown — file SoT under assets, SQLite cache for transition."""
    from evoflow.persistence import config_repositories as cfg_repo

    code = str(agent_code or "").strip().lower()
    text = soul_md or ""
    _write_agent_soul_file(code, text)
    cfg_repo.save_agent_soul(code, text)
    try:
        from evoflow.person_kernel import ensure_agent_identity

        ensure_agent_identity(code, text)
    except Exception:
        logger.debug("save_agent_soul: identity ensure skipped", exc_info=True)
    try:
        from evoflow.assets.paths import EntityRef
        from evoflow.assets.soul_summary import schedule_soul_summary_consolidate

        schedule_soul_summary_consolidate(EntityRef("agent", code))
    except Exception:
        logger.debug("save_agent_soul: soul-summary schedule skipped", exc_info=True)


def _agent_soul_file(agent_code: str) -> "Path":
    from pathlib import Path

    from evoflow.assets.paths import EntityRef, profile_path

    return profile_path(EntityRef("agent", agent_code), "SOUL.md")


def _write_agent_soul_file(agent_code: str, soul_md: str) -> None:
    from evoflow.assets.hub import ensure_entity_tree
    from evoflow.assets.paths import EntityRef

    code = str(agent_code or "").strip().lower()
    if not code:
        return
    ensure_entity_tree(EntityRef("agent", code))
    path = _agent_soul_file(code)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(soul_md or "", encoding="utf-8")
    tmp.replace(path)


def load_agent_soul(agent_name: str | None) -> str | None:
    """Read agent SOUL — file first, then SQLite, then bundled default."""
    if not agent_name:
        return None
    code = str(agent_name).strip().lower()

    try:
        from evoflow.assets.hub import ensure_entity_tree
        from evoflow.assets.paths import EntityRef

        ensure_entity_tree(EntityRef("agent", code))
        path = _agent_soul_file(code)
        if path.is_file():
            text = path.read_text(encoding="utf-8").strip()
            if text:
                return text
    except OSError:
        logger.debug("load_agent_soul: file read failed for %s", code, exc_info=True)

    from evoflow.persistence import config_repositories as cfg_repo

    if not cfg_repo.agent_exists(code):
        try:
            builtins = _builtin_subagents_registry()
            if code in {str(k).strip().lower() for k in builtins}:
                ensure_builtin_agents_materialized()
        except Exception:
            logger.debug("load_agent_soul: builtin materialize skipped", exc_info=True)

    db_soul = cfg_repo.get_agent_soul(code)
    if db_soul and str(db_soul).strip():
        _write_agent_soul_file(code, str(db_soul))
        return str(db_soul).strip()

    bundled = load_bundled_soul(code)
    if bundled and str(bundled).strip():
        _write_agent_soul_file(code, str(bundled))
        return str(bundled).strip()

    return None


def save_agent_identity(agent_code: str, identity_md: str, *, reason: str = "") -> None:
    """Persist Person Kernel L0 identity (admin/hire only)."""
    from evoflow.persistence import config_repositories as cfg_repo

    cfg_repo.save_agent_identity(
        agent_code, identity_md, source="admin", approved_by="admin", reason=reason
    )


def load_agent_identity(agent_name: str | None) -> str | None:
    """Read L0 identity; may backfill from soul Identity section."""
    if not agent_name:
        return None
    try:
        from evoflow.person_kernel import ensure_agent_identity

        text = ensure_agent_identity(agent_name)
        return text or None
    except Exception:
        from evoflow.persistence import config_repositories as cfg_repo

        return cfg_repo.get_agent_identity(agent_name)


def _list_agents_filtered(
    *,
    types: set[str] | None = None,
    exclude_main: bool = False,
) -> list[AgentConfig]:
    from evoflow.persistence import config_repositories as cfg_repo

    agents: list[AgentConfig] = []
    codes = cfg_repo.list_agent_codes()
    for code in codes:
        if exclude_main and code.lower() == "main":
            continue
        try:
            agent_cfg = load_agent_config(code)
            if types is not None and agent_cfg.agent_type not in types:
                continue
            agents.append(agent_cfg)
        except Exception as e:
            logger.warning("Skipping agent %r: %s", code, e)
    return agents


def list_custom_agents() -> list[AgentConfig]:
    """List custom + subagent agents from SQLite (excludes ACP and main)."""
    return _list_agents_filtered(types={"custom", "subagent"}, exclude_main=True)


def list_subagents() -> list[AgentConfig]:
    return _list_agents_filtered(types={"subagent"})


def list_acp_agents() -> list[AgentConfig]:
    return _list_agents_filtered(types={"acp"})


def list_all_agents() -> list[AgentConfig]:
    return _list_agents_filtered()
