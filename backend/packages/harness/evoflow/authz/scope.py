"""ScopeId helpers: ``kind:ref`` encoding."""

from __future__ import annotations

from evoflow.authz.types import DEFAULT_ORG_ID, ScopeKind

_VALID_KINDS = frozenset({"org", "personal", "group", "channel", "team"})


def scope_id(kind: ScopeKind | str, ref: str) -> str:
    k = str(kind or "").strip()
    r = str(ref or "").strip()
    if not k or not r:
        raise ValueError("scope kind and ref are required")
    if k not in _VALID_KINDS:
        raise ValueError(f"invalid scope kind: {k}")
    # Ref may contain ':' (e.g. personal:webui:1, channel:feishu:oc_xxx).
    # Encoding always splits on the first ':' only — see parse_scope_id.
    return f"{k}:{r}"


def org_scope(org_id: str = DEFAULT_ORG_ID) -> str:
    return scope_id("org", org_id or DEFAULT_ORG_ID)


def personal_scope(principal_id: str) -> str:
    pid = str(principal_id or "").strip()
    if not pid:
        raise ValueError("principal_id required")
    return scope_id("personal", pid)


def group_scope(group_id: str) -> str:
    gid = str(group_id or "").strip()
    if not gid:
        raise ValueError("group_id required")
    return scope_id("group", gid)


def parse_scope_id(value: str) -> tuple[str, str]:
    raw = str(value or "").strip()
    if ":" not in raw:
        raise ValueError(f"invalid scope id: {value!r}")
    kind, ref = raw.split(":", 1)
    kind = kind.strip()
    ref = ref.strip()
    if kind not in _VALID_KINDS or not ref:
        raise ValueError(f"invalid scope id: {value!r}")
    return kind, ref


def is_shared_scope(value: str) -> bool:
    try:
        kind, _ = parse_scope_id(value)
    except ValueError:
        return False
    return kind in {"group", "channel"}
