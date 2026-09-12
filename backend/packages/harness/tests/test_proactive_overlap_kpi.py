"""O5 overlap / lifecycle + O6 KPI classification tests."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest

from evoflow.proactive.kpi_checker import (
    assess_role_kpis,
    build_performance_report,
    classify_kpi_item,
    classify_kpi_text,
)
from evoflow.proactive.models import (
    ProactiveRole,
    ProactiveRoleConfig,
    normalize_role_status,
)
from evoflow.proactive.overlap import find_overlaps, score_role_overlap


def _role(code: str, *, resp: list[str], domain: list[str], name: str = "") -> ProactiveRole:
    return ProactiveRole(
        agent_code=code,
        role_name=name or code,
        status="active",
        config=ProactiveRoleConfig(responsibilities=resp, domain_scope=domain),
    )


def test_overlap_high_when_same_domain_and_similar_duty() -> None:
    existing = _role(
        "qa",
        name="前端质检",
        resp=["检查 login 页面 console 报错", "保证 lint 通过"],
        domain=["src/pages", "src/components"],
    )
    scored = score_role_overlap(
        {
            "responsibilities": ["检查 login 的 console 报错", "跑 lint"],
            "domain_scope": ["src/pages/login"],
            "role_name": "登录质检",
        },
        existing,
    )
    assert scored["overlap"] >= 0.5
    assert scored["high"] is True
    assert "前端质检" in scored["message"]


def test_overlap_low_for_unrelated_roles() -> None:
    existing = _role(
        "ops",
        name="运维",
        resp=["监控服务可用性", "处理告警"],
        domain=["infra/k8s"],
    )
    scored = score_role_overlap(
        {
            "responsibilities": ["写营销文案", "排期社媒"],
            "domain_scope": ["docs/marketing"],
        },
        existing,
    )
    assert scored["overlap"] < 0.5
    assert scored["high"] is False


def test_find_overlaps_skips_archived_draft_and_self() -> None:
    roles = [
        _role("a", resp=["检查 console 报错"], domain=["src/app"]),
        _role("b", resp=["检查 console 报错"], domain=["src/app"]),
        ProactiveRole(
            agent_code="c",
            role_name="archived twin",
            status="archived",
            config=ProactiveRoleConfig(
                responsibilities=["检查 console 报错"],
                domain_scope=["src/app"],
            ),
        ),
        ProactiveRole(
            agent_code="d",
            role_name="draft twin",
            status="draft",
            config=ProactiveRoleConfig(
                responsibilities=["检查 console 报错"],
                domain_scope=["src/app"],
            ),
        ),
    ]
    hits = find_overlaps(
        {"agent_code": "a", "responsibilities": ["检查 console 报错"], "domain_scope": ["src/app"]},
        roles,
        exclude_agent_code="a",
    )
    codes = {h["agent_code"] for h in hits}
    assert "b" in codes
    assert "a" not in codes
    assert "c" not in codes
    assert "d" not in codes


def test_normalize_role_status() -> None:
    assert normalize_role_status("draft") == "draft"
    assert normalize_role_status("ACTIVE") == "active"
    with pytest.raises(ValueError):
        normalize_role_status("zombie")


def test_classify_kpi_measurable_vs_subjective() -> None:
    m = classify_kpi_text("登录页 console error = 0")
    assert m.measurable is True
    assert m.status == "unknown"

    s = classify_kpi_text("页面体验好且美观")
    assert s.measurable is False
    assert s.status == "unmeasurable"


def test_classify_structured_kpi_dict() -> None:
    k = classify_kpi_item(
        {
            "name": "ESLint error 数",
            "target": 0,
            "metric_type": "command",
            "metric_command": "npx eslint .",
        }
    )
    assert k.measurable is True
    assert k.target == "0"
    assert k.probe == "eslint_count" or "探针" in k.detail or "不会自动执行" in k.detail


def test_file_exists_probe(tmp_path) -> None:
    from evoflow.proactive.kpi_checker import run_role_kpi_probes

    (tmp_path / "package-lock.json").write_text("{}", encoding="utf-8")
    role = ProactiveRole(
        agent_code="probe",
        role_name="P",
        config=ProactiveRoleConfig(
            workspace_path=str(tmp_path),
            kpis=[
                {
                    "name": "锁文件",
                    "probe": "file_exists",
                    "path": "package-lock.json",
                },
                {
                    "name": "缺失文件",
                    "probe": "file_exists",
                    "path": "no-such-file.xyz",
                },
            ],
        ),
    )
    results = run_role_kpi_probes(role)
    assert results[0].status == "pass"
    assert results[1].status == "fail"


def test_weekly_markdown_includes_kpis() -> None:
    from evoflow.proactive.kpi_checker import (
        KpiAssessment,
        PerformanceReport,
        format_weekly_report_markdown,
    )

    md = format_weekly_report_markdown(
        PerformanceReport(
            agent_code="a",
            role_name="前端",
            days=7,
            period_start="2026-07-10T00:00:00Z",
            period_end="2026-07-17T00:00:00Z",
            patrol_rounds=3,
            kpis=[
                KpiAssessment(name="eslint", measurable=True, status="pass", observed="0"),
            ],
            suggestion="继续推进",
        )
    )
    assert "履职周报" in md
    assert "eslint" in md
    assert "继续推进" in md


def test_assess_role_kpis_empty_config() -> None:
    role = ProactiveRole(agent_code="x", role_name="X", config=ProactiveRoleConfig())
    kpis = assess_role_kpis(role)
    assert len(kpis) == 1
    assert kpis[0].status == "unmeasurable"


def test_performance_report_filters_by_days_window() -> None:
    from evoflow.proactive.models import Initiative, InitiativeStatus

    now = datetime.now(timezone.utc)
    fresh = Initiative(
        id="new",
        role_agent_code="perf",
        title="fresh",
        description="",
        status=InitiativeStatus.COMPLETED,
        created_at=(now - timedelta(days=1)).isoformat().replace("+00:00", "Z"),
    )
    old = Initiative(
        id="old",
        role_agent_code="perf",
        title="stale",
        description="",
        status=InitiativeStatus.COMPLETED,
        created_at=(now - timedelta(days=30)).isoformat().replace("+00:00", "Z"),
    )
    role = ProactiveRole(
        agent_code="perf",
        role_name="Perf",
        config=ProactiveRoleConfig(kpis=["lint error = 0"]),
    )

    with (
        patch(
            "evoflow.proactive.repositories.ProactiveRepository.list_initiatives",
            return_value=[fresh, old],
        ),
        patch(
            "evoflow.proactive.repositories.ProactiveRepository.list_approvals",
            return_value=[],
        ),
        patch(
            "evoflow.proactive.repositories.ProactiveCostRepository.get_cost_summary",
            return_value={"total_cost_usd": 0.1, "total_tokens": 10},
        ),
        patch(
            "evoflow.proactive.repositories.ProactiveMemoryRepository.get",
            return_value=MagicMock(extra={}),
        ),
    ):
        report = build_performance_report(role, days=7)

    assert report.initiatives_total == 1
    assert report.completed == 1
    assert report.period_start
    assert report.period_end
    assert report.days == 7
