"""SOUL / system_prompt edits must invalidate same-session DynamicSystemPrompt cache."""

from __future__ import annotations

from evoflow.agents.middlewares import dynamic_system_prompt_middleware as dsp


def test_invalidate_clears_thread_and_role_caches():
    dsp.DynamicSystemPromptOnScenarioMiddleware._last_sig_by_thread["t1"] = "sig"
    dsp.DynamicSystemPromptOnScenarioMiddleware._last_system_by_thread["t1"] = "old system"
    dsp._ROLE_DISK_SIG_CACHE["main"] = (0.0, "file")
    dsp.invalidate_dynamic_system_prompt_cache(agent_code="main")
    assert dsp.DynamicSystemPromptOnScenarioMiddleware._last_sig_by_thread == {}
    assert dsp.DynamicSystemPromptOnScenarioMiddleware._last_system_by_thread == {}
    assert dsp._ROLE_DISK_SIG_CACHE == {}


def test_role_signature_includes_db_revision(monkeypatch):
    monkeypatch.setattr(dsp, "_ROLE_DISK_SIG_CACHE", {})
    monkeypatch.setattr(
        "evoflow.persistence.config_repositories.get_agent_prompt_revision",
        lambda code: f"rev-for-{code}",
    )

    class _Paths:
        def agent_dir(self, _code):
            from pathlib import Path

            return Path("/tmp/missing-agent-dir-for-test")

    monkeypatch.setattr("evoflow.config.paths.get_paths", lambda: _Paths())
    sig = dsp._agent_role_disk_signature("main")
    assert sig.endswith("|db:rev-for-main")
