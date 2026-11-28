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
    list_p.add_argument("--status", default="", help="Filter: active|paused|draft")
    add_output_flags(list_p)
    list_p.set_defaults(handler=_list)

    depts_p = sub.add_parser(
        "departments",
        help="List department catalog (name, members, head)",
        description=(
            "Same source as Panel GET /api/proactive/departments and platform "
            "employees.departments. Syncs labels from role.department on read.\n"
            "Writes: department-create / department-rename / department-delete / "
            "department-set-head / department-set-members."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    add_output_flags(depts_p)
    depts_p.set_defaults(handler=_departments)

    dept_create = sub.add_parser(
        "department-create",
        help="Create a department (platform: employees.create_department)",
    )
    dept_create.add_argument("--name", "-n", required=True, help="Department display name")
    dept_create.add_argument("--avatar", default="", help="Optional avatar preset id")
    dept_create.add_argument("--sort-order", type=int, default=None, help="Optional sort order")
    add_output_flags(dept_create)
    dept_create.set_defaults(handler=_department_create)

    dept_rename = sub.add_parser(
        "department-rename",
        help="Rename a department (platform: employees.rename_department)",
    )
    dept_rename.add_argument("--id", dest="dept_id", default="", help="Department id")
    dept_rename.add_argument("--name", default="", help="Current department name (locator)")
    dept_rename.add_argument("--to", dest="new_name", required=True, help="New department name")
    add_output_flags(dept_rename)
    dept_rename.set_defaults(handler=_department_rename)

    dept_delete = sub.add_parser(
        "department-delete",
        help="Delete a department (platform: employees.delete_department)",
    )
    dept_delete.add_argument("--id", dest="dept_id", default="", help="Department id")
    dept_delete.add_argument("--name", default="", help="Department name")
    dept_delete.add_argument(
        "--keep-members",
        action="store_true",
        help="Keep role.department labels (default: clear them)",
    )
    add_output_flags(dept_delete)
    dept_delete.set_defaults(handler=_department_delete)

    dept_head = sub.add_parser(
        "department-set-head",
        help="Set department head (platform: employees.set_department_head)",
    )
    dept_head.add_argument("--id", dest="dept_id", default="", help="Department id")
    dept_head.add_argument("--name", default="", help="Department name")
    dept_head.add_argument(
        "--head",
        dest="head_agent_code",
        default="",
        help="Head agent_code (empty clears)",
    )
    dept_head.add_argument(
        "--align-unmanaged",
        action="store_true",
        help="Point members with empty reports_to at the new head",
    )
    add_output_flags(dept_head)
    dept_head.set_defaults(handler=_department_set_head)

    dept_members = sub.add_parser(
        "department-set-members",
        help="Overwrite department roster (platform: employees.set_department_members)",
    )
    dept_members.add_argument("--id", dest="dept_id", default="", help="Department id")
    dept_members.add_argument("--name", default="", help="Department name")
    dept_members.add_argument(
        "--members",
        "-m",
        required=True,
        help="Comma-separated agent_codes (empty string clears roster)",
    )
    add_output_flags(dept_members)
    dept_members.set_defaults(handler=_department_set_members)

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
            "  department, responsibilities, kpis\n"
            "  reports_to                  Direct manager agent_code (empty = top-level)\n"
            "  workspace_path                Bound workspace absolute path\n"
            "  autonomy_level                full_auto|approval_for_risky|approval_for_all\n"
            "  risk_threshold                low|medium|high|critical\n"
            "  heartbeat_rrule               e.g. FREQ=HOURLY;INTERVAL=2\n"
            "  status                        active|paused|draft (default active)\n"
            "  max_turns, timeout_seconds, model_name, skills\n"
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
        description="Partial JSON patch — same fields as hire except agent_code. See examples/employees-update.json",
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

    delete_p = sub.add_parser(
        "delete",
        help="Delete duty role (岗位); optionally also delete the Agent",
    )
    delete_p.add_argument("agent_code")
    delete_p.add_argument(
        "--delete-agent",
        action="store_true",
        help="Also delete the linked Agent config (destructive)",
    )
    add_output_flags(delete_p)
    delete_p.set_defaults(handler=_delete)

    worklog_p = sub.add_parser("worklog", help="Day work log grouped by duty round")
    worklog_p.add_argument("agent_code", help="Employee agent_code")
    worklog_p.add_argument("--day", default="", help="YYYY-MM-DD (default: today)")
    worklog_p.add_argument(
        "--days",
        type=int,
        default=0,
        help="Look-back N Beijing calendar days (omit --day); max 30",
    )
    worklog_p.add_argument("--limit", type=int, default=80, help="Max initiatives to scan")
    worklog_p.add_argument(
        "--round-id",
        default="",
        help="Filter to one duty round (from dispatch/trail); default look-back becomes 7 days",
    )
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
            "  evoflow employees wake 技术总监 --from product-manager \\\n"
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
    # 【self-evolution-bot · 2026-11-17 · 第28轮】把唤醒投回指定真人会话（如装完机回到用户正看的那一屏）。
    #   不加这个参数，wake 只能在 task/duty 两个桶里落会话，用户会觉得"续不上当前对话"。
    wake_p.add_argument(
        "--session-key",
        default="",
        help="Pin this wake into an existing chat session, e.g. proactive:<agent>:chat:<stamp>",
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

    org_p = sub.add_parser(
        "org-status",
        help="Roster summary: counts / busy / pending approvals (platform: employees.org_status)",
    )
    add_output_flags(org_p)
    org_p.set_defaults(handler=_org_status)

    board_p = sub.add_parser(
        "board",
        help="Cross-role open-task board (platform: employees.board_overview)",
    )
    board_p.add_argument("--limit", type=int, default=8, help="Limit per role")
    add_output_flags(board_p)
    board_p.set_defaults(handler=_board)

    brief_p = sub.add_parser(
        "brief",
        help="Single-role brief (platform: employees.brief)",
    )
    brief_p.add_argument("agent_code", help="agent_code or role_name")
    brief_p.add_argument("--task-limit", type=int, default=8)
    brief_p.add_argument("--no-trail", action="store_true", help="Omit execution trail")
    add_output_flags(brief_p)
    brief_p.set_defaults(handler=_brief)

    chat_p = sub.add_parser(
        "chat",
        help="Queue a chat message to an employee (platform: employees.chat_send)",
    )
    chat_p.add_argument("agent_code", help="agent_code or role_name")
    chat_p.add_argument("--message", "-m", required=True, help="Message text")
    chat_p.add_argument("--session-key", default="", help="Optional session key")
    chat_p.add_argument("--task-id", default="", help="Optional related task id")
    chat_p.add_argument("--source", default="", help="Optional source label")
    add_output_flags(chat_p)
    chat_p.set_defaults(handler=_chat)

    msgs_p = sub.add_parser(
        "messages",
        help="Read recent employee chat messages (platform: employees.messages)",
    )
    msgs_p.add_argument("agent_code", help="agent_code or role_name")
    msgs_p.add_argument("--session-key", default="", help="Optional session key")
    msgs_p.add_argument("--limit", type=int, default=20)
    add_output_flags(msgs_p)
    msgs_p.set_defaults(handler=_messages)

    bind_begin = sub.add_parser(
        "bind-channel-begin",
        help="Start IM QR binding (platform: employees.bind_channel_begin)",
    )
    bind_begin.add_argument("agent_code")
    bind_begin.add_argument("--channel", default="feishu", help="feishu|wecom|…")
    add_output_flags(bind_begin)
    bind_begin.set_defaults(handler=_bind_begin)

    bind_poll = sub.add_parser(
        "bind-channel-poll",
        help="Poll IM QR binding (platform: employees.bind_channel_poll)",
    )
    bind_poll.add_argument("agent_code")
    bind_poll.add_argument("--session-id", required=True)
    bind_poll.add_argument("--channel", default="feishu")
    add_output_flags(bind_poll)
    bind_poll.set_defaults(handler=_bind_poll)

    bind_apply = sub.add_parser(
        "bind-channel-apply",
        help="Apply completed IM binding (platform: employees.bind_channel_apply)",
    )
    bind_apply.add_argument("agent_code")
    bind_apply.add_argument("--session-id", required=True)
    bind_apply.add_argument("--channel", default="feishu")
    add_output_flags(bind_apply)
    bind_apply.set_defaults(handler=_bind_apply)


def _list(args: argparse.Namespace):
    status = str(getattr(args, "status", "") or "").strip() or None
    return employees_admin.list_roles(status=status)


def _departments(_args: argparse.Namespace):
    from evoflow.admin.platform_handlers import employees_departments

    return employees_departments({})


def _department_locator(args: argparse.Namespace) -> dict:
    body: dict = {}
    did = str(getattr(args, "dept_id", "") or "").strip()
    name = str(getattr(args, "name", "") or "").strip()
    if did:
        body["dept_id"] = did
    if name:
        body["name"] = name
    return body


def _department_create(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import employees_create_department

    body: dict = {"name": str(args.name)}
    avatar = str(getattr(args, "avatar", "") or "").strip()
    if avatar:
        body["avatar"] = avatar
    sort = getattr(args, "sort_order", None)
    if sort is not None:
        body["sort_order"] = int(sort)
    return employees_create_department(body)


def _department_rename(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import employees_rename_department

    body = _department_locator(args)
    body["new_name"] = str(args.new_name)
    return employees_rename_department(body)


def _department_delete(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import employees_delete_department

    body = _department_locator(args)
    if bool(getattr(args, "keep_members", False)):
        body["keep_members"] = True
    return employees_delete_department(body)


def _department_set_head(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import employees_set_department_head

    body = _department_locator(args)
    body["head_agent_code"] = str(getattr(args, "head_agent_code", "") or "")
    if bool(getattr(args, "align_unmanaged", False)):
        body["align_unmanaged"] = True
    return employees_set_department_head(body)


def _department_set_members(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import employees_set_department_members

    body = _department_locator(args)
    body["members"] = str(getattr(args, "members", "") or "")
    return employees_set_department_members(body)


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


def _delete(args: argparse.Namespace):
    return employees_admin.delete_role(
        args.agent_code,
        delete_agent=bool(getattr(args, "delete_agent", False)),
    )


def _worklog(args: argparse.Namespace):
    day = str(getattr(args, "day", "") or "").strip() or None
    days_n = int(getattr(args, "days", 0) or 0)
    return employees_admin.worklog(
        args.agent_code,
        day=day,
        days=days_n if days_n > 0 else None,
        limit=int(getattr(args, "limit", 80) or 80),
        round_id=str(getattr(args, "round_id", "") or "").strip(),
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
        # 【self-evolution-bot · 2026-11-17 · 第28轮】透传 --session-key 到 admin.wake
        session_key=str(getattr(args, "session_key", "") or ""),
    )


def _org_status(_args: argparse.Namespace):
    from evoflow.admin.platform_handlers import employees_org_status

    return employees_org_status({})


def _board(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import employees_board_overview

    return employees_board_overview({"limit": int(getattr(args, "limit", 8) or 8)})


def _brief(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import employees_brief

    return employees_brief(
        {
            "agent_code": args.agent_code,
            "task_limit": int(getattr(args, "task_limit", 8) or 8),
            "include_trail": not bool(getattr(args, "no_trail", False)),
        }
    )


def _chat(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import employees_chat_send

    body: dict = {
        "agent_code": args.agent_code,
        "message": args.message,
    }
    sk = str(getattr(args, "session_key", "") or "").strip()
    tid = str(getattr(args, "task_id", "") or "").strip()
    src = str(getattr(args, "source", "") or "").strip()
    if sk:
        body["session_key"] = sk
    if tid:
        body["task_id"] = tid
    if src:
        body["source"] = src
    return employees_chat_send(body)


def _messages(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import employees_messages

    body: dict = {
        "agent_code": args.agent_code,
        "limit": int(getattr(args, "limit", 20) or 20),
    }
    sk = str(getattr(args, "session_key", "") or "").strip()
    if sk:
        body["session_key"] = sk
    return employees_messages(body)


def _bind_begin(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import employees_bind_channel_begin

    return employees_bind_channel_begin(
        {"agent_code": args.agent_code, "channel": str(getattr(args, "channel", "feishu") or "feishu")}
    )


def _bind_poll(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import employees_bind_channel_poll

    return employees_bind_channel_poll(
        {
            "agent_code": args.agent_code,
            "session_id": args.session_id,
            "channel": str(getattr(args, "channel", "feishu") or "feishu"),
        }
    )


def _bind_apply(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import employees_bind_channel_apply

    return employees_bind_channel_apply(
        {
            "agent_code": args.agent_code,
            "session_id": args.session_id,
            "channel": str(getattr(args, "channel", "feishu") or "feishu"),
        }
    )


def _migrate_work_items(args: argparse.Namespace):
    from evoflow.proactive.migrate_initiatives import migrate_actionable_initiatives_to_tasks

    code = str(getattr(args, "agent_code", "") or "").strip() or None
    return migrate_actionable_initiatives_to_tasks(
        dry_run=bool(getattr(args, "dry_run", False)),
        role_agent_code=code,
    )
