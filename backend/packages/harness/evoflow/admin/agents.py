"""Agent admin (agents_config + SQLite, no tools coupling)."""

from __future__ import annotations

import logging
import re
import shutil
from typing import Any

from evoflow.admin.errors import ConflictError, NotFoundError, ValidationError
from evoflow.config.agent_tags import normalize_tags
from evoflow.config.agents_config import (
    AGENT_NAME_PATTERN,
    AgentConfig,
    list_custom_agents,
    load_agent_config,
    load_agent_soul,
    save_agent_config,
    save_agent_soul,
)
from evoflow.config.avatar_presets import is_valid_preset_avatar, pick_random_preset_avatar
from evoflow.config.paths import get_paths
from evoflow.persistence import config_repositories as cfg_repo

logger = logging.getLogger(__name__)

_DEFAULT_SKILLS_FOR_NEW_CUSTOM_AGENT: tuple[str, ...] = (
    "evoflow-intro",
    "evoflow-admin",
    "create-plan",
    "deep-research",
    "article-writer",
    "aihot",
)

_ALLOWED_AGENT_TYPES = frozenset({"custom", "subagent", "acp"})
_AGENT_CODE_MAX_LEN = 64
_DISPLAY_TEXT_MAX_LEN = 200
# Allow common whitespace (\n \r \t) in prose fields; reject other C0 controls / DEL.
_CTRL_DANGEROUS_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_HTML_META_RE = re.compile(r"[<>]")


def _validate_agent_name(name: str, *, enforce_max_len: bool = True) -> None:
    if not AGENT_NAME_PATTERN.match(name):
        raise ValidationError(
            f"Invalid agent name '{name}'. Must match ^[A-Za-z0-9-]+$ (letters, digits, and hyphens only)."
        )
    if enforce_max_len and len(name) > _AGENT_CODE_MAX_LEN:
        raise ValidationError(f"agent_code is too long (max {_AGENT_CODE_MAX_LEN} characters)")


def _normalize_agent_name(name: str) -> str:
    return name.lower()


def _require_agent_code(data: dict[str, Any]) -> str:
    """Resolve agent_code/name with distinct errors for missing vs blank."""
    if "agent_code" not in data and "name" not in data:
        raise ValidationError("agent_code is required")
    raw = data.get("agent_code")
    if raw is None:
        raw = data.get("name")
    if raw is None:
        raise ValidationError("agent_code is required")
    text = str(raw)
    if not text.strip():
        if text == "":
            raise ValidationError("agent_code cannot be empty")
        raise ValidationError("agent_code cannot be blank")
    return text.strip()


def _sanitize_display_text(
    value: Any,
    *,
    field: str,
    allow_empty: bool = True,
    max_len: int | None = None,
    allow_newlines: bool = True,
) -> str | None:
    """Reject HTML / dangerous control characters in UI-facing strings.

    When ``allow_newlines`` is True (default for description), ``\\n``/``\\r``/``\\t``
    are kept. Short labels like ``agent_name`` should pass ``allow_newlines=False``.
    """
    if value is None:
        return None
    s = str(value)
    if allow_newlines:
        if _CTRL_DANGEROUS_RE.search(s):
            raise ValidationError(f"{field} must not contain control characters")
    else:
        if re.search(r"[\x00-\x1f\x7f]", s):
            raise ValidationError(f"{field} must not contain control characters")
    if _HTML_META_RE.search(s):
        raise ValidationError(f"{field} must not contain HTML tags")
    s = s.strip()
    if not s:
        if allow_empty:
            return ""
        raise ValidationError(f"{field} cannot be empty")
    limit = _DISPLAY_TEXT_MAX_LEN if max_len is None else max_len
    if len(s) > limit:
        raise ValidationError(f"{field} is too long (max {limit} characters)")
    return s


def _validate_avatar_value(avatar: Any) -> str:
    raw = str(avatar or "").strip()
    if not raw:
        raise ValidationError("avatar cannot be empty")
    lower = raw.lower()
    if lower.startswith("preset:"):
        if not is_valid_preset_avatar(raw):
            raise ValidationError(f"unknown avatar preset: {raw}")
        return f"preset:{raw.split(':', 1)[1].strip().lower()}"
    # emoji: / image / raw emoji — accept as free-form UI refs
    return raw


