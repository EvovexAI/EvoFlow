"""Tests for runtime permission preset mapping."""

from __future__ import annotations

import pytest

from evoflow.execution_security.approval import AskForApproval
from evoflow.execution_security.permission_preset import (
    PRESET_DEFAULT,
    PRESET_FULL_ACCESS,
    PRESET_READ_ONLY,
    normalize_preset_id,
    preset_from_legacy_tool_policy,
    preset_spec,
)
from evoflow.persistence.tool_approval_policy import (
    POLICY_GRANT_ALL,
    POLICY_PROMPT,
    POLICY_SESSION,
)


def test_normalize_preset_aliases():
    assert normalize_preset_id("auto") == PRESET_DEFAULT
    assert normalize_preset_id("read_only") == PRESET_READ_ONLY
    assert normalize_preset_id("full-access") == PRESET_FULL_ACCESS


def test_preset_spec_fields():
    ro = preset_spec(PRESET_READ_ONLY)
    assert ro.execution_profile == "read-only"
    assert ro.execution_approval is AskForApproval.ON_REQUEST
    assert ro.tool_approval_policy == POLICY_PROMPT
    assert ro.signature_grants_enabled is False

    default = preset_spec(PRESET_DEFAULT)
    assert default.execution_profile == "workspace"
    assert default.tool_approval_policy == POLICY_SESSION
    assert default.signature_grants_enabled is True

    full = preset_spec(PRESET_FULL_ACCESS)
    assert full.execution_profile == "danger-full-access"
    assert full.execution_approval is AskForApproval.NEVER
    assert full.tool_approval_policy == POLICY_GRANT_ALL


def test_legacy_policy_maps_to_preset():
    assert preset_from_legacy_tool_policy(POLICY_GRANT_ALL) == PRESET_FULL_ACCESS
    assert preset_from_legacy_tool_policy(POLICY_PROMPT) == PRESET_READ_ONLY
    assert preset_from_legacy_tool_policy(POLICY_SESSION) == PRESET_DEFAULT
