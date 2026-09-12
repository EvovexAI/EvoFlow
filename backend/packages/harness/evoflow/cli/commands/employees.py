"""evoflow employees — hire / update / observe / dispatch proactive AI employees."""

from __future__ import annotations

import argparse

from evoflow.admin import employees as employees_admin
from evoflow.admin.errors import ValidationError
from evoflow.cli.common import add_json_input_flags, add_output_flags, load_json_payload


def register(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser(
        "employees",
        help="Manage / observe proactive AI employees (智能体员工岗位)",
    )
    sub = parser.add_subparsers(dest="employees_cmd", required=True)

    list_p = sub.add_parser("list", help="Roster: status, busy, pending approvals")
    list_p.add_argument("--status", default="", help="Filter: active|paused|archived|draft")
    list_p.add_argument("--include-archived", action="store_true", help="Include archived roles")
    add_output_flags(list_p)
    list_p.set_defaults(handler=_list)

    get_p = sub.add_parser("get", help="Get one employee role + recent initiatives")
    get_p.add_argument("agent_code", help="Employee agent_code")
    get_p.add_argument("--recent", type=int, default=10, help="Recent initiatives limit")
    add_output_flags(get_p)
    get_p.set_defaults(handler=_get)

    hire_p = sub.add_parser(
        "hire",
        help="Hire an existing Agent as a duty employee (岗位)",
        description=(
            "JSON payload fields:\n"
            "  agent_code (required)         Must already exist (evoflow agents create)\n"
            "  role_name                     Display name (default: agent_name)\n"
            "  department, responsibilities, domain_scope, kpis\n"
            "  reports_to                  Direct manager agent_code (empty = top-level)\n"
            "  workspace_path                Bound workspace absolute path\n"
            "  autonomy_level                full_auto|approval_for_risky|approval_for_all\n"
            "  risk_threshold                low|medium|high|critical\n"
            "  heartbeat_rrule               e.g. FREQ=HOURLY;INTERVAL=2\n"
            "  status                        active|paused|draft (default active)\n"
            "  max_turns, timeout_seconds, model_name, skills, tool_groups\n"
            "  work_schedule_enabled, work_start_hour, work_end_hour\n"
            "  daily_budget_usd, approval_timeout_minutes, …\n"
            "See examples/employees-hire.json"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    add_json_input_flags(hire_p)
    add_output_flags(hire_p)
    hire_p.set_defaults(handler=_hire)

    update_p = sub.add_parser(
        "update",
        help="Update employee / 岗位 config (partial JSON)",
        description="Partial JSON patch — same fields as hire except agent_code. "
        "See examples/employees-update.json",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    update_p.add_argument("agent_code", help="Employee agent_code")
    add_json_input_flags(update_p)
    add_output_flags(update_p)
    update_p.set_defaults(handler=_update)

    pause_p = sub.add_parser("pause", help="Pause employee (stop auto patrol)")
    pause_p.add_argument("agent_code")
    add_output_flags(pause_p)
    pause_p.set_defaults(handler=_pause)

    stop_p = sub.add_parser("stop", help="Stop in-flight work only (keep active)")
    stop_p.add_argument("agent_code")
    add_output_flags(stop_p)
    stop_p.set_defaults(handler=_stop)

    resume_p = sub.add_parser("resume", help="Resume employee to active (上岗)")
    resume_p.add_argument("agent_code")
    add_output_flags(resume_p)
    resume_p.set_defaults(handler=_resume)

    archive_p = sub.add_parser("archive", help="Soft-archive employee (leave roster)")
    archive_p.add_argument("agent_code")
    add_output_flags(archive_p)
    archive_p.set_defaults(handler=_archive)

    worklog_p = sub.add_parser("worklog", help="Day work log grouped by duty round")
    worklog_p.add_argument("agent_code", help="Employee agent_code")
    worklog_p.add_argument("--day", default="", help="YYYY-MM-DD (default: today)")
    worklog_p.add_argument("--limit", type=int, default=80, help="Max initiatives to scan")
    add_output_flags(worklog_p)
    worklog_p.set_defaults(handler=_worklog)

    trail_p = sub.add_parser("trail", help="Tool-call trail summary for a duty round")
    trail_p.add_argument("agent_code", help="Employee agent_code")
    trail_p.add_argument("--round-id", default="", help="Duty round id (default: latest)")
    trail_p.add_argument("--max-steps", type=int, default=40, help="Max tool steps to return")
    add_output_flags(trail_p)
    trail_p.set_defaults(handler=_trail)

    dispatch_p = sub.add_parser(
        "dispatch",
        help="Dispatch a goal to an employee by agent_code (requires Gateway)",
    )
    dispatch_p.add_argument("agent_code", help="Employee agent_code")
    dispatch_p.add_argument("--goal", "-g", required=True, help="Task goal for this round")
    dispatch_p.add_argument("--description", default="", help="Optional detail")
    dispatch_p.add_argument("--priority", default="normal", help="normal|high|low")
    dispatch_p.add_argument("--source", default="role", help="Dispatch source label (maps to 任务来源 role)")
    dispatch_p.add_argument(
        "--round-id",
        default="",
        help="Continue an existing duty round_id (same work trail)",
    )
    dispatch_p.add_argument(
        "--resume-round",
        action="store_true",
        help="With --task-id / related task: reuse that Task's round_id",
    )
    dispatch_p.add_argument(
        "--fresh-round",
        action="store_true",
        help="Force a new dispatch:… round even when resuming a Task",
    )
    dispatch_p.add_argument("--task-id", default="", help="Optional related Task id to reuse")
    add_output_flags(dispatch_p)
    dispatch_p.set_defaults(handler=_dispatch)

    wake_p = sub.add_parser(
        "wake",
        help="Wake / @ a teammate by agent_code or role_name (requires Gateway)",
        description=(
            "Cross-role @：解析岗位名或 agent_code，再叫醒对方值班。\n"
            "例：\n"
            '  evoflow employees wake 技术总监 --from product-manager \\\n'
            '    --goal "处理 Task_xxx：按 outputs/organic-handoff-plan.md 出技术方案"\n'
            "  evoflow employees wake quality-inspector --from product-manager --task-id Task_xxx\n"
            "底层仍走 Gateway /dispatch；organization 边界见值班 brief（同 workspace）。"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    wake_p.add_argument("target", help="Target agent_code or role_name (e.g. quality-inspector / 技术总监)")
    wake_p.add_argument("--goal", "-g", default="", help="Goal for their duty round")
    wake_p.add_argument("--from", dest="from_agent", default="", help="Your agent_code or role_name (woken_by)")
    wake_p.add_argument("--task-id", default="", help="Optional Task id; used to build goal if --goal omitted")
    wake_p.add_argument("--description", default="", help="Optional detail")
    wake_p.add_argument("--priority", default="normal", help="normal|high|low")
    wake_p.add_argument("--source", default="role", help="Dispatch source label")
    wake_p.add_argument(
        "--round-id",
        default="",
        help="Continue an existing duty round_id (same work trail)",
    )
    wake_p.add_argument(
        "--resume-round",
        action="store_true",
        help="With --task-id: reuse that Task's round_id / source_ref",
    )
    wake_p.add_argument(
        "--fresh-round",
        action="store_true",
        help="Force a new dispatch:… round (do not continue trail)",
    )
    add_output_flags(wake_p)
    wake_p.set_defaults(handler=_wake)

    migrate_p = sub.add_parser(
        "migrate-work-items",
        help="Migrate actionable initiatives → 岗位工作项 Tasks (idempotent)",
    )
    migrate_p.add_argument("--agent-code", default="", help="Limit to one employee")
    migrate_p.add_argument("--dry-run", action="store_true", help="Count only, no writes")
    add_output_flags(migrate_p)
    migrate_p.set_defaults(handler=_migrate_work_items)


def _list(args: argparse.Namespace):
    status = str(getattr(args, "status", "") or "").strip() or None
    return employees_admin.list_roles(
        status=status,
        include_archived=bool(getattr(args, "include_archived", False)),
    )


def _get(args: argparse.Namespace):
    return employees_admin.get_role(
        args.agent_code,
        recent_limit=int(getattr(args, "recent", 10) or 10),
    )


def _hire(args: argparse.Namespace):
    payload = load_json_payload(args)
    if payload is None:
        raise ValidationError("Provide JSON via --file or --stdin (see examples/employees-hire.json)")
    return employees_admin.hire(payload)


def _update(args: argparse.Namespace):
    payload = load_json_payload(args)
    if payload is None:
        raise ValidationError("Provide JSON via --file or --stdin (see examples/employees-update.json)")
    return employees_admin.update_role(args.agent_code, payload)


def _pause(args: argparse.Namespace):
    return employees_admin.pause_role(args.agent_code)


def _stop(args: argparse.Namespace):
    return employees_admin.stop_role(args.agent_code)


def _resume(args: argparse.Namespace):
    return employees_admin.resume_role(args.agent_code)


def _archive(args: argparse.Namespace):
    return employees_admin.archive_role(args.agent_code)


def _worklog(args: argparse.Namespace):
    day = str(getattr(args, "day", "") or "").strip() or None
    return employees_admin.worklog(
        args.agent_code,
        day=day,
        limit=int(getattr(args, "limit", 80) or 80),
    )


def _trail(args: argparse.Namespace):
    rid = str(getattr(args, "round_id", "") or "").strip() or None
    return employees_admin.round_trail(
        args.agent_code,
        round_id=rid,
        max_steps=int(getattr(args, "max_steps", 40) or 40),
    )


def _dispatch(args: argparse.Namespace):
    return employees_admin.dispatch(
        args.agent_code,
        str(args.goal),
        description=str(getattr(args, "description", "") or ""),
        priority=str(getattr(args, "priority", "normal") or "normal"),
        source=str(getattr(args, "source", "") or "role"),
        related_task_id=str(getattr(args, "task_id", "") or ""),
        round_id=str(getattr(args, "round_id", "") or ""),
        resume_round=bool(getattr(args, "resume_round", False)),
        fresh_round=bool(getattr(args, "fresh_round", False)),
    )


def _wake(args: argparse.Namespace):
    return employees_admin.wake(
        str(args.target),
        str(getattr(args, "goal", "") or ""),
        from_agent=str(getattr(args, "from_agent", "") or ""),
        task_id=str(getattr(args, "task_id", "") or ""),
        description=str(getattr(args, "description", "") or ""),
        priority=str(getattr(args, "priority", "normal") or "normal"),
        source=str(getattr(args, "source", "role") or "role"),
        round_id=str(getattr(args, "round_id", "") or ""),
        resume_round=bool(getattr(args, "resume_round", False)),
        fresh_round=bool(getattr(args, "fresh_round", False)),
    )


def _migrate_work_items(args: argparse.Namespace):
    from evoflow.proactive.migrate_initiatives import migrate_actionable_initiatives_to_tasks

    code = str(getattr(args, "agent_code", "") or "").strip() or None
    return migrate_actionable_initiatives_to_tasks(
        dry_run=bool(getattr(args, "dry_run", False)),
        role_agent_code=code,
    )