def _validate_agent_type(raw: Any) -> str:
    at = str(raw or "custom").strip().lower() or "custom"
    if at not in _ALLOWED_AGENT_TYPES:
        raise ValidationError(
            f"Invalid agent_type: {raw!r} (expected one of {sorted(_ALLOWED_AGENT_TYPES)})"
        )
    return at


def _dedupe_list_inplace(values: list[str] | None) -> list[str] | None:
    if values is None:
        return None
    out: list[str] = []
    seen: set[str] = set()
    for item in values:
        name = str(item).strip()
        if not name or name in seen:
            continue
        seen.add(name)
        out.append(name)
    return out


def _dedupe_str_list(values: Any, *, field: str) -> list[str]:
    if values is None:
        return []
    if not isinstance(values, list):
        raise ValidationError(f"{field} must be a list of strings")
    out: list[str] = []
    seen: set[str] = set()
    for item in values:
        name = str(item).strip()
        if not name or name in seen:
            continue
        seen.add(name)
        out.append(name)
    return out


def _validate_model_name(model: Any) -> str | None:
    if model is None:
        return None
    name = str(model).strip()
    if not name:
        return None
    try:
        from evoflow.config import get_app_config

        cfg = get_app_config()
    except Exception as exc:  # noqa: BLE001
        raise ValidationError(f"unable to validate model '{name}': {exc}") from exc
    if cfg.get_model_config(name) is None:
        raise ValidationError(f"unknown model: {name}")
    return name


def _validate_mcp_servers_list(servers: Any) -> list[str]:
    names = _dedupe_str_list(servers, field="mcp_servers")
    if not names:
        return []
    from evoflow.config.extensions_config import get_extensions_config

    known = set(get_extensions_config().mcp_servers.keys())
    unknown = [n for n in names if n not in known]
    if unknown:
        raise ValidationError(f"unknown mcp_server(s): {', '.join(unknown)}")
    return names


def _validate_tools_list(tools: Any) -> list[str]:
    names = _dedupe_str_list(tools, field="tools")
    if not names:
        return []
    try:
        from evoflow.config.agent_resource_validation import partition_tool_names

        known, unknown = partition_tool_names(names)
    except Exception as exc:  # noqa: BLE001
        # Catalog unavailable — still persist de-duplicated names rather than crash.
        logger.warning("unable to validate tools against catalog: %s", exc)
        return names
    if unknown:
        raise ValidationError(f"unknown tool(s): {', '.join(unknown)}")
    return known

def _agent_tags(agent_cfg: AgentConfig | None) -> list[str]:
    """Return the agent's tag labels (empty list when unavailable)."""
    if agent_cfg is None:
        return []
    return normalize_tags(getattr(agent_cfg, "tags", []) or [])


def _default_skills_for_new_custom_agent() -> list[str]:
    try:
        from evoflow.skills import load_skills

        enabled_names = {s.name for s in load_skills(enabled_only=True)}
    except Exception:
        return []
    return [name for name in _DEFAULT_SKILLS_FOR_NEW_CUSTOM_AGENT if name in enabled_names]


def _validate_skills_list(skills: Any) -> list[str]:
    """Reject unknown skill names; de-duplicate while preserving order."""
    names = _dedupe_str_list(skills, field="skills")
    if not names:
        return []
    try:
        from evoflow.skills import load_skills

        known = {s.name for s in load_skills(enabled_only=False)}
    except Exception as exc:  # noqa: BLE001
        raise ValidationError(f"unable to validate skills: {exc}") from exc
    unknown = [n for n in names if n not in known]
    if unknown:
        raise ValidationError(f"unknown skill(s): {', '.join(unknown)}")
    return names

