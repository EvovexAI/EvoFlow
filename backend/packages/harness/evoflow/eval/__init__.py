"""EvoFlow Evaluation Module.

Real-data-driven evaluation center: business quality, security, performance,
and evaluation execution engine. No mock data — returns empty structures
when tables are missing.
"""

from __future__ import annotations

# Business quality
from evoflow.eval.business_quality import (
    evaluate_conversation_quality,
    evaluate_intervention_rate,
    evaluate_task_consistency,
    evaluate_task_quality,
    evaluate_tool_reliability,
    get_agent_ranking,
    get_failure_reasons,
)

# Dashboard aggregation
from evoflow.eval.dashboard import (
    get_dashboard_agents_ranking,
    get_dashboard_alerts,
    get_dashboard_summary,
    get_dashboard_trend,
)

# Data sources (real data collectors)
from evoflow.eval.data_sources import (
    get_conversation_stats,
    get_knowledge_stats,
    get_task_duration_distribution,
    get_task_stats,
    get_task_trend,
    get_tool_call_stats,
    get_tool_trend,
    list_task_rows,
    list_tool_call_rows,
)

# Eval engine
from evoflow.eval.eval_engine import (
    compare_evals,
    get_eval_progress,
    get_eval_run,
    list_eval_alerts,
    list_eval_cases,
    list_eval_runs,
    list_scenario_results,
    rerun_eval,
    run_eval,
)

# Performance
from evoflow.eval.performance import (
    get_error_stats,
    get_latency_distribution,
    get_latency_trend,
    get_module_latency_breakdown,
    get_performance_summary,
)

# Security
from evoflow.eval.security import (
    check_security_config,
    get_audit_stats,
    get_permission_matrix,
    get_security_summary,
    list_vulnerabilities,
    scan_data_leaks,
)

__all__ = [
    # data_sources
    "get_task_stats",
    "get_task_duration_distribution",
    "get_task_trend",
    "get_tool_call_stats",
    "get_tool_trend",
    "get_conversation_stats",
    "get_knowledge_stats",
    "list_task_rows",
    "list_tool_call_rows",
    # business_quality
    "evaluate_task_quality",
    "evaluate_tool_reliability",
    "evaluate_conversation_quality",
    "evaluate_intervention_rate",
    "evaluate_task_consistency",
    "get_agent_ranking",
    "get_failure_reasons",
    # security
    "get_security_summary",
    "get_permission_matrix",
    "scan_data_leaks",
    "list_vulnerabilities",
    "check_security_config",
    "get_audit_stats",
    # performance
    "get_performance_summary",
    "get_latency_distribution",
    "get_latency_trend",
    "get_module_latency_breakdown",
    "get_error_stats",
    # eval_engine
    "run_eval",
    "get_eval_run",
    "list_eval_runs",
    "list_eval_cases",
    "list_eval_alerts",
    "list_scenario_results",
    "get_eval_progress",
    "rerun_eval",
    "compare_evals",
    # dashboard
    "get_dashboard_summary",
    "get_dashboard_trend",
    "get_dashboard_alerts",
    "get_dashboard_agents_ranking",
]
