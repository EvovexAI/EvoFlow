"""SQLite repositories for agents, models, tools, skills, MCP, and channel config."""

from __future__ import annotations

import json
from typing import Any

from evoflow.models.credential_sanitize import sanitize_model_document
from evoflow.persistence.db import db_connection_lock, get_db, run_db_transaction, run_db_with_retry
from evoflow.persistence.row_mappers import (
    agent_doc_to_parts,
    agent_parts_to_doc,
    channel_doc_to_row,
    channel_row_to_doc,
    mcp_doc_to_row,
    mcp_row_to_doc,
    model_doc_to_row,
    model_row_to_doc,
    skill_doc_to_row,
    skill_row_to_doc,
    tool_doc_to_row,
    tool_group_doc_to_row,
    tool_group_row_to_doc,
    tool_row_to_doc,
)
from evoflow.timeutil import utc_now_iso_z


def _dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _loads(raw: str | None) -> Any:
    if not raw:
        return None
    return json.loads(raw)


def _row_dict(row: Any) -> dict[str, Any]:
    return {k: row[k] for k in row.keys()}


_MODEL_INSERT = """
    INSERT INTO evoflow_models (
        name, vendor, display_name, description, use, model,
        base_url, api_key, request_timeout, max_retries, max_tokens, temperature,
        use_responses_api, output_version,
        supports_thinking, supports_reasoning_effort, supports_vision,
        when_thinking_enabled_json, thinking_json,
        context_length, input_context_length, output_context_length,
        availability_status, unavailable_reason, unavailable_code, unavailable_at,
        extra_json, plan_type, plan_config, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
"""


def _insert_model(conn: Any, doc: dict[str, Any], now: str) -> None:
    r = model_doc_to_row(doc)
    if not r["name"]:
        return

    # Extract plan config
    plan_type = str(doc.get("plan_type", "none"))
    plan_config = doc.get("plan_config")
    if plan_config and isinstance(plan_config, dict):
        plan_config_json = json.dumps(plan_config, ensure_ascii=False)
    else:
        plan_config_json = None

    conn.execute(
        _MODEL_INSERT,
        (
            r["name"],
            r["vendor"],
            r["display_name"],
            r["description"],
            r["use"],
            r["model"],
            r["base_url"],
            r["api_key"],
            r["request_timeout"],
            r["max_retries"],
            r["max_tokens"],
            r["temperature"],
            r["use_responses_api"],
            r["output_version"],
            r["supports_thinking"],
            r["supports_reasoning_effort"],
            r["supports_vision"],
            r["when_thinking_enabled_json"],
            r["thinking_json"],
            r["context_length"],
            r["input_context_length"],
            r["output_context_length"],
            r.get("availability_status") or "available",
            r.get("unavailable_reason"),
            r.get("unavailable_code"),
            r.get("unavailable_at"),
            r["extra_json"],
            plan_type,
            plan_config_json,
            now,
        ),
    )


def config_tables_seeded() -> bool:
    """True when SQLite config tables were populated (tools, models, channels, MCP, or skills)."""
    conn = get_db()
    for table in (
        "evoflow_tools",
        "evoflow_models",
        "evoflow_channel_configs",
        "evoflow_mcp_servers",
        "evoflow_skills",
    ):
        row = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()
        if row and int(row[0]) > 0:
            return True
    return False


# --- Models / tools / tool groups ---


def replace_models(models: list[dict[str, Any]]) -> None:
    with db_connection_lock():
        conn = get_db()
        conn.execute("DELETE FROM evoflow_models")
        now = utc_now_iso_z()
        for m in models:
            _insert_model(conn, m, now)
        conn.commit()


def update_model_plan_config(model_name: str, plan_type: str, plan_config: dict | None) -> bool:
    """Update plan configuration for a model."""
    conn = get_db()
    now = utc_now_iso_z()

    if plan_config and isinstance(plan_config, dict):
        import json
        plan_config_json = json.dumps(plan_config, ensure_ascii=False)
    else:
        plan_config_json = None

    result = conn.execute(
        "UPDATE evoflow_models SET plan_type = ?, plan_config = ?, updated_at = ? WHERE name = ?",
        (plan_type, plan_config_json, now, model_name)
    )
    conn.commit()
    return result.rowcount > 0


def list_models() -> list[dict[str, Any]]:
    rows = (
        get_db()
        .execute(
            """
        SELECT name, vendor, display_name, description, use, model,
               base_url, api_key, request_timeout, max_retries, max_tokens, temperature,
               use_responses_api, output_version,
               supports_thinking, supports_reasoning_effort, supports_vision,
               when_thinking_enabled_json, thinking_json,
               context_length, input_context_length, output_context_length,
               availability_status, unavailable_reason, unavailable_code, unavailable_at,
               extra_json, plan_type, plan_config
        FROM evoflow_models ORDER BY name
        """
        )
        .fetchall()
    )
    return [model_row_to_doc(_row_dict(row)) for row in rows]