def _agent_row(agent_cfg: AgentConfig, *, include_soul: bool = False) -> dict[str, Any]:
    code = agent_cfg.agent_code
    row: dict[str, Any] = {
        "agent_code": code,
        "agent_name": agent_cfg.agent_name,
        "description": agent_cfg.description or "",
        "model": agent_cfg.model,
        "tool_groups": _dedupe_list_inplace(list(agent_cfg.tool_groups) if agent_cfg.tool_groups is not None else None),
        "tools": _dedupe_list_inplace(list(agent_cfg.tools) if agent_cfg.tools is not None else None),
        "mcp_servers": _dedupe_list_inplace(
            list(agent_cfg.mcp_servers) if agent_cfg.mcp_servers is not None else None
        ),
        "skills": _dedupe_list_inplace(list(agent_cfg.skills) if agent_cfg.skills is not None else None),
        "system_prompt": agent_cfg.system_prompt,
        "agent_type": agent_cfg.agent_type,
        "tags": _agent_tags(agent_cfg),
        "avatar": agent_cfg.avatar,
        "avatar_meta": agent_cfg.avatar_meta,
    }
    if include_soul:
        row["soul"] = load_agent_soul(code) or ""
        try:
            from evoflow.config.agents_config import load_agent_identity

            row["identity"] = load_agent_identity(code) or ""
        except Exception:
            row["identity"] = ""
    return row


def _main_agent_row(*, include_soul: bool = False) -> dict[str, Any]:
    try:
        agent_cfg = load_agent_config("main")
    except (FileNotFoundError, ValueError):
        agent_cfg = None
    if agent_cfg is None:
        return {
            "agent_code": "main",
            "agent_name": "EvoFlow",
            "description": "",
            "model": None,
            "tool_groups": None,
            "tools": None,
            "mcp_servers": None,
            "skills": None,
            "system_prompt": None,
            "agent_type": "custom",
            "tags": [],
            **({"soul": load_agent_soul("main") or ""} if include_soul else {}),
        }
    row = _agent_row(agent_cfg, include_soul=include_soul)
    row["agent_code"] = "main"
    if not row.get("agent_name"):
        row["agent_name"] = "EvoFlow"
    # ``main`` is the lead session agent; it carries no tags.
    row["tags"] = []
    return row


# Panel / admin list omit these (get_agent by code still works).
# file-worker: delisted from BUILTIN_SUBAGENTS; hide any leftover SQLite rows.
_UI_HIDDEN_AGENT_CODES = frozenset({"claude-code", "file-worker"})


def list_agents(
    *,
    tag: str | None = None,
    agent_name: str | None = None,
    limit: int | None = None,
    offset: int | None = None,
    include_soul: bool = False,
) -> dict[str, Any]:
    """List all agents (main + custom/subagent).

    Args:
        tag: Optional tag label filter. Matching is **substring** (case-sensitive
            on the stored label). Unknown tags yield an empty list.
        agent_name: Optional display-name substring filter.
        limit: Optional max rows (``>= 0``). ``None`` = no cap.
        offset: Optional skip count (``>= 0``).
        include_soul: When True, include ``soul`` / ``identity`` (heavier).
    """
    agents = [_main_agent_row(include_soul=include_soul)]
    agents.extend(_agent_row(a, include_soul=include_soul) for a in list_custom_agents())
    agents = [
        a
        for a in agents
        if str(a.get("agent_code") or "").strip()
        and str(a.get("agent_code") or "").strip().lower() not in _UI_HIDDEN_AGENT_CODES
    ]
    if tag is not None:
        wanted = str(tag).strip()
        if wanted:
            agents = [
                a
                for a in agents
                if any(wanted in (t or "") for t in (a.get("tags") or []))
            ]
        # empty tag string → no filter
    if agent_name is not None:
        wanted_name = str(agent_name).strip()
        if wanted_name:
            agents = [
                a
                for a in agents
                if wanted_name in str(a.get("agent_name") or "")
            ]
    off = 0
    if offset is not None:
        try:
            off = int(offset)
        except (TypeError, ValueError) as e:
            raise ValidationError("offset must be an integer >= 0") from e
        if off < 0:
            raise ValidationError("offset must be >= 0")
    if off:
        agents = agents[off:]
    if limit is not None:
        try:
            lim = int(limit)
        except (TypeError, ValueError) as e:
            raise ValidationError("limit must be an integer >= 0") from e
        if lim < 0:
            raise ValidationError("limit must be >= 0")
        agents = agents[:lim]
    return {"agents": agents, "count": len(agents)}

def get_agent(name: str) -> dict[str, Any]:
    if name.lower() == "main":
        return _main_agent_row(include_soul=True)
    _validate_agent_name(name, enforce_max_len=False)
    normalized = _normalize_agent_name(name)
    try:
        agent_cfg = load_agent_config(normalized)
    except FileNotFoundError as e:
        raise NotFoundError(f"Agent '{normalized}' not found") from e
    return _agent_row(agent_cfg, include_soul=True)


