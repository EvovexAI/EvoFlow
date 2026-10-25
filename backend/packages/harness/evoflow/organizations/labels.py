"""Resolve org-pack artifact ids to human-readable (usually Chinese) labels."""

from __future__ import annotations

import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

_ARTIFACT_KEYS = (
    "employees",
    "agents",
    "apps",
    "skills",
    "extensions",
    "knowledge",
)


def _first_phrase(text: str, *, limit: int = 28) -> str:
    s = re.sub(r"\s+", " ", str(text or "").strip())
    if not s:
        return ""
    for sep in ("：", ":", "。", ".", "；", ";", "，", ",", "\n"):
        if sep in s:
            s = s.split(sep, 1)[0].strip()
            break
    if len(s) > limit:
        s = s[: limit - 1].rstrip() + "…"
    return s


def _label_employee(code: str) -> str:
    try:
        from evoflow.admin import employees as employees_admin

        row = employees_admin.get_role(code, recent_limit=0)
        name = str(row.get("role_name") or row.get("agent_name") or "").strip()
        if name:
            return name
    except Exception:
        logger.debug("label employee failed code=%s", code, exc_info=True)
    return _label_agent(code)


def _label_agent(code: str) -> str:
    try:
        from evoflow.admin import agents as agents_admin

        row = agents_admin.get_agent(code)
        name = str(row.get("agent_name") or "").strip()
        if name:
            return name
    except Exception:
        logger.debug("label agent failed code=%s", code, exc_info=True)
    return ""


def _label_skill(name: str) -> str:
    try:
        from evoflow.admin import skills as skills_admin

        row = skills_admin.get_skill(name)
        # Prefer a short Chinese phrase from description; skill.name is usually the id slug.
        desc = _first_phrase(str(row.get("description") or ""))
        if desc and desc.lower() != str(name).lower():
            return desc
        path = str(row.get("path") or "").strip()
        if path:
            from pathlib import Path

            md = Path(path) / "SKILL.md"
            if md.is_file():
                text = md.read_text(encoding="utf-8", errors="replace")[:2000]
                m = re.search(r"^#\s+(.+)$", text, re.M)
                if m:
                    title = m.group(1).strip()
                    if title and title.lower() != str(name).lower():
                        return title
    except Exception:
        logger.debug("label skill failed name=%s", name, exc_info=True)
    return ""


def _label_knowledge(kb_id: str) -> str:
    try:
        from evoflow.knowledge.owned import service as owned_service

        base = owned_service.get_base(kb_id)
        if base:
            name = str(base.get("name") or "").strip()
            if name:
                return name
    except Exception:
        logger.debug("label knowledge failed kb=%s", kb_id, exc_info=True)
    return ""


def _label_extension(ext_id: str) -> str:
    try:
        from evoflow.admin import ui_extensions_registry as ext_reg

        row = ext_reg.get_row(ext_id)
        if not row:
            return ""
        manifest = row.get("manifest") if isinstance(row.get("manifest"), dict) else {}
        name = str(manifest.get("name") or "").strip()
        if name:
            return name
        nav = manifest.get("nav") if isinstance(manifest.get("nav"), dict) else {}
        title = str(nav.get("title") or "").strip()
        if title:
            return title
    except Exception:
        logger.debug("label extension failed id=%s", ext_id, exc_info=True)
    return ""


def _label_app(app_id: str) -> str:
    try:
        from evoflow.admin import apps as apps_admin

        # Best-effort: list and match; avoid hard dependency on get API shape.
        listed = apps_admin.list_apps() if hasattr(apps_admin, "list_apps") else None
        items = []
        if isinstance(listed, dict):
            items = listed.get("apps") or listed.get("items") or []
        elif isinstance(listed, list):
            items = listed
        for row in items or []:
            if not isinstance(row, dict):
                continue
            rid = str(row.get("id") or row.get("app_id") or "").strip()
            if rid != app_id:
                continue
            name = str(row.get("name") or row.get("title") or "").strip()
            if name:
                return name
    except Exception:
        logger.debug("label app failed id=%s", app_id, exc_info=True)
    return ""


_RESOLVERS = {
    "employees": _label_employee,
    "agents": _label_agent,
    "skills": _label_skill,
    "knowledge": _label_knowledge,
    "extensions": _label_extension,
    "apps": _label_app,
}


def resolve_artifact_details(artifacts: dict[str, list[str]] | None) -> dict[str, list[dict[str, str]]]:
    """Turn `{type: [id, …]}` into `{type: [{id, name}, …]}` with display names."""
    arts = artifacts if isinstance(artifacts, dict) else {}
    out: dict[str, list[dict[str, str]]] = {}
    for key in _ARTIFACT_KEYS:
        ids = arts.get(key) if isinstance(arts.get(key), list) else []
        resolver = _RESOLVERS.get(key)
        rows: list[dict[str, str]] = []
        for raw in ids or []:
            aid = str(raw or "").strip()
            if not aid:
                continue
            label = ""
            if resolver:
                try:
                    label = str(resolver(aid) or "").strip()
                except Exception:
                    logger.debug("artifact label resolve failed type=%s id=%s", key, aid, exc_info=True)
                    label = ""
            rows.append({"id": aid, "name": label or aid})
        if rows:
            out[key] = rows
    return out
