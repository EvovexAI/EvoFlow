"""Regression: automation runner must derive 5-field cron from RRULE schedules."""

from __future__ import annotations


def test_effective_cron_accepts_five_field() -> None:
    from app.gateway.automation_runner import _effective_cron

    assert _effective_cron({"schedule": "0 9 * * *"}) == "0 9 * * *"


def test_effective_cron_derives_from_schedule_rrule() -> None:
    from app.gateway.automation_runner import _effective_cron

    cron = _effective_cron({"schedule": "FREQ=DAILY;BYHOUR=9"})
    assert cron == "0 9 * * *"


def test_effective_cron_derives_from_rrule_field() -> None:
    from app.gateway.automation_runner import _effective_cron

    cron = _effective_cron({"schedule": "", "rrule": "FREQ=DAILY;BYHOUR=9;BYMINUTE=30"})
    assert cron == "30 9 * * *"


def test_effective_cron_accepts_rrule_prefix() -> None:
    from app.gateway.automation_runner import _effective_cron
    from evoflow.admin.automation_schedule import rrule_to_cron

    assert rrule_to_cron("RRULE:FREQ=DAILY;BYHOUR=9") == "0 9 * * *"
    cron = _effective_cron({"schedule": "RRULE:FREQ=HOURLY;INTERVAL=2"})
    assert cron == "0 */2 * * *"


def test_effective_cron_returns_none_when_underivable() -> None:
    from app.gateway.automation_runner import _effective_cron

    assert _effective_cron({"schedule": "FREQ=YEARLY"}) is None
    assert _effective_cron({"schedule": ""}) is None
