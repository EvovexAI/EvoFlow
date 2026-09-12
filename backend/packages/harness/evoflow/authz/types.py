"""Scope ACL types (human identity / authz)."""

from __future__ import annotations

from typing import Literal, TypedDict

PrincipalType = Literal["internal", "guest", "service"]
Permission = Literal["read", "write"]
ScopeKind = Literal["org", "personal", "group", "channel", "team"]
AdminRole = Literal["org_admin"]
MemberRole = Literal["member", "manager"]

DEFAULT_ORG_ID = "local"


class Principal(TypedDict, total=False):
    principal_id: str
    org_id: str
    principal_type: PrincipalType
    display_name: str
    primary_email: str | None
    status: str
    team_ids: list[str]
    attrs: dict


class Grant(TypedDict):
    org_id: str
    owner_scope_id: str
    ref: str
    grantee_scope_id: str
    permission: Permission
    granted_by: str
    created_at: float


class AuthzContext(TypedDict, total=False):
    org_id: str
    principal: Principal
    session_key: str | None
    scope_id: str
    audience: list[Principal]
    is_org_admin: bool
