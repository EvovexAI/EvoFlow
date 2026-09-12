from evoflow.config.code_index_config import CodeIndexConfig, get_code_index_config
from evoflow.config.session_intent_config import SessionIntentConfig, get_session_intent_config


def test_code_index_lsp_defaults_enabled():
    cfg = CodeIndexConfig()
    assert cfg.lsp_enabled is True
    assert cfg.lsp_prefer is True
    assert len(cfg.lsp_profiles) >= 2


def test_session_intent_llm_rollup_default_off():
    cfg = SessionIntentConfig()
    assert cfg.llm_rollup_enabled is False
    assert cfg.llm_rollup_min_chars == 120
    assert get_session_intent_config().llm_rollup_enabled is False
    assert get_code_index_config().lsp_enabled is True
