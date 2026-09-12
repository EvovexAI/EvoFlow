"""evoflow experience (经验库) subcommands."""

from __future__ import annotations

import argparse

from evoflow.admin import experience as exp_admin
from evoflow.admin.errors import ValidationError
from evoflow.cli.common import add_json_input_flags, add_output_flags, load_json_payload


def register(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser("experience", help="Manage experience library (经验库)")
    sub = parser.add_subparsers(dest="experience_cmd", required=True)

    list_p = sub.add_parser("list", help="Search/list experiences")
    list_p.add_argument("--category", default="")
    list_p.add_argument("--query", default="")
    list_p.add_argument("--tag", action="append", default=[])
    list_p.add_argument("--limit", type=int, default=10)
    add_output_flags(list_p)
    list_p.set_defaults(handler=_list)

    get_p = sub.add_parser("get", help="Get experience by id")
    get_p.add_argument("id")
    add_output_flags(get_p)
    get_p.set_defaults(handler=_get)

    save_p = sub.add_parser(
        "save",
        help="Create experience from JSON",
        description="JSON payload fields:\n"
        "  title (required)               Experience title\n"
        "  category                       Category (default: general)\n"
        "  tags                           List of tags\n"
        "  steps                          List of step descriptions\n"
        "  source_sessions                List of session IDs\n"
        "  context                        Object with problem/solution/outcome/applicable_to\n"
        "  problem / solution / outcome / applicable_to\n"
        "                                 Alternative to context object\n",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    add_json_input_flags(save_p)
    add_output_flags(save_p)
    save_p.set_defaults(handler=_save)

    update_p = sub.add_parser(
        "update",
        help="Update experience from JSON",
        description="JSON payload fields (all optional, partial update):\n"
        "  title, category, tags, steps, source_sessions,\n"
        "  context, problem, solution, outcome, applicable_to\n",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    update_p.add_argument("id")
    add_json_input_flags(update_p)
    add_output_flags(update_p)
    update_p.set_defaults(handler=_update)

    used_p = sub.add_parser("mark-used", help="Increment use_count")
    used_p.add_argument("id")
    add_output_flags(used_p)
    used_p.set_defaults(handler=_mark_used)

    del_p = sub.add_parser("delete", help="Soft-delete (default) or hard-delete experience")
    del_p.add_argument("id")
    del_p.add_argument("--permanent", action="store_true")
    add_output_flags(del_p)
    del_p.set_defaults(handler=_delete)


def _list(args: argparse.Namespace):
    return exp_admin.list_experiences(
        category=args.category,
        tags=args.tag or None,
        query=args.query,
        max_results=args.limit,
    )


def _get(args: argparse.Namespace):
    return exp_admin.get_experience(args.id)


def _save(args: argparse.Namespace):
    payload = load_json_payload(args)
    if payload is None:
        raise ValidationError("Provide JSON via --file or --stdin")
    return exp_admin.save_experience(payload)


def _update(args: argparse.Namespace):
    payload = load_json_payload(args)
    if payload is None:
        raise ValidationError("Provide JSON via --file or --stdin")
    return exp_admin.update_experience(args.id, payload)


def _mark_used(args: argparse.Namespace):
    return exp_admin.mark_experience_used(args.id)


def _delete(args: argparse.Namespace):
    return exp_admin.delete_experience(args.id, permanent=args.permanent)
