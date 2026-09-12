"""Employee Feishu accounts must not silently become unlabeled primary credentials."""

from __future__ import annotations

from unittest.mock import patch

from evoflow.proactive.feishu_binding import _persist_feishu_accounts, sync_role_account_to_channel


def test_persist_feishu_accounts_does_not_copy_employee_into_primary():
    saved = {}

    def fake_update(channels):
        saved["channels"] = channels

    with (
        patch(
            "evoflow.proactive.feishu_binding._channels_section",
            return_value={"feishu": {"enabled": False, "app_id": "", "app_secret": ""}},
        ),
        patch(
            "evoflow.config.app_config.update_channels_section_and_save",
            side_effect=fake_update,
        ),
    ):
        _persist_feishu_accounts(
            {
                "literature_agent": {
                    "app_id": "cli_employee_bot",
                    "app_secret": "sec_employee",
                    "name": "文献检索员",
                }
            },
            ensure_enabled=True,
        )

    feishu = saved["channels"]["feishu"]
    assert feishu["enabled"] is True
    assert feishu["accounts"]["literature_agent"]["app_id"] == "cli_employee_bot"
    # Must not bootstrap employee creds into unlabeled primary.
    assert not str(feishu.get("app_id") or "").strip()
    assert not str(feishu.get("app_secret") or "").strip()


def test_sync_role_account_preserves_existing_primary():
    saved = {}

    def fake_update(channels):
        saved["channels"] = channels

    with (
        patch(
            "evoflow.proactive.feishu_binding._channels_section",
            return_value={
                "feishu": {
                    "enabled": True,
                    "app_id": "cli_primary",
                    "app_secret": "sec_primary",
                    "accounts": {},
                }
            },
        ),
        patch(
            "evoflow.config.app_config.update_channels_section_and_save",
            side_effect=fake_update,
        ),
    ):
        sync_role_account_to_channel(
            "literature_agent",
            app_id="cli_employee_bot",
            app_secret="sec_employee",
            open_id="ou_x",
            role_name="文献检索员",
        )

    feishu = saved["channels"]["feishu"]
    assert feishu["app_id"] == "cli_primary"
    assert feishu["app_secret"] == "sec_primary"
    assert feishu["accounts"]["literature_agent"]["app_id"] == "cli_employee_bot"
    assert feishu["accounts"]["literature_agent"]["session"]["assistant_id"] == "literature_agent"
