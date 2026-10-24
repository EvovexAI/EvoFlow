"""Feishu WS account tagging: QR-bound employee must not fall through to main."""

from app.channels.feishu import resolve_feishu_ws_bootstrap_account_id


def test_instance_account_id_wins():
    assert (
        resolve_feishu_ws_bootstrap_account_id(
            instance_account_id="emp-a684a4f8",
            primary_app_id="cli_primary",
            primary_app_secret="sec",
            accounts={
                "emp-a684a4f8": {"app_id": "cli_emp", "app_secret": "emp_sec"},
            },
        )
        == "emp-a684a4f8"
    )


def test_merged_employee_creds_tag_ws_not_main():
    """ChannelService merge lifts employee app_id onto top-level → same-cred match."""
    accounts = {
        "emp-a684a4f8": {
            "app_id": "cli_aa56d1c5e5b89cfe",
            "app_secret": "secret-emp",
            "session": {"assistant_id": "emp-a684a4f8"},
        },
    }
    assert (
        resolve_feishu_ws_bootstrap_account_id(
            instance_account_id="",
            primary_app_id="cli_aa56d1c5e5b89cfe",
            primary_app_secret="secret-emp",
            accounts=accounts,
        )
        == "emp-a684a4f8"
    )


def test_distinct_settings_primary_stays_unlabeled():
    accounts = {
        "emp-a684a4f8": {
            "app_id": "cli_emp",
            "app_secret": "emp_sec",
        },
    }
    assert (
        resolve_feishu_ws_bootstrap_account_id(
            instance_account_id="",
            primary_app_id="cli_settings_primary",
            primary_app_secret="primary_sec",
            accounts=accounts,
        )
        == ""
    )


def test_accounts_only_bootstraps_first_employee():
    accounts = {
        "emp-a": {"app_id": "cli_a", "app_secret": "sa"},
        "emp-b": {"app_id": "cli_b", "app_secret": "sb"},
    }
    assert (
        resolve_feishu_ws_bootstrap_account_id(
            instance_account_id="",
            primary_app_id="",
            primary_app_secret="",
            accounts=accounts,
        )
        == "emp-a"
    )
