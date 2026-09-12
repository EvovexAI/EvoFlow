"""Feishu self-intro must persist a durable marker (not only in-memory)."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from evoflow.proactive.models import ProactiveRoleConfig
from evoflow.proactive.self_intro import (
    has_intro_been_sent,
    intro_sent_key,
    mark_intro_sent,
)


def test_intro_sent_key_stable():
    assert intro_sent_key(receive_id="ou_abc", receive_id_type="open_id") == "open_id:ou_abc"
    assert intro_sent_key(receive_id="oc_xyz", receive_id_type="chat_id") == "chat_id:oc_xyz"


def test_has_intro_been_sent_reads_dict_and_legacy_field():
    cfg = ProactiveRoleConfig(
        feishu_intro_sent={"open_id:ou_1": "2026-01-01T00:00:00Z"},
        feishu_intro_sent_at="2026-01-02T00:00:00Z",
    )
    role = MagicMock()
    role.config = cfg

    with patch("evoflow.proactive.repositories.ProactiveRepository.get_role", return_value=role):
        assert has_intro_been_sent("agent_a", receive_id="ou_1", receive_id_type="open_id")
        assert not has_intro_been_sent("agent_a", receive_id="ou_other", receive_id_type="open_id")
        # Legacy field covers any open_id when dict miss
        cfg.feishu_intro_sent = {}
        assert has_intro_been_sent("agent_a", receive_id="ou_other", receive_id_type="open_id")
        assert not has_intro_been_sent("agent_a", receive_id="oc_chat", receive_id_type="chat_id")


def test_mark_intro_sent_persists_dict_and_open_id_legacy():
    cfg = ProactiveRoleConfig()
    role = MagicMock()
    role.config = cfg
    saved = []

    def _save(r):
        saved.append(dict(r.config.feishu_intro_sent))
        saved.append(r.config.feishu_intro_sent_at)

    with (
        patch("evoflow.proactive.repositories.ProactiveRepository.get_role", return_value=role),
        patch("evoflow.proactive.repositories.ProactiveRepository.save_role", side_effect=_save),
    ):
        mark_intro_sent("agent_a", receive_id="ou_9", receive_id_type="open_id")

    assert "open_id:ou_9" in cfg.feishu_intro_sent
    assert cfg.feishu_intro_sent_at
    assert saved


def test_role_config_roundtrip_feishu_intro_sent():
    cfg = ProactiveRoleConfig(feishu_intro_sent={"chat_id:oc_1": "2026-08-01T12:00:00Z"})
    raw = cfg.to_json()
    restored = ProactiveRoleConfig.from_json(raw)
    assert restored.feishu_intro_sent == {"chat_id:oc_1": "2026-08-01T12:00:00Z"}