def update_model_api_key(model_name: str, api_key: str) -> bool:
    """Update only the API key for a model (useful when key is changed via URL param)."""
    conn = get_db()
    now = utc_now_iso_z()
    result = conn.execute(
        "UPDATE evoflow_models SET api_key = ?, updated_at = ? WHERE name = ?",
        (api_key, now, model_name)
    )
    conn.commit()
    return result.rowcount > 0


def replace_tools(tools: list[dict[str, Any]]) -> None:
    with db_connection_lock():
        conn = get_db()
        conn.execute("DELETE FROM evoflow_tools")
        now = utc_now_iso_z()
        for t in tools:
            r = tool_doc_to_row(t)
            if not r["name"]:
                continue
            conn.execute(
                "INSERT INTO evoflow_tools (name, group_name, use, extra_json, updated_at) VALUES (?,?,?,?,?)",
                (r["name"], r["group_name"], r["use"], r["extra_json"], now),
            )
        conn.commit()


def list_tools() -> list[dict[str, Any]]:
    rows = get_db().execute("SELECT name, group_name, use, extra_json FROM evoflow_tools ORDER BY name").fetchall()
    return [tool_row_to_doc(_row_dict(row)) for row in rows]


def replace_tool_groups(groups: list[dict[str, Any]]) -> None:
    with db_connection_lock():
        conn = get_db()
        conn.execute("DELETE FROM evoflow_tool_groups")
        now = utc_now_iso_z()
        for g in groups:
            r = tool_group_doc_to_row(g)
            if not r["name"]:
                continue
            conn.execute(
                "INSERT INTO evoflow_tool_groups (name, extra_json, updated_at) VALUES (?,?,?)",
                (r["name"], r["extra_json"], now),
            )
        conn.commit()


def list_tool_groups() -> list[dict[str, Any]]:
    rows = get_db().execute("SELECT name, extra_json FROM evoflow_tool_groups ORDER BY name").fetchall()
    return [tool_group_row_to_doc(_row_dict(row)) for row in rows]


# --- Channel platforms (feishu, etc.) ---


def replace_channel_configs(channels: dict[str, Any]) -> None:
    with db_connection_lock():
        conn = get_db()
        conn.execute("DELETE FROM evoflow_channel_configs")
        now = utc_now_iso_z()
        for platform, doc in channels.items():
            if not isinstance(doc, dict):
                continue
            r = channel_doc_to_row(str(platform), doc)
            conn.execute(
                "INSERT INTO evoflow_channel_configs (platform, enabled, platform_json, updated_at) VALUES (?,?,?,?)",
                (r["platform"], r["enabled"], r["platform_json"], now),
            )
        conn.commit()


def get_all_channel_configs() -> dict[str, dict[str, Any]]:
    rows = get_db().execute("SELECT platform, enabled, platform_json FROM evoflow_channel_configs").fetchall()
    return {str(row["platform"]): channel_row_to_doc(_row_dict(row)) for row in rows}


def upsert_channel_config(platform: str, document: dict[str, Any]) -> None:
    r = channel_doc_to_row(platform, document)
    now = utc_now_iso_z()

    def _write(db: Any) -> None:
        db.execute(
            """
            INSERT INTO evoflow_channel_configs (platform, enabled, platform_json, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(platform) DO UPDATE SET
                enabled = excluded.enabled,
                platform_json = excluded.platform_json,
                updated_at = excluded.updated_at
            """,
            (r["platform"], r["enabled"], r["platform_json"], now),
        )

    run_db_transaction(_write)


# --- MCP / skills registry ---


