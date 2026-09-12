"""Ensure proactive ACL helper _require_role_agent exists and gates empty codes."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException


def test_require_role_agent_rejects_empty_code():
    from evoflow.proactive import router as proactive_router

    with pytest.raises(HTTPException) as ei:
        proactive_router._require_role_agent(MagicMock(), "")
    assert ei.value.status_code == 422
    assert "agent_code" in str(ei.value.detail)


def test_require_role_agent_delegates_to_agent_visibility(monkeypatch: pytest.MonkeyPatch):
    from evoflow.authz import http_guard
    from evoflow.proactive import router as proactive_router

    seen: list[str] = []

    def _fake_visible(request, code):  # noqa: ANN001
        seen.append(str(code))

    monkeypatch.setattr(http_guard, "require_agent_visible", _fake_visible)
    proactive_router._require_role_agent(MagicMock(), "demo-agent")
    assert seen == ["demo-agent"]
