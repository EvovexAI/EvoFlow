"""Deleting an employee must purge Feishu/WeCom bindings (no zombie rebind).

Regression (2026-11-08 / 2026-11-10): ``employees.delete`` left
``evoflow_bot_bindings`` + ``channels.*.accounts`` intact; channel restart
re-migrated the zombie from stale JSON / memory.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest


def test_purge_im_bindings_calls_feishu_and_wecom(monkeypatch):
    from evoflow.admin import employees as emp

    calls: list[tuple[str, str]] = []

    monkeypatch.setattr(
        "evoflow.proactive.feishu_binding.remove_role_account_from_channel",
        lambda code: calls.append(("feishu", code)) or True,
    )
    monkeypatch.setattr(
        "evoflow.proactive.wecom_binding.remove_role_account_from_channel",
        lambda code: calls.append(("wecom", code)) or True,
    )
    scheduled: list[tuple[str, str]] = []
    service = SimpleNamespace(
        schedule_stop_account_instance=lambda plat, code: scheduled.append((plat, code))
    )
    monkeypatch.setattr(
        "evoflow.runtime.ports.get_channel_service",
        lambda: service,
    )

    out = emp._purge_im_bindings_for_role("product-support")
    assert out == {"feishu": True, "wecom": True}
    assert ("feishu", "product-support") in calls
    assert ("wecom", "product-support") in calls
    assert ("feishu", "product-support") in scheduled
    assert ("wecom", "product-support") in scheduled


def test_migrate_legacy_skips_deleted_employee(monkeypatch):
    from app.channels.service import ChannelService

    upserts: list[dict] = []

    monkeypatch.setattr(
        "evoflow.persistence.config_repositories.list_bot_bindings",
        lambda _plat, enabled_only=True: [],
    )
    monkeypatch.setattr(
        "evoflow.persistence.config_repositories.upsert_bot_binding",
        lambda **kwargs: upserts.append(kwargs),
    )
    monkeypatch.setattr(
        ChannelService,
        "_employee_role_exists",
        staticmethod(lambda code: code != "product-support"),
    )

    svc = ChannelService.__new__(ChannelService)
    svc._migrate_legacy_accounts_to_table(
        "feishu",
        {
            "product-support": {"app_id": "cli_dead", "app_secret": "sec"},
            "live-notes-keeper": {"app_id": "cli_live", "app_secret": "sec2"},
        },
    )
    assert len(upserts) == 1
    assert upserts[0]["agent_code"] == "live-notes-keeper"
    assert upserts[0]["bot_id"] == "cli_live"


@pytest.mark.asyncio
async def test_stop_account_instance_drops_memory_slot():
    from app.channels.service import ChannelService

    class _Ch:
        def __init__(self) -> None:
            self.stopped = False

        async def stop(self) -> None:
            self.stopped = True

    svc = ChannelService.__new__(ChannelService)
    ch = _Ch()
    svc._channels = {"feishu:product-support": ch}
    svc._config = {
        "feishu": {
            "enabled": True,
            "accounts": {
                "product-support": {"app_id": "cli_x"},
                "other": {"app_id": "cli_y"},
            },
        }
    }

    ok = await svc.stop_account_instance("feishu", "product-support")
    assert ok is True
    assert ch.stopped is True
    assert "feishu:product-support" not in svc._channels
    assert "product-support" not in svc._config["feishu"]["accounts"]
    assert "other" in svc._config["feishu"]["accounts"]