def check_agent_name(name: str) -> dict[str, Any]:
    _validate_agent_name(name)
    normalized = _normalize_agent_name(name)
    return {"available": not cfg_repo.agent_exists(normalized), "name": normalized}


def _assert_agent_name_unique(agent_name: str, *, exclude_code: str | None = None) -> None:
    """Reject duplicate display names (case-insensitive) across agents."""
    wanted = str(agent_name or "").strip().casefold()
    if not wanted:
        return
    exclude = str(exclude_code or "").strip().lower()
    for row in list_agents().get("agents") or []:
        code = str(row.get("agent_code") or "").strip().lower()
        if exclude and code == exclude:
            continue
        other = str(row.get("agent_name") or "").strip().casefold()
        if other and other == wanted:
            raise ConflictError(
                f"agent_name '{agent_name}' is already used by agent '{row.get('agent_code')}'"
            )


def create_agent(data: dict[str, Any]) -> dict[str, Any]:
    """Create a custom agent.

    When ``skills`` is omitted, a curated default skill set is injected (intersection
    with currently enabled skills). Pass ``skills: []`` for an empty allowlist.
    """
    if not isinstance(data, dict):
        raise ValidationError("Agent payload must be a JSON object")
    raw_code = _require_agent_code(data)
    _validate_agent_name(raw_code)
    normalized = _normalize_agent_name(raw_code)
    if cfg_repo.agent_exists(normalized):
        raise ConflictError(f"Agent '{normalized}' already exists")

    agent_type = _validate_agent_type(data.get("agent_type") or "custom")
    config_data: dict[str, Any] = {"agent_code": normalized, "agent_type": agent_type}

    # agent_name: reject empty string (incl. JSON duplicate-key last-write-wins "")
    if "agent_name" in data:
        if data["agent_name"] is None:
            pass
        else:
            config_data["agent_name"] = _sanitize_display_text(
                data["agent_name"], field="agent_name", allow_empty=False, allow_newlines=False
            )
            _assert_agent_name_unique(str(config_data["agent_name"]), exclude_code=normalized)
    if data.get("description") is not None:
        config_data["description"] = _sanitize_display_text(
            data["description"], field="description", allow_empty=True, max_len=4000
        ) or ""
    if data.get("system_prompt") is not None:
        sp = data["system_prompt"]
        if sp is None:
            pass
        else:
            text = str(sp)
            if _CTRL_DANGEROUS_RE.search(text):
                raise ValidationError("system_prompt must not contain control characters")
            config_data["system_prompt"] = text
    if data.get("model") is not None:
        config_data["model"] = _validate_model_name(data["model"])
    if data.get("tool_groups") is not None:
        config_data["tool_groups"] = _dedupe_str_list(data["tool_groups"], field="tool_groups")
    if data.get("tools") is not None:
        config_data["tools"] = _validate_tools_list(data["tools"])
    if data.get("mcp_servers") is not None:
        config_data["mcp_servers"] = _validate_mcp_servers_list(data["mcp_servers"])
    if data.get("skills") is not None:
        config_data["skills"] = _validate_skills_list(data["skills"])
    else:
        config_data["skills"] = _default_skills_for_new_custom_agent()

    if data.get("tags") is not None:
        config_data["tags"] = normalize_tags(data.get("tags"))

    if data.get("avatar") is not None and str(data.get("avatar") or "").strip():
        config_data["avatar"] = _validate_avatar_value(data["avatar"])
    else:
        random_avatar = pick_random_preset_avatar()
        if random_avatar:
            config_data["avatar"] = random_avatar

    save_agent_config(normalized, config_data)
    save_agent_soul(normalized, str(data.get("soul") or ""))
    if data.get("identity") is not None:
        from evoflow.config.agents_config import save_agent_identity

        save_agent_identity(normalized, str(data.get("identity") or ""), reason="admin create")
    return _agent_row(load_agent_config(normalized), include_soul=True)


