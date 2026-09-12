"""Idle patrol wrap text should not ping the user as a health report."""

from __future__ import annotations

from evoflow.proactive.feishu_notify import _is_idle_patrol_summary


def test_idle_patrol_summary_detects_health_theater():
    s = (
        "【巡检完成】2026-08-28 本轮值班。Gateway 8070 健康，本岗看板无未结 Task，"
        "5 个超时任务均已 cancel 闭环，代码质量无问题。结论：系统健康，无阻塞性待办。"
    )
    assert _is_idle_patrol_summary(s)
    assert _is_idle_patrol_summary("")
    assert _is_idle_patrol_summary("本轮无待办，系统健康。")


def test_idle_patrol_summary_keeps_actionable_user_asks():
    assert not _is_idle_patrol_summary("需要你确认报销方案是否上线，请拍板。")
    assert not _is_idle_patrol_summary("派发失败：下游 busy，请你决定是否改派。")
