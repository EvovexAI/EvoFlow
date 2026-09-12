"""Seed ``evoflow.db`` config tables from ``config.yaml`` / ``extensions_config.json`` when empty."""

from __future__ import annotations

import json
import logging
from importlib import import_module
from pathlib import Path
from typing import Any

from evoflow.config.models_yaml import _normalize_models_input
from evoflow.persistence import config_repositories as cfg_repo
from evoflow.persistence.runtime_settings import (
    overlay_runtime_settings_from_db,
    seed_runtime_settings_from_yaml,
)

logger = logging.getLogger(__name__)


def _coerce_models(raw: Any) -> list[dict[str, Any]]:
    """Flat model dicts from legacy list or ``models.providers`` nested YAML."""
    return _normalize_models_input(raw)


def _coerce_tools(raw: Any) -> list[dict[str, Any]]:
    if isinstance(raw, list):
        return [t for t in raw if isinstance(t, dict)]
    return []


def _coerce_tool_groups(raw: Any) -> list[dict[str, Any]]:
    if isinstance(raw, list):
        return [g for g in raw if isinstance(g, dict)]
    return []


def _is_community_tool_doc(tool: dict[str, Any]) -> bool:
    use = str(tool.get("use") or "").strip()
    return use.startswith("evoflow.community.")


def _community_tools_from_yaml_dict(config_data: dict[str, Any]) -> list[dict[str, Any]]:
    return [t for t in _coerce_tools(config_data.get("tools")) if _is_community_tool_doc(t)]