def update_agent(name: str, data: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ValidationError("Agent payload must be a JSON object")
    if name.lower() == "main":
        return _update_main_agent(data)
    _validate_agent_name(name, enforce_max_len=False)
    normalized = _normalize_agent_name(name)
    if not cfg_repo.agent_exists(normalized):
        raise NotFoundError(f"Agent '{normalized}' not found")

    if "agent_code" in data and data["agent_code"] is not None:
        new_code = str(data["agent_code"]).strip().lower()
        if new_code and new_code != normalized:
            raise ValidationError("agent_code is immutable and cannot be changed")
    if "name" in data and data["name"] is not None:
        alt = str(data["name"]).strip().lower()
        if alt and alt != normalized and alt != "main":
            raise ValidationError("agent_code is immutable and cannot be changed")

    try:
        existing = load_agent_config(normalized)
    except FileNotFoundError as e:
        raise NotFoundError(f"Agent '{normalized}' not found") from e

    config_data = existing.model_dump(mode="python", exclude={"name"})

    if "agent_type" in data and data["agent_type"] is not None:
        config_data["agent_type"] = _validate_agent_type(data["agent_type"])

    if "agent_name" in data:
        if data["agent_name"] is None:
            pass
        else:
            config_data["agent_name"] = _sanitize_display_text(
                data["agent_name"], field="agent_name", allow_empty=False, allow_newlines=False
            )
            _assert_agent_name_unique(str(config_data["agent_name"]), exclude_code=normalized)
    if "description" in data:
        if data["description"] is None:
            pass
        else:
            config_data["description"] = _sanitize_display_text(
                data["description"], field="description", allow_empty=True, max_len=4000
            ) or ""
    if "model" in data:
        if data["model"] is None:
            config_data["model"] = None
        else:
            config_data["model"] = _validate_model_name(data["model"])
    if "tool_groups" in data and data["tool_groups"] is not None:
        config_data["tool_groups"] = _dedupe_str_list(data["tool_groups"], field="tool_groups")
    if "tools" in data and data["tools"] is not None:
        config_data["tools"] = _validate_tools_list(data["tools"])
    if "mcp_servers" in data and data["mcp_servers"] is not None:
        config_data["mcp_servers"] = _validate_mcp_servers_list(data["mcp_servers"])
    if "system_prompt" in data and data["system_prompt"] is not None:
        text = str(data["system_prompt"])
        if _CTRL_DANGEROUS_RE.search(text):
            raise ValidationError("system_prompt must not contain control characters")
        config_data["system_prompt"] = text
    if "skills" in data:
        config_data["skills"] = _validate_skills_list(data["skills"])
    if "tags" in data:
        raw_tags = data["tags"]
        if raw_tags is None:
            config_data["tags"] = []
        else:
            config_data["tags"] = normalize_tags(raw_tags)
    if "avatar" in data and data["avatar"] is not None:
        if str(data["avatar"] or "").strip():
            config_data["avatar"] = _validate_avatar_value(data["avatar"])
        else:
            config_data["avatar"] = None

    save_agent_config(normalized, config_data)
    if "soul" in data and data["soul"] is not None:
        save_agent_soul(normalized, str(data["soul"]))
    if "identity" in data and data["identity"] is not None:
        from evoflow.config.agents_config import save_agent_identity

        save_agent_identity(normalized, str(data["identity"]), reason="admin update")

    # Push shared capability fields to linked employee (unless employee opted out).
    try:
        from evoflow.admin import employees as emp

        emp.sync_employee_from_agent(normalized)
    except Exception:
        logger.exception("failed to sync employee from agent=%s", normalized)

    # Refresh tool snapshots for existing sessions bound to this agent so an
    # in-flight conversation picks up newly added tools immediately (the
    # snapshot is otherwise only rebuilt on session/scenario switch).
    try:
        _refresh_sessions_tool_state_for_agent(normalized)
    except Exception:
        logger.exception("failed to refresh session tool snapshots for agent=%s", normalized)

    return _agent_row(load_agent_config(normalized), include_soul=True)


def _refresh_sessions_tool_state_for_agent(agent_code: str) -> int:
    """Rebuild ``active_tools_json`` / ``pending_tools_json`` for sessions bound to ``agent_code``.

    Sessions are located two ways: the flat ``agent_id`` column, or the legacy
    ``agent:<code>:…`` session-key prefix. Returns the number of sessions refreshed.
    """
    from evoflow.persistence.db import get_db
    from evoflow.session_tool_binding.service import repair_session_tool_state

    db = get_db()
    rows = db.execute(
        "SELECT session_key FROM evoflow_chat_sessions "
        "WHERE is_deleted = 0 AND (agent_id = ? OR session_key LIKE ?)",
        (agent_code, f"agent:{agent_code}:%"),
    ).fetchall()
    refreshed = 0
    for (sk,) in rows:
        try:
            repair_session_tool_state(sk)
            refreshed += 1
        except Exception:
            logger.debug("session tool refresh skipped sk=%s", sk, exc_info=True)
    if refreshed:
        logger.info(
            "refreshed tool snapshots for %d session(s) bound to agent=%s",
            refreshed,
            agent_code,
        )
    return refreshed



def _update_main_agent(data: dict[str, Any]) -> dict[str, Any]:
    existing: dict[str, Any] = {}
    try:
        cfg = load_agent_config("main")
        if cfg is not None:
            existing = cfg.model_dump(mode="python", exclude={"name"})
    except FileNotFoundError:
        existing = {"agent_code": "main", "agent_type": "custom"}

    if "agent_name" in data and data["agent_name"] is not None:
        existing["agent_name"] = _sanitize_display_text(
            data["agent_name"], field="agent_name", allow_empty=False, allow_newlines=False
        )
    if "description" in data and data["description"] is not None:
        existing["description"] = _sanitize_display_text(
            data["description"], field="description", allow_empty=True
        ) or ""
    if "model" in data:
        if data["model"] is None and "model" in existing:
            del existing["model"]
        elif data["model"] is not None:
            existing["model"] = _validate_model_name(data["model"])
    for key in ("tool_groups", "tools", "mcp_servers", "system_prompt"):
        if key not in data:
            continue
        val = data[key]
        if val is None and key in existing:
            del existing[key]
        elif val is not None:
            if key == "tool_groups":
                existing[key] = _dedupe_str_list(val, field="tool_groups")
            elif key == "tools":
                existing[key] = _validate_tools_list(val)
            elif key == "mcp_servers":
                existing[key] = _validate_mcp_servers_list(val)
            else:
                existing[key] = val
    if "skills" in data:
        existing["skills"] = _validate_skills_list(data["skills"])

    existing["agent_code"] = "main"
    # ``main`` is the lead session agent; keep its tag list empty.
    existing["tags"] = []
    save_agent_config("main", existing)
    if "soul" in data and data["soul"] is not None:
        save_agent_soul("main", str(data["soul"]))
    return _main_agent_row(include_soul=True)


def delete_agent(
    name: str,
    *,
    confirm_cascade: bool = False,
    keep_employee: bool = False,
) -> dict[str, Any]:
    _validate_agent_name(name, enforce_max_len=False)
    normalized = _normalize_agent_name(name)
    if not cfg_repo.agent_exists(normalized):
        raise NotFoundError(f"Agent '{normalized}' not found")
    if confirm_cascade and keep_employee:
        raise ValidationError("confirm_cascade and keep_employee are mutually exclusive")

    linked_employee = False
    try:
        from evoflow.proactive.repositories import ProactiveRepository

        linked_employee = ProactiveRepository.get_role(normalized) is not None
    except Exception:
        linked_employee = False

    if linked_employee and not confirm_cascade and not keep_employee:
        raise ValidationError(
            f"Agent '{normalized}' has a linked employee. "
            "Pass confirm_cascade=true to delete both, or keep_employee=true "
            "to delete the agent only."
        )

    cfg_repo.delete_agent(normalized)
    try:
        from evoflow.config.agents_config import invalidate_agent_config_cache

        invalidate_agent_config_cache(normalized)
    except Exception:
        logger.debug("invalidate_agent_config_cache failed for %s", normalized, exc_info=True)
    legacy_dir = get_paths().agent_dir(normalized)
    if legacy_dir.exists():
        shutil.rmtree(legacy_dir)

    employee_removed = False
    if linked_employee and confirm_cascade:
        try:
            from evoflow.proactive.repositories import ProactiveRepository

            if ProactiveRepository.get_role(normalized):
                employee_removed = bool(ProactiveRepository.delete_role(normalized))
        except Exception:
            logger.exception("failed to cascade-delete employee role for agent=%s", normalized)

    out: dict[str, Any] = {"message": f"Agent '{normalized}' deleted successfully"}
    if employee_removed:
        out["employee_removed"] = True
    elif linked_employee and keep_employee:
        out["employee_kept"] = True
    return out
