"""Host OS execution security (PermissionProfile / AskForApproval / sandbox runner).

Reuses open-source sandbox protocol shapes and optional helper binaries.
runtime CLI is not a product upstream.
"""

from __future__ import annotations

from evoflow.execution_security.approval import (
    AskForApproval,
    ApprovalDecision,
    decide_shell_approval,
    map_evoflow_policy_to_ask,
)
from evoflow.execution_security.config import (
    ExecutionSecurityConfig,
    get_execution_security_config,
    is_execution_security_active,
    load_execution_security_config_from_dict,
    set_execution_security_config,
)
from evoflow.execution_security.errors import (
    ExecutionSecurityError,
    HelperUnavailable,
    PolicyDenied,
    SandboxDenied,
    UserDenied,
)
from evoflow.execution_security.helpers import HelperPaths, discover_helpers
from evoflow.execution_security.profiles import (
    PROFILE_DANGER_FULL_ACCESS,
    PROFILE_READ_ONLY,
    PROFILE_WORKSPACE,
    PermissionProfileId,
    build_permission_profile_json,
    normalize_profile_id,
    permission_profile_to_json_str,
)
from evoflow.execution_security.runner import SandboxRunResult, run_sandboxed
from evoflow.execution_security.status import execution_security_status

# persist is intentionally NOT imported here — it pulls SQLite / app_config and
# would circular-import when ``from evoflow.execution_security.config import …``.
# Import from ``evoflow.execution_security.persist`` directly when needed.

__all__ = [
    "AskForApproval",
    "ApprovalDecision",
    "ExecutionSecurityConfig",
    "ExecutionSecurityError",
    "HelperPaths",
    "HelperUnavailable",
    "PROFILE_DANGER_FULL_ACCESS",
    "PROFILE_READ_ONLY",
    "PROFILE_WORKSPACE",
    "PermissionProfileId",
    "PolicyDenied",
    "SandboxDenied",
    "SandboxRunResult",
    "UserDenied",
    "build_permission_profile_json",
    "decide_shell_approval",
    "discover_helpers",
    "execution_security_status",
    "get_execution_security_config",
    "is_execution_security_active",
    "load_execution_security_config_from_dict",
    "map_evoflow_policy_to_ask",
    "normalize_profile_id",
    "permission_profile_to_json_str",
    "run_sandboxed",
    "set_execution_security_config",
]
