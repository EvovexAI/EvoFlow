"""Per-scope filesystem layout under ``{base_dir}/scopes/``.

Layout (install still shares one ``.evoflow`` / EVOFLOW_HOME)::

    {base}/
      data/app/evoflow.db          # shared DB
      skills/                      # legacy primary (org-readable PUBLIC)
      scopes/
        org/local/
          skills/{public,custom}/
          agents/                  # optional FS mirror
          files/
          memory/
        personal/<principal_id>/
          skills/{public,custom}/
          agents/
          files/
          memory/
        group/<group_id>/
          skills/...
          ...

Legacy ``~/.evoflow/skills`` remains the PUBLIC primary root for single-user.
Personal/org/group roots are additive layers scanned by the skill index.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

from evoflow.authz.scope import parse_scope_id
from evoflow.authz.types import DEFAULT_ORG_ID, Principal

logger = logging.getLogger(__name__)

_SAFE_REF_RE = re.compile(r"[^A-Za-z0-9._@+-]+")


def _safe_segment(raw: str) -> str:
    s = str(raw or "").strip()
    if not s:
        return "_"
    # Keep path-safe; collapse path separators and odd chars.
    s = s.replace("\\", "/").replace("/", "__")
    s = _SAFE_REF_RE.sub("_", s)
    return s[:180] or "_"


def resolve_base_dir() -> Path:
    try:
        from evoflow.config.paths import get_paths

        return get_paths().base_dir
    except Exception:
        from evoflow.config.data_paths import resolve_data_base_dir

        return resolve_data_base_dir()


def scopes_root(base_dir: Path | None = None) -> Path:
    return (base_dir or resolve_base_dir()) / "scopes"


def scope_dir(scope_id: str, *, base_dir: Path | None = None) -> Path:
    kind, ref = parse_scope_id(scope_id)
    return scopes_root(base_dir) / kind / _safe_segment(ref)


def scope_skills_dir(scope_id: str, *, base_dir: Path | None = None) -> Path:
    return scope_dir(scope_id, base_dir=base_dir) / "skills"


def scope_agents_dir(scope_id: str, *, base_dir: Path | None = None) -> Path:
    return scope_dir(scope_id, base_dir=base_dir) / "agents"


def scope_files_dir(scope_id: str, *, base_dir: Path | None = None) -> Path:
    return scope_dir(scope_id, base_dir=base_dir) / "files"


def scope_memory_dir(scope_id: str, *, base_dir: Path | None = None) -> Path:
    return scope_dir(scope_id, base_dir=base_dir) / "memory"


def ensure_scope_layout(scope_id: str, *, base_dir: Path | None = None) -> Path:
    """Create the standard subdirectory tree for a scope; return scope root."""
    root = scope_dir(scope_id, base_dir=base_dir)
    for sub in (
        root / "skills" / "public",
        root / "skills" / "custom",
        root / "agents",
        root / "files",
        root / "memory",
    ):
        try:
            sub.mkdir(parents=True, exist_ok=True)
        except OSError:
            logger.debug("ensure_scope_layout mkdir failed: %s", sub, exc_info=True)
    return root


def org_scope_id(org_id: str = DEFAULT_ORG_ID) -> str:
    from evoflow.authz.scope import org_scope

    return org_scope(org_id or DEFAULT_ORG_ID)


def personal_scope_id(principal_id: str) -> str:
    from evoflow.authz.scope import personal_scope

    return personal_scope(principal_id)


def ensure_principal_home(principal: Principal, *, base_dir: Path | None = None) -> Path:
    """Ensure org + personal homes exist for a principal."""
    oid = str(principal.get("org_id") or DEFAULT_ORG_ID)
    pid = str(principal.get("principal_id") or "").strip()
    ensure_scope_layout(org_scope_id(oid), base_dir=base_dir)
    if not pid:
        return scopes_root(base_dir)
    return ensure_scope_layout(personal_scope_id(pid), base_dir=base_dir)


def skill_roots_for_principal(
    principal: Principal | None,
    *,
    session_scope_id: str | None = None,
    base_dir: Path | None = None,
    ensure: bool = True,
) -> list[tuple[Path, str]]:
    """Return ``(skills_path, layer_label)`` for org / session / personal.

    Labels: ``org`` | ``group`` | ``personal`` (mapped to SkillScope by caller).
    """
    if principal is None:
        return []
    oid = str(principal.get("org_id") or DEFAULT_ORG_ID)
    pid = str(principal.get("principal_id") or "").strip()
    out: list[tuple[Path, str]] = []
    seen: set[Path] = set()

    def _add(scope: str, label: str) -> None:
        if ensure:
            ensure_scope_layout(scope, base_dir=base_dir)
        p = scope_skills_dir(scope, base_dir=base_dir)
        try:
            resolved = p.resolve()
        except OSError:
            resolved = p
        if resolved in seen:
            return
        seen.add(resolved)
        out.append((resolved, label))

    _add(org_scope_id(oid), "org")

    sid = str(session_scope_id or "").strip()
    if sid:
        try:
            kind, _ = parse_scope_id(sid)
        except ValueError:
            kind = ""
        if kind in {"group", "channel"}:
            _add(sid, "group")
        elif kind == "personal" and pid and sid == personal_scope_id(pid):
            pass  # added below

    if pid:
        _add(personal_scope_id(pid), "personal")

    return out


def writable_skills_root_for_principal(
    principal: Principal | None,
    *,
    base_dir: Path | None = None,
) -> Path | None:
    """Where new custom skills should be installed for this user."""
    if not principal:
        return None
    pid = str(principal.get("principal_id") or "").strip()
    if not pid:
        return None
    ensure_principal_home(principal, base_dir=base_dir)
    return scope_skills_dir(personal_scope_id(pid), base_dir=base_dir)
