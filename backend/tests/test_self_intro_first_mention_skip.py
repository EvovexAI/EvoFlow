"""QR-bind open_id intro must not re-fire on the same private oc_ chat."""

from __future__ import annotations

from types import SimpleNamespace


def _role(*, intro_sent: dict | None = None, intro_sent_at: str = ""):
    cfg = SimpleNamespace(
        feishu_intro_sent=dict(intro_sent or {}),
        feishu_intro_sent_at=intro_sent_at,
    )
    return SimpleNamespace(config=cfg)


def test_skip_p2p_when_peer_open_id_already_introed(monkeypatch):
    from evoflow.proactive import self_intro as si

    role = _role(intro_sent={"open_id:ou_binder": "2026-10-29T14:15:18Z"})
    monkeypatch.setattr(
        "evoflow.proactive.repositories.ProactiveRepository.get_role",
        lambda _code: role,
    )
    assert si.should_skip_first_mention_intro(
        "douyin",
        chat_id="oc_private_chat",
        peer_open_id="ou_binder",
        chat_type="p2p",
    )


def test_skip_p2p_when_legacy_feishu_intro_sent_at(monkeypatch):
    from evoflow.proactive import self_intro as si

    role = _role(intro_sent_at="2026-10-29T14:15:18Z")
    monkeypatch.setattr(
        "evoflow.proactive.repositories.ProactiveRepository.get_role",
        lambda _code: role,
    )
    assert si.should_skip_first_mention_intro(
        "douyin",
        chat_id="oc_private_chat",
        peer_open_id="ou_other",
        chat_type="p2p",
    )


def test_group_still_allows_first_mention_after_bind(monkeypatch):
    from evoflow.proactive import self_intro as si

    role = _role(
        intro_sent={"open_id:ou_binder": "2026-10-29T14:15:18Z"},
        intro_sent_at="2026-10-29T14:15:18Z",
    )
    monkeypatch.setattr(
        "evoflow.proactive.repositories.ProactiveRepository.get_role",
        lambda _code: role,
    )
    assert not si.should_skip_first_mention_intro(
        "douyin",
        chat_id="oc_group_chat",
        peer_open_id="ou_binder",
        chat_type="group",
    )


def test_skip_when_same_chat_id_already_marked(monkeypatch):
    from evoflow.proactive import self_intro as si

    role = _role(intro_sent={"chat_id:oc_group_chat": "2026-10-29T14:20:00Z"})
    monkeypatch.setattr(
        "evoflow.proactive.repositories.ProactiveRepository.get_role",
        lambda _code: role,
    )
    assert si.should_skip_first_mention_intro(
        "douyin",
        chat_id="oc_group_chat",
        peer_open_id="ou_anyone",
        chat_type="group",
    )


def test_fresh_p2p_without_prior_intro_does_not_skip(monkeypatch):
    from evoflow.proactive import self_intro as si

    role = _role()
    monkeypatch.setattr(
        "evoflow.proactive.repositories.ProactiveRepository.get_role",
        lambda _code: role,
    )
    assert not si.should_skip_first_mention_intro(
        "douyin",
        chat_id="oc_new_private",
        peer_open_id="ou_new",
        chat_type="p2p",
    )