def _merge_tool_docs_by_name(base: list[dict[str, Any]], overlay: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Merge tool rows by ``name``; ``overlay`` wins on key collision."""
    by_name: dict[str, dict[str, Any]] = {}
    for t in base:
        n = str(t.get("name") or "").strip()
        if n:
            by_name[n] = dict(t)
    for t in overlay:
        n = str(t.get("name") or "").strip()
        if n:
            by_name[n] = {**by_name.get(n, {}), **t}
    return sorted(by_name.values(), key=lambda x: str(x.get("name") or ""))


def _community_tools_from_db() -> list[dict[str, Any]]:
    """Community tool rows already stored in ``evoflow_tools``."""
    try:
        return [t for t in cfg_repo.list_tools() if _is_community_tool_doc(t)]
    except Exception as e:
        logger.debug("community tools from db skipped: %s", e)
        return []


def _load_extensions_json() -> dict[str, Any] | None:
    from evoflow.config.extensions_config import ExtensionsConfig

    path = ExtensionsConfig.resolve_config_path()
    if path is None or not Path(path).is_file():
        return None
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            ExtensionsConfig.resolve_env_variables(data)
            return data
    except Exception:
        logger.warning("bootstrap: failed to read extensions json from %s", path, exc_info=True)
    return None


def seed_config_from_app_yaml(config_data: dict[str, Any]) -> None:
    """Populate config tables from parsed ``config.yaml`` (first run only).

    Chat models are **not** read from YAML; use Settings → Models (``evoflow_models`` table).
    """
    if cfg_repo.config_tables_seeded():
        return

    if config_data.get("models") or config_data.get("primary_model"):
        logger.warning(
            "config.yaml defines models/primary_model but they are ignored. "
            "Add chat models in Settings → Models (SQLite evoflow_models)."
        )

    tools = _coerce_tools(config_data.get("tools"))
    groups = _coerce_tool_groups(config_data.get("tool_groups"))
    if tools:
        cfg_repo.replace_tools(tools)
    if groups:
        cfg_repo.replace_tool_groups(groups)

    channels = config_data.get("channels")
    if isinstance(channels, dict) and channels:
        cfg_repo.replace_channel_configs(channels)

    ext_data = _load_extensions_json() or {}
    mcp = ext_data.get("mcpServers") or ext_data.get("mcp_servers") or {}
    if isinstance(mcp, dict) and mcp:
        cfg_repo.replace_mcp_servers(mcp)
    skills = ext_data.get("skills") or {}
    if isinstance(skills, dict) and skills:
        cfg_repo.replace_skill_enablement(skills)

    seed_runtime_settings_from_yaml(config_data)

    logger.info(
        "Seeded evoflow.db config tables (tools=%d groups=%d channels=%d)",
        len(tools),
        len(groups),
        len(channels) if isinstance(channels, dict) else 0,
    )


def sync_skills_from_filesystem() -> None:
    """Upsert installed skills (SKILL.md) into ``evoflow_skills``."""
    try:
        from evoflow.skills.loader import get_skills_root_path
        from evoflow.skills.parser import parse_skill_file
    except Exception:
        logger.debug("sync_skills_from_filesystem skipped", exc_info=True)
        return

    root = get_skills_root_path()
    if not root.is_dir():
        return

    for category in ("public", "custom"):
        cat_dir = root / category
        if not cat_dir.is_dir():
            continue
        for skill_file_path in cat_dir.rglob("SKILL.md"):
            try:
                skill = parse_skill_file(skill_file_path, category=category)
            except Exception:
                continue
            if skill is None:
                continue
            name = str(skill.name or skill_file_path.parent.name).strip()
            if not name:
                continue
            reg = cfg_repo.get_skill_registry(name) or {}
            enabled = reg.get("enabled", True)
            try:
                skill_md = skill_file_path.read_text(encoding="utf-8")
            except OSError:
                skill_md = reg.get("skill_md")
            rel = str(skill_file_path.parent.relative_to(root)).replace("\\", "/")
            cfg_repo.upsert_skill_registry(
                name,
                enabled=bool(enabled),
                skill_md=skill_md,
                source_path=rel,
                category=category,
                meta={"description": getattr(skill, "description", "") or ""},
            )


def _tool_use_path(tool_obj: Any) -> str:
    """Resolve ``module:variable`` path for :func:`evoflow.reflection.resolve_variable`."""
    impl = getattr(tool_obj, "func", None) or getattr(tool_obj, "coroutine", None)
    mod_name = str(getattr(impl, "__module__", "") or getattr(tool_obj, "__module__", "") or "").strip()
    if not mod_name:
        raise ValueError("tool object has no resolvable module")

    mod = import_module(mod_name)
    for attr_name, val in vars(mod).items():
        if val is tool_obj:
            return f"{mod_name}:{attr_name}"

    tool_name = str(getattr(tool_obj, "name", "") or "").strip()
    if tool_name:
        guess = f"{tool_name}_tool"
        if hasattr(mod, guess):
            return f"{mod_name}:{guess}"

    raise ValueError(f"could not resolve use path for tool {tool_name or tool_obj!r} in {mod_name}")


def _builtin_tools_need_resync(existing: list[dict[str, Any]], new: list[dict[str, Any]]) -> bool:
    existing_by_name = {str(t.get("name") or "").strip(): t for t in existing}
    new_by_name = {str(t["name"] or "").strip(): t for t in new}
    if set(existing_by_name) != set(new_by_name):
        return True
    for name, doc in new_by_name.items():
        old = existing_by_name.get(name, {})
        if str(old.get("use") or "").strip() != str(doc.get("use") or "").strip():
            return True
        if str(old.get("use") or "").strip().startswith("builtin:"):
            return True
        if str(old.get("tool_type") or "") != str(doc.get("tool_type") or ""):
            return True
        if str(old.get("tool_type_label") or "") != str(doc.get("tool_type_label") or ""):
            return True
    return False


def sync_builtin_tools_to_db() -> int:
    """Sync all registered builtin tools into ``evoflow_tools`` table.

    Discovers tools from:
      - ``BUILTIN_TOOLS`` (agent internal tools)
      - ``HOST_DIRECT_TOOLS`` (host-direct mode tools)
      - ``SUBAGENT_TOOLS``

    Only writes to DB when the tool set has changed (by name) to avoid
    unnecessary DELETE+INSERT on every call.

    Returns the number of tools synced.
    """
    all_tools: list[dict[str, Any]] = []

    try:
        from evoflow.tools.host_direct import HOST_DIRECT_TOOLS
        from evoflow.tools.tools import BUILTIN_TOOLS, REMOVED_LEGACY_TOOL_NAMES, SUBAGENT_TOOLS

        tool_objects = list(BUILTIN_TOOLS) + list(HOST_DIRECT_TOOLS) + list(SUBAGENT_TOOLS)
    except Exception as e:
        logger.warning("sync_builtin_tools_to_db: could not load tool modules: %s", e)
        return 0

    seen_names: set[str] = set()
    for tool_obj in tool_objects:
        try:
            name = str(getattr(tool_obj, "name", "") or "").strip()
            if not name or name in seen_names or name in REMOVED_LEGACY_TOOL_NAMES:
                continue
            seen_names.add(name)

            description = str(getattr(tool_obj, "description", "") or "")
            args = getattr(tool_obj, "args", None) or {}
            group = getattr(tool_obj, "group", None) or ""

            try:
                use_path = _tool_use_path(tool_obj)
            except ValueError as e:
                logger.debug("sync_builtin_tools_to_db: no use path for %s: %s", name, e)
                continue

            doc = {
                "name": name,
                "description": description,
                "group": group or "builtins",
                "use": use_path,
                "parameters": {
                    "type": "object",
                    "properties": {k: {"type": str(v.get("type", "string") if isinstance(v, dict) else "string"), "description": str(v.get("description", "") if isinstance(v, dict) else "")} for k, v in args.items()},
                },
            }
            from evoflow.tools.tool_catalog import enrich_tool_catalog_fields

            doc = enrich_tool_catalog_fields(doc)
            all_tools.append(doc)
        except Exception as e:
            logger.debug("sync_builtin_tools_to_db: skipping tool %s: %s", getattr(tool_obj, "name", "?"), e)

    if not all_tools:
        return 0

    community = _community_tools_from_db()
    if community:
        all_tools = _merge_tool_docs_by_name(all_tools, community)

    from evoflow.tools.tool_catalog import enrich_tool_catalog_fields

    all_tools = [enrich_tool_catalog_fields(t) for t in all_tools]

    # Check if DB already has the same set of tool names
    try:
        existing = cfg_repo.list_tools()
        if not _builtin_tools_need_resync(existing, all_tools):
            return 0  # already in sync
    except Exception:
        pass

    cfg_repo.replace_tools(all_tools)
    logger.info("Synced %d builtin tools to evoflow_tools", len(all_tools))
    return len(all_tools)


def _tool_groups_need_resync(existing: list[dict[str, Any]], new: list[dict[str, Any]]) -> bool:
    existing_by_name = {str(g.get("name") or "").strip(): g for g in existing if str(g.get("name") or "").strip()}
    new_by_name = {str(g["name"] or "").strip(): g for g in new}
    if set(existing_by_name) != set(new_by_name):
        return True
    for name, doc in new_by_name.items():
        old = existing_by_name.get(name, {})
        old_tools = tuple(sorted(str(t) for t in (old.get("tools") or [])))
        new_tools = tuple(sorted(str(t) for t in (doc.get("tools") or [])))
        if old_tools != new_tools:
            return True
        old_groups = tuple(sorted(str(t) for t in (old.get("tool_groups") or [])))
        new_groups = tuple(sorted(str(t) for t in (doc.get("tool_groups") or [])))
        if old_groups != new_groups:
            return True
        old_extra = tuple(sorted(str(t) for t in (old.get("extra_tools") or [])))
        new_extra = tuple(sorted(str(t) for t in (doc.get("extra_tools") or [])))
        if old_extra != new_extra:
            return True
        if str(old.get("description") or "") != str(doc.get("description") or ""):
            return True
    return False


def sync_tool_groups_to_db() -> int:
    """Sync scenario tool groups from ``intent_tool_profile.py`` into ``evoflow_tool_groups``.

    Makes scenario tool groups visible to the gateway/config system.
    Returns the number of groups synced.
    """
    try:
        from evoflow.agents.lead_agent.intent_tool_profile import NON_CORE_TOOL_GROUPS, TASK_SCENARIO_PROFILES
    except Exception as e:
        logger.warning("sync_tool_groups_to_db: could not load intent_tool_profile: %s", e)
        return 0

    all_groups: list[dict[str, Any]] = []
    seen: set[str] = set()

    # Sync NON_CORE_TOOL_GROUPS as tool groups
    for group_name, group_data in NON_CORE_TOOL_GROUPS.items():
        if group_name in seen:
            continue
        seen.add(group_name)
        tools = group_data.get("tools", ())
        zh_desc = group_data.get("zh_description", "")
        all_groups.append(
            {
                "name": group_name,
                "description": zh_desc,
                "tools": list(tools),
                "source": "scenario_profile",
            }
        )

    # Sync TASK_SCENARIO_PROFILES as scenario groups
    for scenario_key, profile in TASK_SCENARIO_PROFILES.items():
        group_name = f"scenario_{scenario_key}"
        if group_name in seen:
            continue
        seen.add(group_name)
        all_groups.append(
            {
                "name": group_name,
                "description": getattr(profile, "zh_description", ""),
                "tool_groups": list(getattr(profile, "tool_groups", ())),
                "extra_tools": list(getattr(profile, "extra_tool_names", ())),
                "source": "task_scenario",
            }
        )

    if not all_groups:
        return 0

    # Resync when group names or member tools / nested tool_groups change.
    try:
        existing = cfg_repo.list_tool_groups()
        if not _tool_groups_need_resync(existing, all_groups):
            return 0
    except Exception:
        pass

    cfg_repo.replace_tool_groups(all_groups)
    logger.info("Synced %d tool groups to evoflow_tool_groups", len(all_groups))
    return len(all_groups)


def sync_models_from_yaml_to_db(config_data: dict[str, Any]) -> int:
    """Legacy helper: import YAML models into ``evoflow_models`` (manual migration only).

    Normal startup does **not** call this; models are managed via Settings → Models / Gateway API.
    """
    flat = _coerce_models(config_data.get("models"))
    if not flat:
        return 0
    cfg_repo.replace_models(flat)
    if config_data.get("primary_model") is not None:
        cfg_repo.set_app_setting("primary_model", config_data.get("primary_model"))
    return len(flat)


def apply_config_from_db(config_data: dict[str, Any]) -> dict[str, Any]:
    """Overlay ``config_data`` with rows from SQLite.

    Chat models and ``primary_model`` come only from ``evoflow_models`` / ``evoflow_app_settings``.
    Any ``models`` / ``primary_model`` keys in ``config.yaml`` are ignored.
    """
    if config_data.pop("models", None):
        logger.warning(
            "Ignoring models from config.yaml. "
            "Chat models are stored in SQLite (evoflow_models); add them in Settings → Models."
        )
    if config_data.pop("primary_model", None):
        logger.debug("Ignoring primary_model from config.yaml (use evoflow_app_settings / UI).")

    models = cfg_repo.list_models()
    config_data["models"] = models if models else []
    yaml_community = _community_tools_from_yaml_dict(config_data)
    tools = cfg_repo.list_tools()
    if tools:
        config_data["tools"] = _merge_tool_docs_by_name(tools, yaml_community)
    elif yaml_community:
        config_data["tools"] = _merge_tool_docs_by_name(_coerce_tools(config_data.get("tools")), yaml_community)
    groups = cfg_repo.list_tool_groups()
    if groups:
        config_data["tool_groups"] = groups
    pm = cfg_repo.get_app_setting("primary_model")
    if pm is not None:
        config_data["primary_model"] = pm

    return overlay_runtime_settings_from_db(config_data)


def extensions_dict_from_db() -> dict[str, Any]:
    """Build extensions payload for :class:`ExtensionsConfig`."""
    mcp = cfg_repo.list_mcp_servers()
    skills_raw = cfg_repo.list_skill_registry()
    skills = {name: {"enabled": bool(doc.get("enabled", True))} for name, doc in skills_raw.items()}
    return {"mcp_servers": mcp, "mcpServers": mcp, "skills": skills}
