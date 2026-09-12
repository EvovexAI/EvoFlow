"""Panel setting ``knowledgeMapEnabled`` gates exploration graph runtime."""

from __future__ import annotations

from evoflow.exploration_graph.config import is_exploration_graph_enabled, load_exploration_graph_config_from_dict


def test_is_exploration_graph_enabled_respects_panel_setting(monkeypatch) -> None:
    load_exploration_graph_config_from_dict({"enabled": True})
    from evoflow.persistence import panel_settings as ps

    monkeypatch.setattr(ps, "get_panel_settings", lambda: {"knowledgeMapEnabled": True})
    assert is_exploration_graph_enabled() is True

    monkeypatch.setattr(ps, "get_panel_settings", lambda: {"knowledgeMapEnabled": False})
    assert is_exploration_graph_enabled() is False


def test_strip_mind_map_tools_when_disabled(monkeypatch) -> None:
    from evoflow.agents.lead_agent.agent import _strip_mind_map_tools
    from evoflow.persistence import panel_settings as ps

    class _Tool:
        def __init__(self, name: str) -> None:
            self.name = name

    tools = [_Tool("read"), _Tool("mind_map"), _Tool("worker")]
    monkeypatch.setattr(ps, "get_panel_settings", lambda: {"knowledgeMapEnabled": True})
    kept = _strip_mind_map_tools(tools)
    assert [t.name for t in kept] == ["read", "mind_map", "worker"]

    monkeypatch.setattr(ps, "get_panel_settings", lambda: {"knowledgeMapEnabled": False})
    kept = _strip_mind_map_tools(tools)
    assert [t.name for t in kept] == ["read", "worker"]
