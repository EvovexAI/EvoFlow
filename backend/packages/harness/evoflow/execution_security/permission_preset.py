"""Session approval presets — unified sandbox profile + AskForApproval + tool gate.

Preset table (sandbox profile + approval policy):

| preset id    | UI    | PermissionProfile      | AskForApproval |
|--------------|--------------|------------------------|----------------|
| read-only    | Read Only    | read-only (FS read)    | on-request     |
| default      | Default      | workspace              | on-request     |
| full-access  | Full Access  | disabled (no OS jail)  | never          |
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from evoflow.execution_security.approval import AskForApproval
from evoflow.execution_security.profiles import (
    PROFILE_DANGER_FULL_ACCESS,
    PROFILE_READ_ONLY,
    PROFILE_WORKSPACE,
)
from evoflow.persistence.tool_approval_policy import (
    POLICY_GRANT_ALL,
    POLICY_PROMPT,
    POLICY_SESSION,
)

PermissionPresetId = Literal["read-only", "default", "full-access"]

PRESET_READ_ONLY: PermissionPresetId = "read-only"
PRESET_DEFAULT: PermissionPresetId = "default"
PRESET_FULL_ACCESS: PermissionPresetId = "full-access"

VALID_PRESETS = frozenset({PRESET_READ_ONLY, PRESET_DEFAULT, PRESET_FULL_ACCESS})

_ALIASES = {
    "readonly": PRESET_READ_ONLY,
    "read_only": PRESET_READ_ONLY,
    "auto": PRESET_DEFAULT,
    "workspace": PRESET_DEFAULT,
    "agent": PRESET_DEFAULT,
    "full_access": PRESET_FULL_ACCESS,
    "danger-full-access": PRESET_FULL_ACCESS,
    "grant_all": PRESET_FULL_ACCESS,
}


@dataclass(frozen=True)
class PermissionPresetSpec:
    id: PermissionPresetId
    label_zh: str
    label_en: str
    desc_zh: str
    tool_approval_policy: str
    execution_profile: str
    execution_approval: AskForApproval
    """When false (Read Only), signature grants never auto-run gated tools."""
    signature_grants_enabled: bool


PRESET_SPECS: dict[PermissionPresetId, PermissionPresetSpec] = {
    PRESET_READ_ONLY: PermissionPresetSpec(
        id=PRESET_READ_ONLY,
        label_zh="只读",
        label_en="Read Only",
        desc_zh="可读工作区；改文件 / 跑命令需确认；OS 只读沙箱",
        tool_approval_policy=POLICY_PROMPT,
        execution_profile=PROFILE_READ_ONLY,
        execution_approval=AskForApproval.ON_REQUEST,
        signature_grants_enabled=False,
    ),
    PRESET_DEFAULT: PermissionPresetSpec(
        id=PRESET_DEFAULT,
        label_zh="默认",
        label_en="Default",
        desc_zh="可读写工作区；敏感操作按需确认（会话 Agent 模式）",
        tool_approval_policy=POLICY_SESSION,
        execution_profile=PROFILE_WORKSPACE,
        execution_approval=AskForApproval.ON_REQUEST,
        signature_grants_enabled=True,
    ),
    PRESET_FULL_ACCESS: PermissionPresetSpec(
        id=PRESET_FULL_ACCESS,
        label_zh="完全访问",
        label_en="Full Access",
        desc_zh="关闭 OS 沙箱隔离；本会话不再弹出工具审批",
        tool_approval_policy=POLICY_GRANT_ALL,
        execution_profile=PROFILE_DANGER_FULL_ACCESS,
        execution_approval=AskForApproval.NEVER,
        signature_grants_enabled=True,
    ),
}


def normalize_preset_id(raw: str | None) -> PermissionPresetId:
    s = str(raw or "").strip().lower()
    if not s:
        return PRESET_DEFAULT
    s = _ALIASES.get(s, s)
    if s in VALID_PRESETS:
        return s  # type: ignore[return-value]
    return PRESET_DEFAULT


def preset_spec(preset_id: str | None) -> PermissionPresetSpec:
    return PRESET_SPECS[normalize_preset_id(preset_id)]


def preset_from_legacy_tool_policy(policy: str | None) -> PermissionPresetId:
    m = str(policy or "").strip().lower()
    if m == POLICY_GRANT_ALL:
        return PRESET_FULL_ACCESS
    if m == POLICY_PROMPT:
        return PRESET_READ_ONLY
    return PRESET_DEFAULT


def preset_list_for_api() -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for pid in (PRESET_READ_ONLY, PRESET_DEFAULT, PRESET_FULL_ACCESS):
        spec = PRESET_SPECS[pid]
        out.append(
            {
                "id": spec.id,
                "label_zh": spec.label_zh,
                "label_en": spec.label_en,
                "desc_zh": spec.desc_zh,
                "tool_approval_policy": spec.tool_approval_policy,
                "execution_profile": spec.execution_profile,
                "execution_approval": spec.execution_approval.value,
            }
        )
    return out
