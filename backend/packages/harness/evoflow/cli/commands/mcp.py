"""evoflow mcp subcommands (runtime-aligned)."""

from __future__ import annotations

import argparse

from evoflow.admin import mcp as mcp_admin
from evoflow.admin.errors import ValidationError
from evoflow.cli.common import add_json_input_flags, add_output_flags, load_json_payload
from evoflow.mcp.cli_ops import (
    mcp_add_server,
    mcp_get_server,
    mcp_list_servers,
    mcp_login_server,
    mcp_logout_server,
    mcp_remove_server,
    mcp_test_server,
)


def register(subparsers: argparse._SubParsersAction) -> None:
    mcp_parser = subparsers.add_parser("mcp", help="Manage MCP servers (native-style native binding)")
    mcp_sub = mcp_parser.add_subparsers(dest="mcp_cmd", required=True)

    list_parser = mcp_sub.add_parser("list", help="List configured MCP servers and status")
    add_output_flags(list_parser)
    list_parser.set_defaults(handler=_list)

    get_parser = mcp_sub.add_parser("get", help="Show one MCP server configuration")
    get_parser.add_argument("server", help="Server name")
    add_output_flags(get_parser)
    get_parser.set_defaults(handler=_get)

    add_parser = mcp_sub.add_parser(
        "add",
        help="Add or update an MCP server",
        description="Examples:\n"
        "  evoflow mcp add github --url https://example/mcp\n"
        "  evoflow mcp add fs -- npx -y @modelcontextprotocol/server-filesystem /tmp\n",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    add_parser.add_argument("server", help="Server name")
    add_parser.add_argument("--url", default="", help="Streamable HTTP / SSE MCP URL")
    add_parser.add_argument(
        "command",
        nargs=argparse.REMAINDER,
        help="stdio command after -- (e.g. -- npx -y pkg)",
    )
    add_output_flags(add_parser)
    add_parser.set_defaults(handler=_add)

    remove_parser = mcp_sub.add_parser("remove", help="Remove an MCP server")
    remove_parser.add_argument("server", help="Server name")
    add_output_flags(remove_parser)
    remove_parser.set_defaults(handler=_remove)

    test_parser = mcp_sub.add_parser("test", help="Connect to an MCP server and list tools")
    test_parser.add_argument("server", nargs="?", default="", help="Server name (optional: test all)")
    add_output_flags(test_parser)
    test_parser.set_defaults(handler=_test)

    login_parser = mcp_sub.add_parser("login", help="Refresh OAuth token for an HTTP MCP server")
    login_parser.add_argument("server", help="Server name")
    add_output_flags(login_parser)
    login_parser.set_defaults(handler=_login)

    logout_parser = mcp_sub.add_parser("logout", help="Clear OAuth session for an HTTP MCP server")
    logout_parser.add_argument("server", help="Server name")
    add_output_flags(logout_parser)
    logout_parser.set_defaults(handler=_logout)

    show_parser = mcp_sub.add_parser("show", help="Show raw MCP configuration JSON (alias of all servers)")
    add_output_flags(show_parser)
    show_parser.set_defaults(handler=_show)

    set_parser = mcp_sub.add_parser(
        "set",
        help="Replace MCP configuration from JSON",
        description="JSON payload fields:\n"
        "  mcp_servers                    Object mapping server names to configs\n"
        "                                 Each config: {command, args, env}\n",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    add_json_input_flags(set_parser)
    add_output_flags(set_parser)
    set_parser.set_defaults(handler=_set)


def _list(args: argparse.Namespace):
    return mcp_list_servers()


def _get(args: argparse.Namespace):
    return mcp_get_server(str(args.server or "").strip())


def _add(args: argparse.Namespace):
    name = str(args.server or "").strip()
    url = str(getattr(args, "url", "") or "").strip()
    cmd_parts = list(getattr(args, "command", None) or [])
    if cmd_parts and cmd_parts[0] == "--":
        cmd_parts = cmd_parts[1:]
    if url:
        document = {"enabled": True, "url": url}
    elif cmd_parts:
        document = {"enabled": True, "command": cmd_parts[0], "args": cmd_parts[1:]}
    else:
        raise ValidationError("Provide --url or stdio command after --")
    return mcp_add_server(name, document)


def _remove(args: argparse.Namespace):
    return mcp_remove_server(str(args.server or "").strip())


def _test(args: argparse.Namespace):
    name = str(getattr(args, "server", "") or "").strip()
    if name:
        return mcp_test_server(name)
    raw = mcp_list_servers()
    results = []
    for row in raw.get("servers") or []:
        srv = str(row.get("name") or "").strip()
        if srv:
            results.append(mcp_test_server(srv))
    return {"servers": results}


def _login(args: argparse.Namespace):
    return mcp_login_server(str(args.server or "").strip())


def _logout(args: argparse.Namespace):
    return mcp_logout_server(str(args.server or "").strip())


def _show(args: argparse.Namespace):
    return mcp_admin.get_mcp_config()


def _set(args: argparse.Namespace):
    payload = load_json_payload(args)
    if payload is None:
        raise ValidationError("Provide JSON via --file or --stdin")
    return mcp_admin.set_mcp_config(payload)
