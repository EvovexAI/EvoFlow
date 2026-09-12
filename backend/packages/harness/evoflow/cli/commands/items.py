"""evoflow items — 用户个人事项（对齐 platform items.*；≠ 协作 tasks）."""

from __future__ import annotations

import argparse

from evoflow.admin import items as items_admin
from evoflow.admin.errors import ValidationError
from evoflow.cli.common import add_json_input_flags, add_output_flags, load_json_payload


def register(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser(
        "items",
        help="Manage user items / 个人事项 (list / get / create / update / delete / dispatch)",
        description=(
            "Personal progress ledger (panel 「我的事项」).\n"
            "Not the same as collab tasks (use `evoflow tasks`).\n"
            "Mirrors platform: items.list / .get / .create / .update / .delete / .dispatch"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="items_cmd", required=True)

    list_p = sub.add_parser("list", help="List user items")
    list_p.add_argument("--status", default="", help="todo|in_progress|waiting|done|parked")
    list_p.add_argument("--priority", default="", help="none|low|normal|high|urgent")
    list_p.add_argument("--tag", default="", help="Filter by one tag")
    list_p.add_argument("-q", "--query", default="", help="Search title / notes / conclusion / tags")
    list_p.add_argument("--include-done", action="store_true", default=True)
    list_p.add_argument("--exclude-done", action="store_true", help="Hide done items")
    list_p.add_argument("--page", type=int, default=1)
    list_p.add_argument("--page-size", type=int, default=50)
    add_output_flags(list_p)
    list_p.set_defaults(handler=_list)

    get_p = sub.add_parser("get", help="Get one item")
    get_p.add_argument("item_id")
    add_output_flags(get_p)
    get_p.set_defaults(handler=_get)

    create_p = sub.add_parser(
        "create",
        help="Create item from JSON (does not auto-run)",
        description=(
            "JSON fields:\n"
            "  title (required)\n"
            "  notes?, conclusion?, status?, priority?, due_at?, tags?, assignee_intent?, assignee_label?\n"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    add_json_input_flags(create_p)
    add_output_flags(create_p)
    create_p.set_defaults(handler=_create)

    update_p = sub.add_parser(
        "update",
        help="Partial update from JSON",
        description="JSON patch: title, notes, conclusion, status, priority, due_at, tags, progress, …",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    update_p.add_argument("item_id")
    add_json_input_flags(update_p)
    add_output_flags(update_p)
    update_p.set_defaults(handler=_update)

    del_p = sub.add_parser("delete", help="Delete item")
    del_p.add_argument("item_id")
    add_output_flags(del_p)
    del_p.set_defaults(handler=_delete)

    dispatch_p = sub.add_parser(
        "dispatch",
        help="Dispatch item to an employee (creates a Task)",
        description="Creates a collab Task linked to this item; optional wake.",
    )
    dispatch_p.add_argument("item_id")
    dispatch_p.add_argument("--agent", "--agent-code", dest="agent_code", required=True)
    dispatch_p.add_argument("--goal", default="", help="Override task title/goal")
    dispatch_p.add_argument(
        "--no-wake",
        action="store_true",
        help="Create task only; do not wake employee now",
    )
    dispatch_p.add_argument(
        "--force",
        action="store_true",
        help="Force a new Task even if an open Task already exists for this agent",
    )
    dispatch_p.add_argument(
        "--interrupt",
        action="store_true",
        help="Interrupt the employee's current duty round before waking (default: queue)",
    )
    add_output_flags(dispatch_p)
    dispatch_p.set_defaults(handler=_dispatch)


def _list(args: argparse.Namespace):
    include_done = not bool(args.exclude_done)
    return items_admin.list_items(
        status=str(args.status or "").strip() or None,
        priority=str(args.priority or "").strip() or None,
        tag=str(args.tag or "").strip() or None,
        q=str(args.query or "").strip() or None,
        include_done=include_done,
        page=int(args.page or 1),
        page_size=int(args.page_size or 50),
    )


def _get(args: argparse.Namespace):
    return items_admin.get_item(args.item_id)


def _create(args: argparse.Namespace):
    payload = load_json_payload(args)
    if payload is None:
        raise ValidationError("Provide JSON via --file or --stdin")
    if not isinstance(payload, dict):
        raise ValidationError("JSON payload must be an object")
    return items_admin.create_item(payload)


def _update(args: argparse.Namespace):
    payload = load_json_payload(args)
    if payload is None:
        raise ValidationError("Provide JSON via --file or --stdin")
    if not isinstance(payload, dict):
        raise ValidationError("JSON payload must be an object")
    return items_admin.update_item(args.item_id, payload)


def _delete(args: argparse.Namespace):
    return items_admin.delete_item(args.item_id)


def _dispatch(args: argparse.Namespace):
    return items_admin.dispatch_item(
        args.item_id,
        agent_code=str(args.agent_code or "").strip(),
        wake_now=not bool(args.no_wake),
        goal=str(args.goal or "").strip() or None,
        force=bool(getattr(args, "force", False)),
        interrupt=bool(getattr(args, "interrupt", False)),
    )