def replace_mcp_servers(servers: dict[str, Any]) -> None:
    with db_connection_lock():
        conn = get_db()
        conn.execute("DELETE FROM evoflow_mcp_servers")
        now = utc_now_iso_z()
        for name, doc in servers.items():
            if not isinstance(doc, dict):
                continue
            r = mcp_doc_to_row(str(name), doc)
            conn.execute(
                """
                INSERT INTO evoflow_mcp_servers (
                    name, enabled, type, command, url, description,
                    args_json, env_json, headers_json, oauth_json, extra_json, updated_at
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    r["name"],
                    r["enabled"],
                    r["type"],
                    r["command"],
                    r["url"],
                    r["description"],
                    r["args_json"],
                    r["env_json"],
                    r["headers_json"],
                    r["oauth_json"],
                    r["extra_json"],
                    now,
                ),
            )
        conn.commit()


def list_mcp_servers() -> dict[str, dict[str, Any]]:
    rows = (
        get_db()
        .execute(
            """
        SELECT name, enabled, type, command, url, description,
               args_json, env_json, headers_json, oauth_json, extra_json
        FROM evoflow_mcp_servers ORDER BY name
        """
        )
        .fetchall()
    )
    return {str(row["name"]): mcp_row_to_doc(_row_dict(row)) for row in rows}


def upsert_skill_registry(
    name: str,
    *,
    enabled: bool,
    skill_md: str | None = None,
    source_path: str | None = None,
    category: str | None = None,
    meta: dict[str, Any] | None = None,
    update_meta: bool = True,
) -> None:
    now = utc_now_iso_z()
    doc: dict[str, Any] = {
        "enabled": enabled,
        "skill_md": skill_md,
        "source_path": source_path,
        "category": category,
    }
    if update_meta:
        doc["meta"] = meta if isinstance(meta, dict) else {}
    r = skill_doc_to_row(name, doc, enabled=enabled)

    def _write(db: Any) -> None:
        if update_meta:
            db.execute(
                """
                INSERT INTO evoflow_skills (name, enabled, skill_md, source_path, category, meta_json, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET
                    enabled = excluded.enabled,
                    skill_md = excluded.skill_md,
                    source_path = excluded.source_path,
                    category = excluded.category,
                    meta_json = excluded.meta_json,
                    updated_at = excluded.updated_at
                """,
                (r["name"], r["enabled"], r["skill_md"], r["source_path"], r["category"], r["meta_json"], now),
            )
        else:
            db.execute(
                """
                INSERT INTO evoflow_skills (name, enabled, skill_md, source_path, category, meta_json, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET
                    enabled = excluded.enabled,
                    skill_md = COALESCE(excluded.skill_md, evoflow_skills.skill_md),
                    source_path = COALESCE(excluded.source_path, evoflow_skills.source_path),
                    category = COALESCE(excluded.category, evoflow_skills.category),
                    updated_at = excluded.updated_at
                """,
                (r["name"], r["enabled"], r["skill_md"], r["source_path"], r["category"], r["meta_json"], now),
            )

    run_db_transaction(_write)


def get_skill_registry(name: str) -> dict[str, Any] | None:
    row = (
        get_db()
        .execute(
            "SELECT name, enabled, skill_md, source_path, category, meta_json FROM evoflow_skills WHERE name = ?",
            (name,),
        )
        .fetchone()
    )
    if not row:
        return None
    return skill_row_to_doc(_row_dict(row))


def list_skill_registry() -> dict[str, dict[str, Any]]:
    rows = get_db().execute("SELECT name, enabled, skill_md, source_path, category, meta_json FROM evoflow_skills ORDER BY name").fetchall()
    return {str(row["name"]): skill_row_to_doc(_row_dict(row)) for row in rows}


def delete_skill_registry(name: str) -> bool:
    def _write(db: Any) -> bool:
        cur = db.execute("DELETE FROM evoflow_skills WHERE name = ?", (name.strip(),))
        return cur.rowcount > 0

    return run_db_transaction(_write)


def set_skill_enabled(name: str, enabled: bool) -> None:
    """Update only the enabled flag for a skill (registry row must exist or is created)."""
    reg = get_skill_registry(name) or {}
    upsert_skill_registry(
        str(name),
        enabled=enabled,
        skill_md=reg.get("skill_md"),
        source_path=reg.get("source_path"),
        category=reg.get("category"),
        meta=reg.get("meta") if isinstance(reg.get("meta"), dict) else {},
    )


def replace_skill_enablement(skills: dict[str, Any]) -> None:
    """Merge enabled flags from extensions-style map ``{name: {enabled: bool}}``."""
    for name, raw in skills.items():
        enabled = True
        if isinstance(raw, dict) and "enabled" in raw:
            enabled = bool(raw.get("enabled"))
        reg = get_skill_registry(str(name)) or {}
        meta = reg.get("meta")
        upsert_skill_registry(
            str(name),
            enabled=enabled,
            skill_md=reg.get("skill_md"),
            source_path=reg.get("source_path"),
            category=reg.get("category"),
            meta=meta if isinstance(meta, dict) else None,
            update_meta=isinstance(meta, dict),
        )


# --- Agents ---


def agent_exists(agent_code: str) -> bool:
    row = (
        get_db()
        .execute(
            "SELECT 1 FROM evoflow_agents WHERE agent_code = ?",
            (agent_code.lower(),),
        )
        .fetchone()
    )
    return row is not None


def _agent_tags_json(config: dict[str, Any]) -> str:
    """Serialize the agent ``tags`` field into the ``tags_json`` column value.

    ``tags`` is expected to be a list of label strings; anything else coerces
    to an empty array.  Mirrors :func:`evoflow.config.agent_tags.normalize_tags`.
    """
    from evoflow.config.agent_tags import normalize_tags

    return _dumps(normalize_tags(config.get("tags")))


def _save_agent_row(conn: Any, code: str, config: dict[str, Any], *, soul_md: str, now: str) -> None:
    # ``tags`` is a dedicated column (tags_json) as of schema v82; pull it out
    # before handing the doc to the row mapper so it does not leak into
    # ``extra_json``.  ``team_code`` is accepted for backward compatibility but
    # no longer persisted (the column was dropped by v82).
    config_for_mapper = {k: v for k, v in config.items() if k not in ("tags", "team_code")}
    agent_row, lists, env_items = agent_doc_to_parts(code, config_for_mapper)
    tags_json = _agent_tags_json(config)
    conn.execute(
        """
        INSERT INTO evoflow_agents (
            agent_code, agent_name, description, model, agent_type, system_prompt,
            max_turns, prompt_language, timeout_seconds, command,
            auto_approve_permissions, tags_json, soul_md, extra_json, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(agent_code) DO UPDATE SET
            agent_name = excluded.agent_name,
            description = excluded.description,
            model = excluded.model,
            agent_type = excluded.agent_type,
            system_prompt = excluded.system_prompt,
            max_turns = excluded.max_turns,
            prompt_language = excluded.prompt_language,
            timeout_seconds = excluded.timeout_seconds,
            command = excluded.command,
            auto_approve_permissions = excluded.auto_approve_permissions,
            tags_json = excluded.tags_json,
            soul_md = COALESCE(NULLIF(excluded.soul_md, ''), evoflow_agents.soul_md),
            extra_json = excluded.extra_json,
            updated_at = excluded.updated_at
        """,
        (
            agent_row["agent_code"],
            agent_row["agent_name"],
            agent_row["description"],
            agent_row["model"],
            agent_row["agent_type"],
            agent_row["system_prompt"],
            agent_row["max_turns"],
            agent_row["prompt_language"],
            agent_row["timeout_seconds"],
            agent_row["command"],
            agent_row["auto_approve_permissions"],
            tags_json,
            soul_md,
            agent_row["extra_json"],
            now,
        ),
    )
    conn.execute("DELETE FROM evoflow_agent_list_items WHERE agent_code = ?", (code,))
    conn.execute("DELETE FROM evoflow_agent_env WHERE agent_code = ?", (code,))
    for kind, val, sort_order in lists:
        conn.execute(
            """
            INSERT INTO evoflow_agent_list_items (
                agent_code, list_kind, item_value, sort_order, updated_at
            ) VALUES (?,?,?,?,?)
            """,
            (code, kind, val, int(sort_order or 0), now),
        )
    for ek, ev in env_items:
        conn.execute(
            """
            INSERT INTO evoflow_agent_env (agent_code, env_key, env_value, updated_at)
            VALUES (?,?,?,?)
            """,
            (code, ek, ev, now),
        )


def upsert_agent(agent_code: str, config: dict[str, Any], *, soul_md: str | None = None) -> None:
    code = agent_code.lower()
    now = utc_now_iso_z()
    existing_soul = get_agent_soul(code)
    soul = soul_md if soul_md is not None else (existing_soul or "")

    def _write(db: Any) -> None:
        _save_agent_row(db, code, config, soul_md=soul or "", now=now)

    run_db_transaction(_write)


def set_agent_owner_scope(
    agent_code: str,
    *,
    org_id: str,
    owner_scope_id: str,
) -> None:
    """Stamp ownership columns when present (schema v134+)."""
    code = str(agent_code or "").strip().lower()
    if not code:
        return

    def _write(db: Any) -> None:
        cols = {r[1] for r in db.execute("PRAGMA table_info(evoflow_agents)").fetchall()}
        if "org_id" not in cols or "owner_scope_id" not in cols:
            return
        db.execute(
            """
            UPDATE evoflow_agents
            SET org_id = COALESCE(NULLIF(org_id, ''), ?),
                owner_scope_id = COALESCE(NULLIF(owner_scope_id, ''), ?)
            WHERE agent_code = ?
            """,
            (org_id, owner_scope_id, code),
        )

    run_db_transaction(_write)


def get_agent_owner_scope(agent_code: str) -> tuple[str | None, str | None]:
    code = str(agent_code or "").strip().lower()
    if not code:
        return None, None
    cols = {r[1] for r in get_db().execute("PRAGMA table_info(evoflow_agents)").fetchall()}
    if "org_id" not in cols or "owner_scope_id" not in cols:
        return None, None
    row = get_db().execute(
        "SELECT org_id, owner_scope_id FROM evoflow_agents WHERE agent_code = ?",
        (code,),
    ).fetchone()
    if not row:
        return None, None
    return (str(row[0]).strip() or None, str(row[1]).strip() or None)


def agent_visible_to_principal(
    agent_code: str,
    principal_id: str,
    *,
    is_admin: bool = False,
    personal_scope: str | None = None,
    org_scope: str | None = None,
) -> bool:
    """Visibility: admin / own personal / org / group; empty owner = admin-only."""
    from evoflow.authz.resource_visibility import owner_scope_visible_to_principal
    from evoflow.authz.principals import get_principal

    code = str(agent_code or "").strip().lower()
    if not code or code == "main":
        return True  # install-shared default agent
    if is_admin:
        return True
    _org, owner = get_agent_owner_scope(code)
    p = None
    try:
        p = get_principal(principal_id) if principal_id else None
    except Exception:
        p = None
    return owner_scope_visible_to_principal(
        owner,
        p,
        is_admin=False,
        personal_scope=personal_scope,
        org_scope=org_scope,
    )


def get_agent_config(agent_code: str) -> dict[str, Any] | None:
    code = agent_code.lower()
    row = (
        get_db()
        .execute(
            """
        SELECT agent_code, agent_name, description, model, agent_type, system_prompt,
               max_turns, prompt_language, timeout_seconds, command,
               auto_approve_permissions, tags_json, extra_json
        FROM evoflow_agents WHERE agent_code = ?
        """,
            (code,),
        )
        .fetchone()
    )
    if not row:
        return None
    lists = [
        (str(d["list_kind"]), str(d["item_value"]), int(d.get("sort_order") or 0))
        for d in (
            _row_dict(r)
            for r in get_db()
            .execute(
                "SELECT list_kind, item_value, sort_order FROM evoflow_agent_list_items WHERE agent_code = ? ORDER BY list_kind, sort_order",
                (code,),
            )
            .fetchall()
        )
    ]
    env_items = [
        (str(d["env_key"]), str(d["env_value"]))
        for d in (
            _row_dict(r)
            for r in get_db()
            .execute(
                "SELECT env_key, env_value FROM evoflow_agent_env WHERE agent_code = ?",
                (code,),
            )
            .fetchall()
        )
    ]
    doc = agent_parts_to_doc(_row_dict(row), lists, env_items)
    # Deserialize tags_json -> tags (list[str]); missing/invalid -> [].
    raw_tags = _row_dict(row).get("tags_json")
    tags = _loads(raw_tags) if raw_tags else None
    if isinstance(tags, list):
        doc["tags"] = [str(t) for t in tags if t is not None]
    else:
        doc["tags"] = []
    # Drop any stale team_code that may have been merged from extra_json.
    doc.pop("team_code", None)
    return doc


def get_agent_soul(agent_code: str) -> str | None:
    row = (
        get_db()
        .execute(
            "SELECT soul_md FROM evoflow_agents WHERE agent_code = ?",
            (agent_code.lower(),),
        )
        .fetchone()
    )
    if not row:
        return None
    text = str(row[0] or "").strip()
    return text or None


def save_agent_soul(agent_code: str, soul_md: str) -> None:
    code = agent_code.lower()
    if not agent_exists(code):
        upsert_agent(code, {"agent_code": code, "agent_type": "custom"})
    now = utc_now_iso_z()

    def _write(db: Any) -> None:
        db.execute(
            "UPDATE evoflow_agents SET soul_md = ?, updated_at = ? WHERE agent_code = ?",
            (soul_md, now, code),
        )

    run_db_transaction(_write)


def get_agent_identity(agent_code: str) -> str | None:
    """Read L0 identity markdown (Person Kernel). Missing column → None."""
    code = agent_code.lower()
    try:
        row = (
            get_db()
            .execute(
                "SELECT identity_md FROM evoflow_agents WHERE agent_code = ?",
                (code,),
            )
            .fetchone()
        )
    except Exception:
        return None
    if not row:
        return None
    text = str(row[0] or "").strip()
    return text or None


def save_agent_identity(
    agent_code: str,
    identity_md: str,
    *,
    source: str = "admin",
    approved_by: str = "admin",
    reason: str = "",
) -> None:
    """Persist L0 identity. Runtime duty/wrap-up must not call this."""
    code = agent_code.lower()
    if not agent_exists(code):
        upsert_agent(code, {"agent_code": code, "agent_type": "custom"})
    now = utc_now_iso_z()
    old = get_agent_identity(code) or ""
    new = str(identity_md or "")

    def _write(db: Any) -> None:
        db.execute(
            "UPDATE evoflow_agents SET identity_md = ?, updated_at = ? WHERE agent_code = ?",
            (new, now, code),
        )

    run_db_transaction(_write)
    if old.strip() != new.strip():
        append_soul_changelog(
            code,
            field="identity_md",
            old_value=old[:2000],
            new_value=new[:2000],
            reason=reason or f"identity update via {source}",
            evidence=[],
            source=source,
            approved_by=approved_by,
        )


def append_soul_changelog(
    agent_code: str,
    *,
    field: str,
    old_value: str = "",
    new_value: str = "",
    reason: str = "",
    evidence: Any = None,
    source: str = "",
    approved_by: str = "system",
) -> None:
    code = str(agent_code or "").strip().lower()
    if not code:
        return
    now = utc_now_iso_z()
    if evidence is None:
        evidence_json = "[]"
    elif isinstance(evidence, str):
        evidence_json = evidence
    else:
        evidence_json = _dumps(evidence)

    def _write(db: Any) -> None:
        db.execute(
            """
            INSERT INTO evoflow_soul_changelog (
                agent_code, field, old_value, new_value, reason,
                evidence_json, source, approved_by, created_at
            ) VALUES (?,?,?,?,?,?,?,?,?)
            """,
            (
                code,
                str(field or "")[:80],
                str(old_value or ""),
                str(new_value or ""),
                str(reason or "")[:500],
                evidence_json,
                str(source or "")[:80],
                str(approved_by or "system")[:80],
                now,
            ),
        )

    try:
        run_db_transaction(_write)
    except Exception:
        # Table may not exist until migration; never break soul saves.
        import logging

        logging.getLogger(__name__).debug(
            "append_soul_changelog skipped", exc_info=True
        )


def list_soul_changelog(agent_code: str, *, limit: int = 30) -> list[dict[str, Any]]:
    code = str(agent_code or "").strip().lower()
    if not code:
        return []
    lim = max(1, min(int(limit or 30), 200))
    try:
        rows = (
            get_db()
            .execute(
                """
                SELECT id, agent_code, field, old_value, new_value, reason,
                       evidence_json, source, approved_by, created_at
                FROM evoflow_soul_changelog
                WHERE agent_code = ?
                ORDER BY id DESC
                LIMIT ?
                """,
                (code, lim),
            )
            .fetchall()
        )
    except Exception:
        return []
    out: list[dict[str, Any]] = []
    for row in rows:
        d = _row_dict(row) if not isinstance(row, dict) else dict(row)
        ev = d.get("evidence_json")
        try:
            d["evidence"] = _loads(ev) if ev else []
        except Exception:
            d["evidence"] = []
        d.pop("evidence_json", None)
        out.append(d)
    return out


def delete_agent(agent_code: str) -> None:
    code = agent_code.lower()

    def _write(db: Any) -> None:
        db.execute("DELETE FROM evoflow_agent_list_items WHERE agent_code = ?", (code,))
        db.execute("DELETE FROM evoflow_agent_env WHERE agent_code = ?", (code,))
        db.execute("DELETE FROM evoflow_agents WHERE agent_code = ?", (code,))

    run_db_transaction(_write)


def list_agent_codes() -> list[str]:
    """Return all agent codes ordered alphabetically.

    Grouping is now tag-based (``tags_json``); the former ``team_code`` filter
    has been removed.  Callers that need to filter by tag should load each
    agent config and inspect its ``tags`` list.
    """
    rows = get_db().execute("SELECT agent_code FROM evoflow_agents ORDER BY agent_code").fetchall()
    return [str(r[0]) for r in rows]


# --- App settings (primary_model, feishu learned chat, etc.) ---


def get_app_setting(key: str) -> Any:
    def _do() -> Any:
        row = (
            get_db()
            .execute(
                "SELECT value_text, value_json FROM evoflow_app_settings WHERE key = ?",
                (key,),
            )
            .fetchone()
        )
        if not row:
            return None
        if row[0] is not None:
            return row[0]
        return _loads(row[1])

    return run_db_with_retry(_do)


def set_app_setting(key: str, value: Any) -> None:
    now = utc_now_iso_z()
    value_text: str | None = None
    value_json: str | None = None
    if isinstance(value, str):
        value_text = value
    else:
        value_json = _dumps(value)

    def _write(db: Any) -> None:
        db.execute(
            """
            INSERT INTO evoflow_app_settings (key, value_text, value_json, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value_text = excluded.value_text,
                value_json = excluded.value_json,
                updated_at = excluded.updated_at
            """,
            (key, value_text, value_json, now),
        )

    run_db_transaction(_write)


def list_app_settings() -> dict[str, Any]:
    rows = get_db().execute("SELECT key, value_text, value_json FROM evoflow_app_settings").fetchall()
    out: dict[str, Any] = {}
    for row in rows:
        if row[1] is not None:
            out[str(row[0])] = row[1]
        else:
            out[str(row[0])] = _loads(row[2])
    return out


# --- Single-row CRUD (Gateway) ---


def upsert_model(document: dict[str, Any]) -> None:
    document = sanitize_model_document(document)
    name = str(document.get("name") or "").strip()
    if not name:
        raise ValueError("model.name is required")
    r = model_doc_to_row(document)
    now = utc_now_iso_z()
    plan_type = str(document.get("plan_type") or "none") if "plan_type" in document else None
    if "plan_config" in document:
        plan_config = document.get("plan_config")
        plan_config_json = (
            json.dumps(plan_config, ensure_ascii=False) if isinstance(plan_config, dict) else None
        )
    else:
        plan_config_json = None

    def _write(db: Any) -> None:
        # availability_* columns are set only by mark/clear APIs — never overwritten
        # by Panel sync / ordinary create-update (ON CONFLICT leaves existing values;
        # INSERT uses defaults from the document or 'available').
        db.execute(
            """
            INSERT INTO evoflow_models (
                name, vendor, display_name, description, use, model,
                base_url, api_key, request_timeout, max_retries, max_tokens, temperature,
                use_responses_api, output_version,
                supports_thinking, supports_reasoning_effort, supports_vision,
                when_thinking_enabled_json, thinking_json,
                context_length, input_context_length, output_context_length,
                availability_status, unavailable_reason, unavailable_code, unavailable_at,
                extra_json, plan_type, plan_config, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(name) DO UPDATE SET
                vendor = excluded.vendor,
                display_name = excluded.display_name,
                description = excluded.description,
                use = excluded.use,
                model = excluded.model,
                base_url = excluded.base_url,
                api_key = COALESCE(excluded.api_key, evoflow_models.api_key),
                request_timeout = excluded.request_timeout,
                max_retries = excluded.max_retries,
                max_tokens = excluded.max_tokens,
                temperature = excluded.temperature,
                use_responses_api = excluded.use_responses_api,
                output_version = excluded.output_version,
                supports_thinking = excluded.supports_thinking,
                supports_reasoning_effort = excluded.supports_reasoning_effort,
                supports_vision = excluded.supports_vision,
                when_thinking_enabled_json = excluded.when_thinking_enabled_json,
                thinking_json = excluded.thinking_json,
                context_length = excluded.context_length,
                input_context_length = excluded.input_context_length,
                output_context_length = excluded.output_context_length,
                extra_json = excluded.extra_json,
                plan_type = COALESCE(excluded.plan_type, evoflow_models.plan_type),
                plan_config = COALESCE(excluded.plan_config, evoflow_models.plan_config),
                updated_at = excluded.updated_at
            """,
            (
                r["name"],
                r["vendor"],
                r["display_name"],
                r["description"],
                r["use"],
                r["model"],
                r["base_url"],
                r["api_key"],
                r["request_timeout"],
                r["max_retries"],
                r["max_tokens"],
                r["temperature"],
                r["use_responses_api"],
                r["output_version"],
                r["supports_thinking"],
                r["supports_reasoning_effort"],
                r["supports_vision"],
                r["when_thinking_enabled_json"],
                r["thinking_json"],
                r["context_length"],
                r["input_context_length"],
                r["output_context_length"],
                r.get("availability_status") or "available",
                r.get("unavailable_reason"),
                r.get("unavailable_code"),
                r.get("unavailable_at"),
                r["extra_json"],
                plan_type if plan_type is not None else "none",
                plan_config_json,
                now,
            ),
        )

    run_db_transaction(_write)


def mark_model_unavailable(
    name: str,
    *,
    reason: str,
    code: str | None = None,
) -> bool:
    """Persist unavailable status for a configured model. Returns False if missing."""
    model_name = str(name or "").strip()
    if not model_name:
        return False
    reason_text = str(reason or "").strip() or "上游模型不可用"
    code_text = str(code or "").strip() or None
    now = utc_now_iso_z()

    def _write(db: Any) -> bool:
        cur = db.execute(
            """
            UPDATE evoflow_models
            SET availability_status = 'unavailable',
                unavailable_reason = ?,
                unavailable_code = ?,
                unavailable_at = ?,
                updated_at = ?
            WHERE name = ?
            """,
            (reason_text, code_text, now, now, model_name),
        )
        return cur.rowcount > 0

    return bool(run_db_transaction(_write))


def clear_model_unavailable(name: str) -> bool:
    """Clear unavailable mark; returns True only when a row was actually cleared."""
    model_name = str(name or "").strip()
    if not model_name:
        return False
    now = utc_now_iso_z()

    def _write(db: Any) -> bool:
        cur = db.execute(
            """
            UPDATE evoflow_models
            SET availability_status = 'available',
                unavailable_reason = NULL,
                unavailable_code = NULL,
                unavailable_at = NULL,
                updated_at = ?
            WHERE name = ? AND availability_status = 'unavailable'
            """,
            (now, model_name),
        )
        return cur.rowcount > 0

    return bool(run_db_transaction(_write))


def is_model_unavailable(name: str) -> bool:
    model_name = str(name or "").strip()
    if not model_name:
        return False
    row = (
        get_db()
        .execute(
            "SELECT availability_status FROM evoflow_models WHERE name = ?",
            (model_name,),
        )
        .fetchone()
    )
    if not row:
        return False
    return str(row[0] or "").strip().lower() == "unavailable"


def delete_model(name: str) -> bool:
    name = name.strip()
    row = get_model(name)
    if not row:
        return False
    vendor = str(row.get("vendor") or "").strip()

    def _write(db: Any) -> bool:
        cur = db.execute("DELETE FROM evoflow_models WHERE name = ?", (name,))
        if cur.rowcount <= 0:
            return False
        primary = db.execute(
            "SELECT value_text FROM evoflow_app_settings WHERE key = 'primary_model'",
        ).fetchone()
        if primary and str(primary[0] or "").strip() == name:
            db.execute("DELETE FROM evoflow_app_settings WHERE key = 'primary_model'")
        db.execute(
            "UPDATE evoflow_chat_sessions SET model_name = NULL WHERE model_name = ?",
            (name,),
        )
        db.execute(
            "UPDATE evoflow_chat_sessions SET primary_model_name = NULL WHERE primary_model_name = ?",
            (name,),
        )
        return True

    deleted = run_db_transaction(_write)
    if deleted and vendor:
        from evoflow.persistence.model_cleanup import delete_connection_if_no_models

        delete_connection_if_no_models(vendor)
    return deleted


def get_model(name: str) -> dict[str, Any] | None:
    row = (
        get_db()
        .execute(
            """
        SELECT name, vendor, display_name, description, use, model,
               base_url, api_key, request_timeout, max_retries, max_tokens, temperature,
               use_responses_api, output_version,
               supports_thinking, supports_reasoning_effort, supports_vision,
               when_thinking_enabled_json, thinking_json,
               context_length, input_context_length, output_context_length,
               availability_status, unavailable_reason, unavailable_code, unavailable_at,
               extra_json
        FROM evoflow_models WHERE name = ?
        """,
            (name.strip(),),
        )
        .fetchone()
    )
    if not row:
        return None
    return model_row_to_doc(_row_dict(row))


def upsert_tool(document: dict[str, Any]) -> None:
    name = str(document.get("name") or "").strip()
    if not name:
        raise ValueError("tool.name is required")
    r = tool_doc_to_row(document)
    now = utc_now_iso_z()

    def _write(db: Any) -> None:
        db.execute(
            """
            INSERT INTO evoflow_tools (name, group_name, use, extra_json, updated_at) VALUES (?,?,?,?,?)
            ON CONFLICT(name) DO UPDATE SET
                group_name = excluded.group_name,
                use = excluded.use,
                extra_json = excluded.extra_json,
                updated_at = excluded.updated_at
            """,
            (r["name"], r["group_name"], r["use"], r["extra_json"], now),
        )

    run_db_transaction(_write)


def delete_tool(name: str) -> bool:
    def _write(db: Any) -> bool:
        cur = db.execute("DELETE FROM evoflow_tools WHERE name = ?", (name.strip(),))
        return cur.rowcount > 0

    return run_db_transaction(_write)


def upsert_tool_group(document: dict[str, Any]) -> None:
    name = str(document.get("name") or "").strip()
    if not name:
        raise ValueError("tool_group.name is required")
    r = tool_group_doc_to_row(document)
    now = utc_now_iso_z()

    def _write(db: Any) -> None:
        db.execute(
            """
            INSERT INTO evoflow_tool_groups (name, extra_json, updated_at) VALUES (?,?,?)
            ON CONFLICT(name) DO UPDATE SET extra_json = excluded.extra_json, updated_at = excluded.updated_at
            """,
            (r["name"], r["extra_json"], now),
        )

    run_db_transaction(_write)


def delete_tool_group(name: str) -> bool:
    def _write(db: Any) -> bool:
        cur = db.execute("DELETE FROM evoflow_tool_groups WHERE name = ?", (name.strip(),))
        return cur.rowcount > 0

    return run_db_transaction(_write)


def upsert_mcp_server(name: str, document: dict[str, Any]) -> None:
    r = mcp_doc_to_row(name, document)
    now = utc_now_iso_z()

    def _write(db: Any) -> None:
        db.execute(
            """
            INSERT INTO evoflow_mcp_servers (
                name, enabled, type, command, url, description,
                args_json, env_json, headers_json, oauth_json, extra_json, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(name) DO UPDATE SET
                enabled = excluded.enabled,
                type = excluded.type,
                command = excluded.command,
                url = excluded.url,
                description = excluded.description,
                args_json = excluded.args_json,
                env_json = excluded.env_json,
                headers_json = excluded.headers_json,
                oauth_json = excluded.oauth_json,
                extra_json = excluded.extra_json,
                updated_at = excluded.updated_at
            """,
            (
                r["name"],
                r["enabled"],
                r["type"],
                r["command"],
                r["url"],
                r["description"],
                r["args_json"],
                r["env_json"],
                r["headers_json"],
                r["oauth_json"],
                r["extra_json"],
                now,
            ),
        )

    run_db_transaction(_write)


def delete_mcp_server(name: str) -> bool:
    def _write(db: Any) -> bool:
        cur = db.execute("DELETE FROM evoflow_mcp_servers WHERE name = ?", (name.strip(),))
        return cur.rowcount > 0

    return run_db_transaction(_write)
