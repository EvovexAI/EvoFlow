"""evoflow agents subcommands."""

from __future__ import annotations

import argparse

from evoflow.admin import agents as agents_admin
from evoflow.admin.errors import ValidationError
from evoflow.cli.common import add_json_input_flags, add_output_flags, load_json_payload


def register(subparsers: argparse._SubParsersAction) -> None:
    agents_parser = subparsers.add_parser("agents", help="Manage custom agents")
    agents_sub = agents_parser.add_subparsers(dest="agents_cmd", required=True)

    list_parser = agents_sub.add_parser("list", help="List agents")
    list_parser.add_argument("--tag", help="Filter by tag label (substring match)")
    add_output_flags(list_parser)
    list_parser.set_defaults(handler=_list)

    get_parser = agents_sub.add_parser("get", help="Get one agent (includes soul)")
    get_parser.add_argument("name")
    add_output_flags(get_parser)
    get_parser.set_defaults(handler=_get)

    check_parser = agents_sub.add_parser("check", help="Check if agent name is available")
    check_parser.add_argument("name")
    add_output_flags(check_parser)
    check_parser.set_defaults(handler=_check)

    create_parser = agents_sub.add_parser(
        "create",
        help="Create agent from JSON",
        description="JSON payload fields:\n"
        "  agent_code (required)          Unique agent identifier\n"
        "  agent_name                     Display name\n"
        "  description                    Agent description\n"
        "  model                          Model name to use\n"
        "  tool_groups                    List of tool group names\n"
        "  tools                          List of tool names\n"
        "  mcp_servers                    List of MCP server names\n"
        "  skills                         List of skill names\n"
        "  tags                           Tag labels, e.g. [\"核心\", \"代码\"]\n"
        "  soul                           System prompt text\n",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    add_json_input_flags(create_parser)
    add_output_flags(create_parser)
    create_parser.set_defaults(handler=_create)

    update_parser = agents_sub.add_parser(
        "update",
        help="Update agent from JSON",
        description="JSON payload fields (all optional, partial update):\n"
        "  agent_name, description, model, tool_groups, tools,\n"
        "  mcp_servers, skills, system_prompt, tags\n",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    update_parser.add_argument("name")
    add_json_input_flags(update_parser)
    add_output_flags(update_parser)
    update_parser.set_defaults(handler=_update)

    delete_parser = agents_sub.add_parser(
        "delete",
        help="Delete a custom agent (cascades linked employee by default)",
    )
    delete_parser.add_argument("name")
    delete_parser.add_argument(
        "--keep-employee",
        action="store_true",
        help="Delete the agent only; leave the linked employee role intact",
    )
    add_output_flags(delete_parser)
    delete_parser.set_defaults(handler=_delete)


def _list(args: argparse.Namespace):
    return agents_admin.list_agents(tag=args.tag)


def _get(args: argparse.Namespace):
    return agents_admin.get_agent(args.name)


def _check(args: argparse.Namespace):
    return agents_admin.check_agent_name(args.name)


def _create(args: argparse.Namespace):
    payload = load_json_payload(args)
    if payload is None:
        raise ValidationError("Provide JSON via --file or --stdin")
    return agents_admin.create_agent(payload)


def _update(args: argparse.Namespace):
    payload = load_json_payload(args)
    if payload is None:
        raise ValidationError("Provide JSON via --file or --stdin")
    return agents_admin.update_agent(args.name, payload)


def _delete(args: argparse.Namespace):
    keep_employee = bool(getattr(args, "keep_employee", False))
    return agents_admin.delete_agent(
        args.name,
        confirm_cascade=not keep_employee,
        keep_employee=keep_employee,
    )
