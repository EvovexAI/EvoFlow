"""Human identity + scope ACL (Phase 0/1 foundation)."""

from __future__ import annotations

from evoflow.authz.acl_store import (
    can_access_ref,
    encode_resource_ref,
    grant,
    handles_for_audience,
    list_grants_for_ref,
    parse_resource_ref,
    revoke,
)
from evoflow.authz.admin_grants import (
    is_org_admin,
    list_org_admins,
    promote_org_admin,
    revoke_org_admin,
)
from evoflow.authz.context import (
    build_authz_context,
    me_payload,
    resolve_request_authz,
    resolve_request_principal,
)
from evoflow.authz.membership import (
    add_scope_member,
    can_manage_scope,
    can_read_scope,
    can_write_scope,
    list_scope_members,
    remove_scope_member,
)
from evoflow.authz.mode import get_acl_mode, set_acl_mode, should_filter
from evoflow.authz.principals import (
    create_principal,
    get_or_create_local_admin,
    get_principal,
    list_principals,
    personal_scope_for,
    resolve_principal_by_identity,
)
from evoflow.authz.scope import (
    group_scope,
    org_scope,
    parse_scope_id,
    personal_scope,
    scope_id,
)
from evoflow.authz.types import DEFAULT_ORG_ID, AuthzContext, Grant, Principal

__all__ = [
    "DEFAULT_ORG_ID",
    "AuthzContext",
    "Grant",
    "Principal",
    "add_scope_member",
    "build_authz_context",
    "can_access_ref",
    "can_manage_scope",
    "can_read_scope",
    "can_write_scope",
    "create_principal",
    "encode_resource_ref",
    "get_acl_mode",
    "get_or_create_local_admin",
    "get_principal",
    "grant",
    "group_scope",
    "handles_for_audience",
    "is_org_admin",
    "list_grants_for_ref",
    "list_org_admins",
    "list_principals",
    "list_scope_members",
    "me_payload",
    "org_scope",
    "parse_resource_ref",
    "parse_scope_id",
    "personal_scope",
    "personal_scope_for",
    "promote_org_admin",
    "remove_scope_member",
    "resolve_principal_by_identity",
    "resolve_request_authz",
    "resolve_request_principal",
    "revoke",
    "revoke_org_admin",
    "scope_id",
    "set_acl_mode",
    "should_filter",
]
