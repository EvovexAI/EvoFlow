"""Regression: TokenUsageMiddleware must be importable when building lead agent middlewares."""

from __future__ import annotations


def test_lead_agent_exports_token_usage_middleware() -> None:
    from evoflow.agents.lead_agent import agent as lead_agent

    assert getattr(lead_agent, "TokenUsageMiddleware", None) is not None
