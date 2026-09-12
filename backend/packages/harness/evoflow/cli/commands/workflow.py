"""evoflow workflow — apps / workflow runs (对齐 platform workflow.*)."""

from __future__ import annotations

import argparse

from evoflow.admin import apps as apps_admin
from evoflow.cli.common import add_json_input_flags, add_output_flags, load_json_payload


def register(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser(
        "workflow",
        help="Manage apps / workflows (list / get / run / stop / status)",
        description=(
            "Operate panel 「工作流」apps. Mirrors platform actions:\n"
            "  workflow.list / .get / .run / .stop / .run_status"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="workflow_cmd", required=True)

    list_p = sub.add_parser("list", help="List apps / workflows")
    list_p.add_argument("--status", default="", help="Filter by status")
    list_p.add_argument("--search", "--query", dest="search", default="", help="Search name/description")
    list_p.add_argument("--limit", type=int, default=50)
    add_output_flags(list_p)
    list_p.set_defaults(handler=_list)

    get_p = sub.add_parser("get", help="Get one workflow / app detail")
    get_p.add_argument("app_id", help="App id (App_xxx)")
    add_output_flags(get_p)
    get_p.set_defaults(handler=_get)

    run_p = sub.add_parser(
        "run",
        help="Start one run",
        description=(
            "Optional JSON via --file/--stdin:\n"
            "  {\"param_key\": \"value\", ...}   parameter map passed to the app\n"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    run_p.add_argument("app_id", help="App id")
    add_json_input_flags(run_p)
    add_output_flags(run_p)
    run_p.set_defaults(handler=_run)

    stop_p = sub.add_parser("stop", help="Cancel (default) or pause a run")
    stop_p.add_argument("run_id", help="Run id")
    stop_p.add_argument("--reason", default="CLI stop", help="Reason written to run log")
    stop_p.add_argument("--pause", action="store_true", help="Pause instead of cancel")
    add_output_flags(stop_p)
    stop_p.set_defaults(handler=_stop)

    status_p = sub.add_parser("status", help="Get run status (platform: workflow.run_status)")
    status_p.add_argument("run_id", help="Run id")
    add_output_flags(status_p)
    status_p.set_defaults(handler=_status)


def _list(args: argparse.Namespace):
    return apps_admin.list_apps(
        status=str(args.status or "").strip() or None,
        search=str(args.search or "").strip() or None,
        limit=int(args.limit or 50),
    )


def _get(args: argparse.Namespace):
    return apps_admin.get_app(args.app_id)


def _run(args: argparse.Namespace):
    payload = load_json_payload(args)
    parameters = payload if isinstance(payload, dict) else {}
    return apps_admin.run_app(args.app_id, parameters=parameters)


def _stop(args: argparse.Namespace):
    reason = str(args.reason or "CLI stop").strip() or "CLI stop"
    if args.pause:
        return apps_admin.pause_run(args.run_id, reason=reason)
    return apps_admin.cancel_run(args.run_id, reason=reason)


def _status(args: argparse.Namespace):
    return apps_admin.get_run(args.run_id)
