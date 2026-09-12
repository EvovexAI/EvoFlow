"""Panel LLM provider connection settings (``evoflow_model_connections``)."""

from __future__ import annotations

import logging
from typing import Any

from evoflow.persistence.db import get_db, run_db_transaction
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

DEFAULT_API_TYPE = "openai-completions"
DEFAULT_USE = "langchain_openai:ChatOpenAI"


def use_to_api_type(use: str) -> str:
    u = str(use or "").lower()
    if "langchain_anthropic" in u:
        return "anthropic-messages"
    if "langchain_google_genai" in u:
        return "google-generative-ai"
    return DEFAULT_API_TYPE


def api_type_to_use(api_type: str) -> str:
    t = str(api_type or "").strip().lower()
    if t == "anthropic-messages":
        return "langchain_anthropic:ChatAnthropic"
    if t in {"google-generative-ai", "google-gemini"}:
        return "langchain_google_genai:ChatGoogleGenerativeAI"
    return DEFAULT_USE


def _row_to_dict(row: tuple[Any, ...]) -> dict[str, Any]:
    return {
        "key": str(row[0]),
        "base_url": str(row[1] or ""),
        "api_key": str(row[2] or ""),
        "api_type": str(row[3] or DEFAULT_API_TYPE),
        "display_name": str(row[4] or ""),
        "updated_at": str(row[5] or ""),
    }


def _propagate_connection_to_models(
    db: Any,
    *,
    key: str,
    base_url: str,
    api_type: str,
    api_key: str | None,
    update_api_key: bool,
    now: str,
) -> None:
    """Push connection endpoint settings onto ``evoflow_models`` rows for *key*.

    Runtime calls read ``evoflow_models.api_key`` / ``base_url``, not the connections
    table — so connection edits must mirror onto matching model rows (vendor = key).
    """
    vendor = str(key or "").strip()
    if not vendor:
        return
    use = api_type_to_use(api_type)
    if update_api_key:
        db.execute(
            """
            UPDATE evoflow_models
            SET base_url = ?, api_key = ?, use = ?, updated_at = ?
            WHERE vendor = ?
            """,
            (base_url, str(api_key or ""), use, now, vendor),
        )
    else:
        db.execute(
            """
            UPDATE evoflow_models
            SET base_url = ?, use = ?, updated_at = ?
            WHERE vendor = ?
            """,
            (base_url, use, now, vendor),
        )


def _maybe_sync_active_plan_binding_key(
    *,
    key: str,
    base_url: str,
    api_key: str,
    update_api_key: bool,
) -> None:
    """When volcengine Plan connection key changes, refresh binding + media credentials."""
    if not update_api_key:
        return
    vendor = str(key or "").strip().lower()
    new_key = str(api_key or "").strip()
    if vendor != "volcengine" or not new_key:
        return
    if "/api/plan/" not in str(base_url or "").lower():
        return
    try:
        from evoflow.plans.bindings import find_active_binding
        from evoflow.plans.service import patch_binding

        binding = find_active_binding(
            vendor="volcengine",
            plan_family="agent_plan",
            mask_key=False,
        )
        if not binding:
            return
        old_key = str(binding.get("api_key") or "").strip()
        if old_key == new_key:
            return
        patch_binding(
            str(binding["id"]),
            {"api_key": new_key, "rematerialize": True},
        )
        logger.info("Synced Agent Plan binding key after volcengine connection update")
    except Exception as exc:
        logger.warning("Agent Plan binding key sync skipped: %s", exc)


def list_model_connections() -> dict[str, dict[str, Any]]:
    rows = get_db().execute(
        """
        SELECT key, base_url, api_key, api_type, display_name, updated_at
        FROM evoflow_model_connections
        ORDER BY key
        """
    ).fetchall()
    return {str(r[0]): _row_to_dict(r) for r in rows}


def get_model_connection(key: str) -> dict[str, Any] | None:
    k = str(key or "").strip()
    if not k:
        return None
    row = get_db().execute(
        """
        SELECT key, base_url, api_key, api_type, display_name, updated_at
        FROM evoflow_model_connections
        WHERE key = ?
        """,
        (k,),
    ).fetchone()
    return _row_to_dict(row) if row else None


def _normalize_connection_payload(raw: dict[str, Any]) -> dict[str, Any]:
    key = str(raw.get("key") or "").strip()
    if not key:
        raise ValueError("connection.key is required")
    api_type = str(raw.get("api_type") or raw.get("api") or DEFAULT_API_TYPE).strip() or DEFAULT_API_TYPE
    display_name = str(raw.get("display_name") or raw.get("displayName") or "").strip()
    return {
        "key": key,
        "base_url": str(raw.get("base_url") or raw.get("baseUrl") or ""),
        "api_type": api_type,
        "display_name": display_name,
        "api_key": raw.get("api_key") if "api_key" in raw else raw.get("apiKey"),
    }


