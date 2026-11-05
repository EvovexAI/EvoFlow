"""create_agent rejects duplicate middleware.name — compaction must not re-add PreCall."""

from __future__ import annotations


def test_lead_middlewares_have_unique_names_with_compaction() -> None:
    from evoflow.agents.lead_agent.agent import (
        _build_middlewares,
        _create_context_compaction_middleware,
    )

    assert _create_context_compaction_middleware() is not None

    middlewares = _build_middlewares({"configurable": {}}, model_name=None, agent_name=None)
    names = [m.name for m in middlewares]
    assert len(names) == len(set(names)), sorted(
        n for n in set(names) if names.count(n) > 1
    )
    assert "PreCallGuardrailAgentMiddleware" in names
    assert "PostCompactionToolPairSanitizeMiddleware" in names
