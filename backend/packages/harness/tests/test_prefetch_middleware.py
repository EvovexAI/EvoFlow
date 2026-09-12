"""Turn-level prefetch middleware is deprecated; reads follow search_code_index only."""

from evoflow.config.agent_orchestration_config import get_agent_orchestration_config


def test_prefetch_disabled_by_default():
    cfg = get_agent_orchestration_config()
    assert cfg.hybrid.prefetch_enabled is False
