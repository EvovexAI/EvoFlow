"""evoflow tasks - CRUD + state/progress for collab tasks (运维入口).

Thin CLI wrapper over ``evoflow.admin.tasks``. Reuses ProjectStorage
(SQLite evoflow_collab_tasks) and supervisor_tool's state machine.
"""

from __future__ import annotations

import argparse

from evoflow.admin import tasks as tasks_admin
from evoflow.cli.common import add_output_flags


def register(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser(
        "tasks",
        help="Manage collab tasks (list / get / progress / state / create / delete)",
    )
    sub = parser.add_subparsers(dest="tasks_cmd", required=True)

    # ── list ──────────────────────────────────────────────────────
    list_p = sub.add_parser("list", help="List tasks / subtasks")
    list_p.add_argument("--status", default="", help="Filter by status")
    list_p.add_argument("--main-task-id", default="", help="Scope to one main task bundle")
    list_p.add_argument("--subtasks-only", action="store_true", help="List subtasks only")
    _assignee_group = list_p.add_mutually_exclusive_group()
    _assignee_group.add_argument(
        "--assignee",
        default="",
        help="Filter by assigned_to (agent_code)",
    )
    _assignee_group.add_argument(
        "--role",
        default="",
        help="Filter by assigned_role (岗位显示名 / role_name). "
        "Only tasks stamped with that 岗位 appear — not all agent_code history.",
    )
    list_p.add_argument(
        "--source",
        default="",
        help="Filter by 任务来源: chat|workflow|role "
        "(aliases like proactive_patrol / task_center also match)",
    )
    list_p.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Max rows to return (0 = all; newest updated_at first)",
    )
    list_p.add_argument(
        "--offset",
        type=int,
        default=0,
        help="Skip first N rows (use with --limit)",
    )
    add_output_flags(list_p)
    list_p.set_defaults(handler=_list)

    # ── get ───────────────────────────────────────────────────────
    get_p = sub.add_parser("get", help="Get one task or subtask detail")
    get_p.add_argument("task_id", help="Main task id (or a subtask id)")
    get_p.add_argument("--subtask-id", default="", help="Subtask id (when task_id is the parent)")
    add_output_flags(get_p)
    get_p.set_defaults(handler=_get)

    # ── progress ──────────────────────────────────────────────────
    progress_p = sub.add_parser("progress", help="Update progress (0-100)")
    progress_p.add_argument("task_id", help="Main task id")
    progress_p.add_argument("--progress", type=int, required=True, help="0-100")
    progress_p.add_argument("--status", default="", help="Optional status to set simultaneously")
    progress_p.add_argument("--subtask-id", default="", help="Update a subtask instead of main task")
    add_output_flags(progress_p)
    progress_p.set_defaults(handler=_progress)

    # ── state ────────────────────────────────────────────────────
    state_p = sub.add_parser(
        "state",
        help="Set task/subtask state (validates against state machine)",
        description=(
            "Set task/subtask status. Allowed states:\n"
            "  pending | planned | planning | executing | waiting_dispatch\n"
            "  waiting_user | reviewed | completed | failed | cancelled\n\n"
            "智能体员工干完结案（面板「已完成」）:\n"
            "  evoflow tasks state <task_id> --status completed \\\n"
            "    --summary \"做了什么 / 验收要点\" \\\n"
            "    --outputs '[{\"type\":\"file\",\"key\":\"report\",\"value\":\"path/to.md\"}]' \\\n"
            "  --handlers '[{\"agent_code\":\"frontend-dev\",\"content\":\"修闪烁\","
            "\"read_outputs\":[{\"type\":\"file\",\"key\":\"report\",\"value\":\"path/to.md\"}]}]'\n"
            "  （干完即结案；handlers 仅直属下级；medium+ 交接系统挂待审批后再 wake）\n"
            "  结案必须带 --summary；文件/链接等产出用 --outputs。\n"
            "  legacy --status reviewed 会映射为 completed。\n\n"
            "Transitions are validated (e.g. executing -> completed)."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    state_p.add_argument("task_id", help="Main task id")
    state_p.add_argument(
        "--status",
        required=True,
        help="Target status（有下游交工用 completed+handlers→待闭环；叶子完成用 completed；失败用 failed）",
    )
    state_p.add_argument(
        "--summary",
        default="",
        help="任务总结（结案/失败时写入；completed 必填：做了什么、如何验收）",
    )
    state_p.add_argument(
        "--outputs",
        default="",
        help=(
            "结构化产出 JSON 数组："
            '[{"type":"file|url|text|other","key":"...","value":"...","label":"..."}]；'
            "也可传单个文件路径字符串"
        ),
    )
    state_p.add_argument(
        "--handlers",
        default="",
        help=(
            "下游处理人 JSON 数组（每人一条）："
            '[{"agent_code":"…","content":"做什么","read_outputs":[{"type":"file","key":"…","value":"path"}],'
            '"role":"可选岗位名"}]。'
            "legacy 仍可用 outputs 键。用户确认完成后按条建下游 Task（input_refs）并 wake。"
        ),
    )
    state_p.add_argument("--subtask-id", default="", help="Set a subtask state instead of main task")
    add_output_flags(state_p)
    state_p.set_defaults(handler=_state)

    # ── delete ───────────────────────────────────────────────────
    del_p = sub.add_parser(
        "delete",
        help="Hard-delete a main task (不可恢复；误建/重复单用)",
        description=(
            "物理删除主任务（与面板 DELETE /tasks 同源）。\n"
            "例：evoflow tasks delete Task_xxx\n"
            "若只需关闭、保留记录，改用：evoflow tasks state Task_xxx --status cancelled"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    del_p.add_argument("task_id", help="Main task id")
    del_p.add_argument(
        "--yes",
        "-y",
        action="store_true",
        help="Skip interactive confirm (required in non-TTY / agent duty)",
    )
    add_output_flags(del_p)
    del_p.set_defaults(handler=_delete)

    # ── create ───────────────────────────────────────────────────
    create_p = sub.add_parser("create", help="Create a task or subtask")
    create_p.add_argument("--name", required=True, help="Task name")
    create_p.add_argument("--description", default="", help="Task description")
    create_p.add_argument("--assignee", default="", help="agent_code to assign to")
    create_p.add_argument(
        "--role",
        default="",
        help="Stamp assigned_role with this 岗位显示名 (role_name). "
        "If --assignee omitted, resolves agent_code from the active employee role.",
    )
    create_p.add_argument(
        "--main-task-id",
        default="",
        help="If set, create a subtask under this main task; else a new standalone main task",
    )
    create_p.add_argument("--status", default="pending", help="Initial status (default pending)")
    create_p.add_argument(
        "--source",
        default="",
        help="任务来源: chat|workflow|role "
        "(default: role when --role set, else chat)",
    )
    create_p.add_argument(
        "--raised-by",
        default="user",
        help="提起人: user（你）或 agent_code（智能体员工）。默认 user",
    )
    create_p.add_argument(
        "--source-ref",
        default="",
        help="关联引用（值班请填本轮 round_id，便于收工后扫描执行）",
    )
    create_p.add_argument(
        "--risk-level",
        default="",
        help="风险: low|medium|high|critical（岗位工作项审批用；默认不写则按 low）",
    )
    create_p.add_argument(
        "--action-type",
        default="",
        help="行动类型: code_change|analysis|report|task_delegation|alert|optimization",
    )
    create_p.add_argument(
        "--round-id",
        default="",
        help="值班轮次 id（可与 --source-ref 同值；未设 source-ref 时用作 source_ref）",
    )
    create_p.add_argument(
        "--parent-task-id",
        default="",
        help="上游主任务 id（跨岗交接树：产品→总监→前端）。与 --main-task-id 互斥",
    )
    add_output_flags(create_p)
    create_p.set_defaults(handler=_create)

    # ── cleanup-noise ────────────────────────────────────────────
    clean_p = sub.add_parser(
        "cleanup-noise",
        help="Cancel task-center noise (eval / receipts / meeting speak / placeholders)",
        description=(
            "Default is dry-run (lists candidates only).\n"
            "Apply with: evoflow tasks cleanup-noise --apply\n"
            "Rules: EVAL_LIVE, 【下游回执】wrappers, meeting oral reports,\n"
            "placeholder names (main/t/smoke/fan).\n"
            "Stuck executing@100% / awaiting_close → use `evoflow tasks reclaim-zombies`.\n"
            "Does not touch completed real business duplicates."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    clean_p.add_argument(
        "--apply",
        action="store_true",
        help="Actually cancel candidates (default: dry-run list only)",
    )
    clean_p.add_argument(
        "--stuck-days",
        type=int,
        default=3,
        help="(legacy, unused) kept for CLI compat",
    )
    clean_p.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Max candidates to process (0 = all)",
    )
    add_output_flags(clean_p)
    clean_p.set_defaults(handler=_cleanup_noise)

    # ── reclaim-zombies ──────────────────────────────────────────
    reclaim_p = sub.add_parser(
        "reclaim-zombies",
        help="Auto-close stuck executing@100% and stale awaiting_close",
        description=(
            "Default dry-run. Apply with: evoflow tasks reclaim-zombies --apply\n"
            "Rules:\n"
            "  - executing|running + progress>=100 + stale N days → completed\n"
            "  - awaiting_close + all children fully closed + stale → completed\n"
            "  - awaiting_close + no children + stale → completed\n"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    reclaim_p.add_argument(
        "--apply",
        action="store_true",
        help="Actually complete candidates (default: dry-run)",
    )
    reclaim_p.add_argument(
        "--stuck-days",
        type=int,
        default=3,
        help="Stale days for executing@100 (default 3)",
    )
    reclaim_p.add_argument(
        "--awaiting-close-days",
        type=int,
        default=3,
        help="Stale days for awaiting_close reclaim (default 3)",
    )
    reclaim_p.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Max candidates (0 = all)",
    )
    add_output_flags(reclaim_p)
    reclaim_p.set_defaults(handler=_reclaim_zombies)


def _list(args: argparse.Namespace):
    lim = int(getattr(args, "limit", 0) or 0)
    off = int(getattr(args, "offset", 0) or 0)
    return tasks_admin.list_tasks(
        assignee=args.assignee or None,
        role=args.role or None,
        status=args.status or None,
        source=str(getattr(args, "source", "") or "").strip() or None,
        main_task_id=args.main_task_id or None,
        include_subtasks=not args.subtasks_only,
        limit=lim if lim > 0 else None,
        offset=max(0, off),
    )


def _get(args: argparse.Namespace):
    return tasks_admin.get_task(args.task_id, subtask_id=args.subtask_id or None)


def _progress(args: argparse.Namespace):
    return tasks_admin.update_progress(
        args.task_id,
        args.progress,
        status=args.status or None,
        subtask_id=args.subtask_id or None,
    )


def _state(args: argparse.Namespace):
    from evoflow.collab.task_handlers import normalize_task_handlers
    from evoflow.collab.task_outputs import normalize_task_outputs

    outputs_raw = str(getattr(args, "outputs", "") or "").strip()
    outputs = normalize_task_outputs(outputs_raw) if outputs_raw else None
    handlers_raw = str(getattr(args, "handlers", "") or "").strip()
    handlers = normalize_task_handlers(handlers_raw) if handlers_raw else None
    return tasks_admin.set_task_state(
        args.task_id,
        args.status,
        subtask_id=args.subtask_id or None,
        summary=str(getattr(args, "summary", "") or "").strip() or None,
        outputs=outputs,
        handlers=handlers,
    )


def _delete(args: argparse.Namespace):
    from evoflow.admin.errors import ValidationError

    if not getattr(args, "yes", False):
        raise ValidationError("Refusing to delete without --yes (irreversible)")
    return tasks_admin.delete_task(args.task_id)


def _cleanup_noise(args: argparse.Namespace):
    from evoflow.collab.task_noise import cleanup_noise_tasks

    return cleanup_noise_tasks(
        dry_run=not bool(getattr(args, "apply", False)),
        stuck_days=int(getattr(args, "stuck_days", 3) or 3),
        limit=int(getattr(args, "limit", 0) or 0),
    )


def _reclaim_zombies(args: argparse.Namespace):
    from evoflow.collab.task_reclaim import reclaim_zombie_tasks

    return reclaim_zombie_tasks(
        dry_run=not bool(getattr(args, "apply", False)),
        stuck_days=int(getattr(args, "stuck_days", 3) or 3),
        awaiting_close_days=int(getattr(args, "awaiting_close_days", 3) or 3),
        limit=int(getattr(args, "limit", 0) or 0),
    )


def _resolve_role_assignee(role_name: str) -> tuple[str, str]:
    """Return (role_name_canonical, agent_code) for an active employee role."""
    from evoflow.admin.errors import ValidationError
    from evoflow.proactive.repositories import ProactiveRepository

    want = str(role_name or "").strip().lower()
    if not want:
        raise ValidationError("role must be a non-empty role_name")
    matches = [
        r
        for r in ProactiveRepository.list_roles()
        if str(r.role_name or "").strip().lower() == want
        and str(r.status or "").strip().lower() != "archived"
    ]
    if not matches:
        raise ValidationError(
            f"no active role found with name '{role_name}'. "
            "Run `evoflow employees list` to see available role_name values."
        )
    role = matches[0]
    code = str(role.agent_code or "").strip()
    if not code:
        raise ValidationError(f"role '{role_name}' has empty agent_code")
    return str(role.role_name or "").strip() or role_name, code


def _create(args: argparse.Namespace):
    from evoflow.collab.task_source import TASK_SOURCE_CHAT, TASK_SOURCE_ROLE

    assignee = str(args.assignee or "").strip() or None
    role_name = str(getattr(args, "role", "") or "").strip() or None
    if role_name:
        canonical, code = _resolve_role_assignee(role_name)
        role_name = canonical
        if not assignee:
            assignee = code
    src = str(getattr(args, "source", "") or "").strip() or None
    if not src:
        src = TASK_SOURCE_ROLE if role_name else TASK_SOURCE_CHAT
    raised = str(getattr(args, "raised_by", "") or "").strip() or "user"
    source_ref = str(getattr(args, "source_ref", "") or "").strip() or None
    round_id = str(getattr(args, "round_id", "") or "").strip() or None
    risk = str(getattr(args, "risk_level", "") or "").strip() or None
    action = str(getattr(args, "action_type", "") or "").strip() or None
    parent = str(getattr(args, "parent_task_id", "") or "").strip() or None
    return tasks_admin.create_task(
        name=args.name,
        description=args.description,
        assignee=assignee,
        assigned_role=role_name,
        main_task_id=args.main_task_id or None,
        initial_status=args.status or "pending",
        source=src,
        source_ref=source_ref,
        raised_by=raised,
        risk_level=risk,
        action_type=action,
        round_id=round_id,
        parent_task_id=parent,
    )
