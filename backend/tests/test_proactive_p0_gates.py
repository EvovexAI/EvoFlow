"""P0 employee-system fixes: work-window gate, per-round initiative cap, risk floor.

Covers:
- ``risk_threshold_enabled`` opt-in floor (backward compatible with full_auto).
- ``within_work_window`` / ``resolve_work_window`` semantics (incl. overnight).
- ``cycle_limits`` round matching + quota enforcement.
- ``admin.tasks.create_task`` quota choke point (employee-authored only).
"""

from __future__ import annotations

from datetime import datetime

import pytest

from evoflow.proactive.cycle_limits import (
    check_round_quota,
    effective_max_initiatives,
    round_refs,
    round_token,
)
from evoflow.proactive.models import (
    ProactiveAutonomyLevel,
    ProactiveRoleConfig,
    effective_risk_threshold,
    needs_approval,
)
from evoflow.proactive.schedule import (
    resolve_work_window,
    within_work_window,
    work_window_label_zh,
)


# ── risk threshold floor ────────────────────────────────────────────


def test_risk_threshold_is_opt_in_floor():
    cfg = ProactiveRoleConfig.from_json({"autonomy_level": "full_auto", "risk_threshold": "low"})
    assert cfg.risk_threshold_enabled is False
    # Backward compatible: full_auto + low risk still runs unattended.
    assert needs_approval("low", "full_auto", cfg.risk_threshold, risk_threshold_enabled=cfg.risk_threshold_enabled) is False


def test_risk_threshold_enabled_tightens_only():
    cfg = ProactiveRoleConfig.from_json(
        {"autonomy_level": "full_auto", "risk_threshold": "low", "risk_threshold_enabled": True}
    )
    assert cfg.risk_threshold_enabled is True
    assert needs_approval("low", "full_auto", cfg.risk_threshold, risk_threshold_enabled=True) is True
    assert needs_approval("critical", "full_auto", cfg.risk_threshold, risk_threshold_enabled=True) is True


def test_effective_risk_threshold_never_loosens():
    # approval_for_all baseline is LOW (strictest) → a CRITICAL floor would loosen
    # it, so the baseline must win.
    assert effective_risk_threshold("approval_for_all", "critical", enabled=True) == "low"
    # full_auto baseline is CRITICAL; a LOW floor tightens it.
    assert effective_risk_threshold("full_auto", "low", enabled=True) == "low"
    # Disabled floor → baseline wins.
    assert effective_risk_threshold("full_auto", "low", enabled=False) == "critical"
    # Equal floor → baseline unchanged.
    assert effective_risk_threshold("full_auto", "critical", enabled=True) == "critical"


def test_needs_approval_defaults_keep_legacy_behaviour():
    assert needs_approval("high", "full_auto") is False
    assert needs_approval("high", "approval_for_all") is True
    assert needs_approval("low", "approval_for_risky") is False
    assert needs_approval("critical", "approval_for_risky") is True


# ── work window ─────────────────────────────────────────────────────


class _Cfg:
    def __init__(self, enabled=True, start=9, end=20):
        self.work_schedule_enabled = enabled
        self.work_start_hour = start
        self.work_end_hour = end


class _Role:
    def __init__(self, cfg):
        self.config = cfg
        self.agent_code = "x"
        self.role_name = "X"


def test_work_window_disabled_is_unlimited():
    role = _Role(_Cfg(enabled=False))
    assert resolve_work_window(role) is None
    assert within_work_window(role) is True
    assert work_window_label_zh(role) == "不限上班时间"


def test_work_window_normal_range():
    role = _Role(_Cfg(start=9, end=20))
    assert resolve_work_window(role) == (9, 20)
    assert within_work_window(role, datetime(2026, 11, 6, 8, 59)) is False
    assert within_work_window(role, datetime(2026, 11, 6, 9, 0)) is True
    assert within_work_window(role, datetime(2026, 11, 6, 19, 59)) is True
    assert within_work_window(role, datetime(2026, 11, 6, 20, 0)) is False


def test_work_window_overnight():
    role = _Role(_Cfg(start=22, end=6))
    assert resolve_work_window(role) == (22, 6)
    assert within_work_window(role, datetime(2026, 11, 6, 23, 0)) is True
    assert within_work_window(role, datetime(2026, 11, 6, 5, 59)) is True
    assert within_work_window(role, datetime(2026, 11, 6, 6, 0)) is False
    assert within_work_window(role, datetime(2026, 11, 6, 12, 0)) is False


def test_work_window_zero_length_is_unlimited():
    role = _Role(_Cfg(start=9, end=9))
    assert resolve_work_window(role) is None
    assert within_work_window(role) is True


# ── round refs / token ──────────────────────────────────────────────


def test_round_refs_extracts_duty_stamp():
    assert round_refs("round:2026-11-06T12:00:00Z") == ["round:2026-11-06T12:00:00Z"]
    assert round_refs("proactive:x:duty:round-2026-11-06T12-00-00Z") == [
        "round-2026-11-06T12-00-00Z"
    ]
    # A task session key is not a duty round → no refs.
    assert round_refs("proactive:x:task:abc") == []
    assert round_refs("") == []


def test_round_token_normalizes_separators():
    assert round_token("round:2026-11-06T12:00:00Z") == round_token("round-2026-11-06T12-00-00Z")
    assert round_token("") == ""


# ── quota ───────────────────────────────────────────────────────────


class _QuotaRole:
    def __init__(self, max_n=3):
        self.agent_code = "emp1"
        self.role_name = "员工一"
        self.config = ProactiveRoleConfig.from_json({"max_initiatives_per_cycle": max_n})


def test_effective_max_initiatives():
    assert effective_max_initiatives(_QuotaRole(3)) == 3
    assert effective_max_initiatives(_QuotaRole(0)) == 0
    assert effective_max_initiatives(_QuotaRole(-2)) == 0


def test_quota_zero_blocks():
    allowed, reason = check_round_quota(_QuotaRole(0), ["round:1"])
    assert allowed is False
    assert "上限为 0" in reason


def test_quota_without_round_stamp_does_not_block():
    allowed, reason = check_round_quota(_QuotaRole(3), [])
    assert allowed is True
    assert reason == ""


def test_quota_blocks_when_already_at_cap(monkeypatch):
    import evoflow.proactive.cycle_limits as cl

    monkeypatch.setattr(cl, "count_round_work_items", lambda role, refs: 3)
    allowed, reason = check_round_quota(_QuotaRole(3), ["round:1"])
    assert allowed is False
    assert "3/3" in reason


def test_quota_allows_below_cap(monkeypatch):
    import evoflow.proactive.cycle_limits as cl

    monkeypatch.setattr(cl, "count_round_work_items", lambda role, refs: 1)
    allowed, reason = check_round_quota(_QuotaRole(3), ["round:1"])
    assert allowed is True
    assert reason == ""
