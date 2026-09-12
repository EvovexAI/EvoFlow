"""evoflow automation subcommands."""

from __future__ import annotations

import argparse

from evoflow.admin import automation as automation_admin
from evoflow.admin.errors import ValidationError
from evoflow.cli.common import add_json_input_flags, add_output_flags, load_json_payload


def register(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser("automation", help="Manage scheduled automations")
    sub = parser.add_subparsers(dest="automation_cmd", required=True)

    list_p = sub.add_parser("list", help="List automations")
    add_output_flags(list_p)
    list_p.set_defaults(handler=_list)

    get_p = sub.add_parser("get", help="Get automation with recent history")
    get_p.add_argument("id")
    add_output_flags(get_p)
    get_p.set_defaults(handler=_get)

    history_p = sub.add_parser("history", help="List run history")
    history_p.add_argument("id")
    history_p.add_argument("--limit", type=int, default=50)
    add_output_flags(history_p)
    history_p.set_defaults(handler=_history)

    create_p = sub.add_parser(
        "create",
        help="Create automation from JSON",
        description="JSON payload fields:\n"
        "  name (required)                Automation name\n"
        "  prompt (required)              Prompt to execute\n"
        "  schedule_type                  'recurring' (default) or 'once'\n"
        "  cron_expr / schedule           Cron expression, e.g. '0 9 * * *'\n"
        "  scheduled_at                   For one-time: ISO datetime\n"
        "  rrule                          iCal RRULE (overrides cron if given)\n"
        "  status                         'active' (default) or 'paused'\n"
        "  workspace                      Workspace path\n"
        "  valid_from / valid_until       ISO datetime range\n"
        "  max_duration_minutes           Timeout (default 30)\n"
        "  feishu_push_enabled            Push result to Feishu (bool)\n"
        "  langgraph_thread_mode          'fresh' (default) or 'sticky'\n"
        "  langgraph_timeout_seconds      Per-run timeout\n"
        "  memory_enabled                 Enable memory (bool)\n",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    add_json_input_flags(create_p)
    add_output_flags(create_p)
    create_p.set_defaults(handler=_create)

    update_p = sub.add_parser(
        "update",
        help="Update automation from JSON",
        description="JSON payload fields (all optional, partial update):\n"
        "  name, prompt, schedule, rrule, scheduled_at, status,\n"
        "  workspace, valid_from, valid_until, max_duration_minutes,\n"
        "  feishu_push_enabled, once_fired, langgraph_thread_mode,\n"
        "  langgraph_timeout_seconds, memory_enabled\n",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    update_p.add_argument("id")
    add_json_input_flags(update_p)
    add_output_flags(update_p)
    update_p.set_defaults(handler=_update)

    delete_p = sub.add_parser("delete", help="Delete automation")
    delete_p.add_argument("id")
    add_output_flags(delete_p)
    delete_p.set_defaults(handler=_delete)

    pause_p = sub.add_parser("pause", help="Pause automation")
    pause_p.add_argument("id")
    add_output_flags(pause_p)
    pause_p.set_defaults(handler=_pause)

    resume_p = sub.add_parser("resume", help="Resume automation")
    resume_p.add_argument("id")
    add_output_flags(resume_p)
    resume_p.set_defaults(handler=_resume)


def _list(args: argparse.Namespace):
    return automation_admin.list_automations()


def _get(args: argparse.Namespace):
    return automation_admin.get_automation(args.id)


def _history(args: argparse.Namespace):
    return automation_admin.get_automation_history(args.id, limit=args.limit)


def _create(args: argparse.Namespace):
    payload = load_json_payload(args)
    if payload is None:
        raise ValidationError("Provide JSON via --file or --stdin")
    return automation_admin.create_automation(payload)


def _update(args: argparse.Namespace):
    payload = load_json_payload(args)
    if payload is None:
        raise ValidationError("Provide JSON via --file or --stdin")
    return automation_admin.update_automation(args.id, payload)


def _delete(args: argparse.Namespace):
    return automation_admin.delete_automation(args.id)


def _pause(args: argparse.Namespace):
    return automation_admin.set_automation_status(args.id, status="paused")


def _resume(args: argparse.Namespace):
    return automation_admin.set_automation_status(args.id, status="active")