def _is_masked_api_key(value: Any) -> bool:
    s = str(value or "").strip()
    return bool(s) and s.startswith("*")


def upsert_model_connection(raw: dict[str, Any]) -> dict[str, Any]:
    payload = _normalize_connection_payload(raw)
    now = utc_now_iso_z()
    existing = get_model_connection(payload["key"])

    api_key_in = payload.get("api_key")
    if api_key_in is None:
        api_key = existing["api_key"] if existing else ""
        update_api_key = False
    elif _is_masked_api_key(api_key_in):
        api_key = existing["api_key"] if existing else ""
        update_api_key = False
    else:
        api_key = str(api_key_in or "")
        update_api_key = True

    def _write(db: Any) -> None:
        db.execute(
            """
            INSERT INTO evoflow_model_connections (
                key, base_url, api_key, api_type, display_name, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                base_url = excluded.base_url,
                api_key = excluded.api_key,
                api_type = excluded.api_type,
                display_name = excluded.display_name,
                updated_at = excluded.updated_at
            """,
            (
                payload["key"],
                payload["base_url"],
                api_key,
                payload["api_type"],
                payload["display_name"],
                now,
            ),
        )
        _propagate_connection_to_models(
            db,
            key=payload["key"],
            base_url=payload["base_url"],
            api_type=payload["api_type"],
            api_key=api_key,
            update_api_key=update_api_key,
            now=now,
        )

    run_db_transaction(_write)
    _maybe_sync_active_plan_binding_key(
        key=payload["key"],
        base_url=payload["base_url"],
        api_key=api_key,
        update_api_key=update_api_key,
    )
    result = get_model_connection(payload["key"])
    assert result is not None
    return result


def delete_model_connection(key: str) -> bool:
    k = str(key or "").strip()
    if not k:
        return False

    def _write(db: Any) -> bool:
        cur = db.execute("DELETE FROM evoflow_model_connections WHERE key = ?", (k,))
        return cur.rowcount > 0

    deleted = run_db_transaction(_write)
    if deleted:
        # A connection owns its models; remove them so the Panel does not
        # resurrect orphan rows on the next refresh (safe, vendor == key).
        try:
            from evoflow.persistence.model_cleanup import delete_models_for_connection

            delete_models_for_connection(k)
        except Exception as exc:
            logger.warning("delete_model_connection: model cleanup skipped for %s: %s", k, exc)
    return deleted


def sync_model_connections(desired: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Replace Panel-managed connections with *desired* (upsert + delete orphans)."""
    normalized: list[dict[str, Any]] = []
    desired_keys: set[str] = set()
    for raw in desired or []:
        if not isinstance(raw, dict):
            continue
        payload = _normalize_connection_payload(raw)
        desired_keys.add(payload["key"])
        normalized.append(payload)

    existing = list_model_connections()

    def _write(db: Any) -> None:
        for key in existing:
            if key not in desired_keys:
                db.execute("DELETE FROM evoflow_model_connections WHERE key = ?", (key,))
        now = utc_now_iso_z()
        for payload in normalized:
            key = payload["key"]
            prev = existing.get(key)
            api_key_in = payload.get("api_key")
            if api_key_in is None:
                api_key = prev["api_key"] if prev else ""
                update_api_key = False
            elif _is_masked_api_key(api_key_in):
                api_key = prev["api_key"] if prev else ""
                update_api_key = False
            else:
                api_key = str(api_key_in or "")
                update_api_key = True

            db.execute(
                """
                INSERT INTO evoflow_model_connections (
                    key, base_url, api_key, api_type, display_name, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    base_url = excluded.base_url,
                    api_key = excluded.api_key,
                    api_type = excluded.api_type,
                    display_name = excluded.display_name,
                    updated_at = excluded.updated_at
                """,
                (
                    key,
                    payload["base_url"],
                    api_key,
                    payload["api_type"],
                    payload["display_name"],
                    now,
                ),
            )
            _propagate_connection_to_models(
                db,
                key=key,
                base_url=payload["base_url"],
                api_type=payload["api_type"],
                api_key=api_key,
                update_api_key=update_api_key,
                now=now,
            )
            if update_api_key:
                _maybe_sync_active_plan_binding_key(
                    key=key,
                    base_url=payload["base_url"],
                    api_key=api_key,
                    update_api_key=True,
                )

    run_db_transaction(_write)

    # Remove models owned by connections that were dropped during sync.
    removed_keys = [key for key in existing if key not in desired_keys]
    for key in removed_keys:
        prev = existing.get(key) or {}
        try:
            from evoflow.persistence.model_cleanup import delete_models_for_connection

            delete_models_for_connection(
                key,
                base_url=str(prev.get("base_url") or ""),
                api_type=str(prev.get("api_type") or "openai-completions"),
            )
        except Exception as exc:
            logger.warning("sync_model_connections: model cleanup skipped for %s: %s", key, exc)

    return list_model_connections()
