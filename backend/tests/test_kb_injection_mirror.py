"""kb_injection hire mirror must land on agent extra_json (no silent defaults)."""

from __future__ import annotations

import pytest

from evoflow.config.agents_config import KbInjectionConfig


def test_kb_injection_from_dict_accepts_camel_case():
    cfg = KbInjectionConfig.from_dict({"mode": "agent", "topK": 8, "agentTopK": 6})
    assert cfg.mode == "agent"
    assert cfg.top_k == 8
    assert cfg.agent_top_k == 6


def test_safe_kb_injection_rejects_non_object():
    from evoflow.admin.employees import _safe_kb_injection
    from evoflow.admin.errors import ValidationError

    with pytest.raises(ValidationError):
        _safe_kb_injection("agent")


def test_persist_agent_kb_injection_raises_when_upsert_misses(monkeypatch):
    from evoflow.admin import employees as emp
    from evoflow.admin.errors import ValidationError

    monkeypatch.setattr(
        "evoflow.persistence.config_repositories.get_agent_extra_json",
        lambda _code: {},
    )
    monkeypatch.setattr(
        "evoflow.persistence.config_repositories.upsert_agent_extra_json",
        lambda _code, _extra: False,
    )
    with pytest.raises(ValidationError, match="写入 agent"):
        emp._persist_agent_kb_injection("smart-customer-service", {"mode": "agent", "top_k": 8})


def test_persist_agent_kb_injection_read_after_write(monkeypatch):
    from evoflow.admin import employees as emp
    from evoflow.config.agents_config import KbInjectionConfig

    store: dict = {}

    def _get(code):
        return dict(store.get(code) or {})

    def _upsert(code, extra):
        store[code] = dict(extra or {})
        return True

    monkeypatch.setattr(
        "evoflow.persistence.config_repositories.get_agent_extra_json",
        _get,
    )
    monkeypatch.setattr(
        "evoflow.persistence.config_repositories.upsert_agent_extra_json",
        _upsert,
    )
    # get_agent_kb_injection_config reads via get_agent_extra_json — already patched.
    emp._persist_agent_kb_injection(
        "smart-customer-service",
        {"mode": "agent", "top_k": 8},
    )
    got = KbInjectionConfig.from_dict(store["smart-customer-service"]["kb_injection"])
    assert got.mode == "agent"
    assert got.top_k == 8
