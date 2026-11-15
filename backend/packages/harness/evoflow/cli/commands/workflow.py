"""evoflow workflow — apps / workflow runs (对齐 platform workflow.*)."""

from __future__ import annotations

import argparse

from evoflow.admin.errors import ValidationError
from evoflow.cli.common import add_json_input_flags, add_output_flags, load_json_payload


def register(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser(
        "workflow",
        help="Manage apps / workflows (list / get / run / CRUD / runs…)",
        description=(
            "Operate panel 「工作流」apps. Mirrors platform actions:\n"
            "  workflow.list / .get / .schema / .run / .stop / .resume / .recover /\n"
            "  .run_status / .list_runs / .create / .update / .publish / .unpublish /\n"
            "  .delete / .duplicate / .revisions / .restore_revision"
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

    schema_p = sub.add_parser("schema", help="Workflow schema / parameter contract (platform: workflow.schema)")
    add_output_flags(schema_p)
    schema_p.set_defaults(handler=_schema)

    run_p = sub.add_parser(
        "run",
        help="Start one run",
        description=('Optional JSON via --file/--stdin:\n  {"param_key": "value", ...}   parameter map passed to the app\n'),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    run_p.add_argument("app_id", help="App id")
    run_p.add_argument(
        "--run-kind",
        default="",
        help="production|debug (default production; same as platform workflow.run run_kind)",
    )
    add_json_input_flags(run_p)
    add_output_flags(run_p)
    run_p.set_defaults(handler=_run)

    stop_p = sub.add_parser("stop", help="Cancel (default) or pause a run")
    stop_p.add_argument("run_id", help="Run id")
    stop_p.add_argument("--reason", default="CLI stop", help="Reason written to run log")
    stop_p.add_argument("--pause", action="store_true", help="Pause instead of cancel")
    add_output_flags(stop_p)
    stop_p.set_defaults(handler=_stop)

    resume_p = sub.add_parser("resume", help="Resume a paused run (platform: workflow.resume)")
    resume_p.add_argument("run_id", help="Run id")
    add_output_flags(resume_p)
    resume_p.set_defaults(handler=_resume)

    recover_p = sub.add_parser(
        "recover",
        help="Recover from crash/failed node using DB state (platform: workflow.recover)",
    )
    recover_p.add_argument("run_id", nargs="?", default="", help="Run id (or use --task-id)")
    recover_p.add_argument("--task-id", default="", help="Main task id instead of run id")
    recover_p.add_argument("--reason", default="cli", help="Reason stamped on heal rows")
    add_output_flags(recover_p)
    recover_p.set_defaults(handler=_recover)

    status_p = sub.add_parser("status", help="Get run status (platform: workflow.run_status)")
    status_p.add_argument("run_id", help="Run id")
    add_output_flags(status_p)
    status_p.set_defaults(handler=_status)

    runs_p = sub.add_parser("runs", help="List runs for an app (platform: workflow.list_runs)")
    runs_p.add_argument("app_id", help="App id")
    runs_p.add_argument("--limit", type=int, default=20)
    runs_p.add_argument("--page", type=int, default=1)
    add_output_flags(runs_p)
    runs_p.set_defaults(handler=_runs)

    create_p = sub.add_parser(
        "create",
        help="Create workflow draft (platform: workflow.create)",
        description="JSON via --file/--stdin (name + graph / steps …).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    add_json_input_flags(create_p)
    add_output_flags(create_p)
    create_p.set_defaults(handler=_create)

    gen_p = sub.add_parser(
        "generate",
        help="Generate workflow from goal+steps (platform: workflow.generate)",
        description="JSON via --file/--stdin: name, goal (required); steps?, …",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    add_json_input_flags(gen_p)
    add_output_flags(gen_p)
    gen_p.set_defaults(handler=_generate)

    update_p = sub.add_parser(
        "update",
        help="Update workflow draft (platform: workflow.update)",
        description="Partial JSON via --file/--stdin.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    update_p.add_argument("app_id", help="App id")
    add_json_input_flags(update_p)
    add_output_flags(update_p)
    update_p.set_defaults(handler=_update)

    publish_p = sub.add_parser("publish", help="Publish workflow (platform: workflow.publish)")
    publish_p.add_argument("app_id", help="App id")
    add_output_flags(publish_p)
    publish_p.set_defaults(handler=_publish)

    unpublish_p = sub.add_parser("unpublish", help="Unpublish workflow (platform: workflow.unpublish)")
    unpublish_p.add_argument("app_id", help="App id")
    add_output_flags(unpublish_p)
    unpublish_p.set_defaults(handler=_unpublish)

    delete_p = sub.add_parser("delete", help="Delete workflow (platform: workflow.delete)")
    delete_p.add_argument("app_id", help="App id")
    delete_p.add_argument("--yes", "-y", action="store_true", help="Confirm destructive delete")
    add_output_flags(delete_p)
    delete_p.set_defaults(handler=_delete)

    dup_p = sub.add_parser("duplicate", help="Duplicate workflow (platform: workflow.duplicate)")
    dup_p.add_argument("app_id", help="App id")
    dup_p.add_argument("--name", default="", help="Optional new name")
    add_output_flags(dup_p)
    dup_p.set_defaults(handler=_duplicate)

    rev_p = sub.add_parser("revisions", help="List revisions (platform: workflow.revisions)")
    rev_p.add_argument("app_id", help="App id")
    add_output_flags(rev_p)
    rev_p.set_defaults(handler=_revisions)

    restore_p = sub.add_parser(
        "restore-revision",
        help="Restore a revision (platform: workflow.restore_revision)",
    )
    restore_p.add_argument("app_id", help="App id")
    restore_p.add_argument("version", type=int, help="Revision version number")
    restore_p.add_argument(
        "--as-draft",
        action="store_true",
        default=True,
        help="Restore as draft (default true)",
    )
    add_output_flags(restore_p)
    restore_p.set_defaults(handler=_restore_revision)


def _list(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import workflow_list

    return workflow_list(
        {
            "status": str(args.status or "").strip() or None,
            "search": str(args.search or "").strip() or None,
            "limit": int(args.limit or 50),
        }
    )


def _get(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import workflow_get

    return workflow_get({"appId": args.app_id})


def _schema(_args: argparse.Namespace):
    from evoflow.admin.platform_handlers import workflow_schema

    return workflow_schema({})


def _run(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import workflow_run

    payload = load_json_payload(args)
    parameters = payload if isinstance(payload, dict) else {}
    body: dict = {"appId": args.app_id, "parameters": parameters}
    run_kind = str(getattr(args, "run_kind", "") or "").strip()
    if run_kind:
        body["run_kind"] = run_kind
    return workflow_run(body)


def _stop(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import workflow_stop

    return workflow_stop(
        {
            "runId": args.run_id,
            "reason": str(args.reason or "CLI stop").strip() or "CLI stop",
            "pause": bool(args.pause),
        }
    )


def _resume(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import workflow_resume

    return workflow_resume({"runId": args.run_id})


def _recover(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import workflow_recover

    reason = str(args.reason or "cli").strip() or "cli"
    task_id = str(getattr(args, "task_id", None) or "").strip()
    run_id = str(args.run_id or "").strip()
    if not task_id and not run_id:
        raise ValidationError("recover requires run_id or --task-id")
    body: dict = {"reason": reason}
    if task_id:
        body["taskId"] = task_id
    if run_id:
        body["runId"] = run_id
    return workflow_recover(body)


def _status(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import workflow_run_status

    return workflow_run_status({"runId": args.run_id})


def _runs(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import workflow_list_runs

    return workflow_list_runs(
        {
            "appId": args.app_id,
            "limit": int(getattr(args, "limit", 20) or 20),
            "page": int(getattr(args, "page", 1) or 1),
        }
    )


def _create(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import workflow_create

    payload = load_json_payload(args)
    if not isinstance(payload, dict):
        raise ValidationError("Provide JSON via --file or --stdin")
    return workflow_create(payload)


def _generate(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import workflow_generate

    payload = load_json_payload(args)
    if not isinstance(payload, dict):
        raise ValidationError("Provide JSON via --file or --stdin (name + goal required)")
    return workflow_generate(payload)


def _update(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import workflow_update

    payload = load_json_payload(args)
    if not isinstance(payload, dict):
        raise ValidationError("Provide JSON via --file or --stdin")
    body = dict(payload)
    body.setdefault("appId", args.app_id)
    body["appId"] = args.app_id
    return workflow_update(body)


def _publish(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import workflow_publish

    return workflow_publish({"appId": args.app_id})


def _unpublish(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import workflow_unpublish

    return workflow_unpublish({"appId": args.app_id})


def _delete(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import workflow_delete

    if not getattr(args, "yes", False):
        raise ValidationError("Refusing to delete workflow without --yes")
    return workflow_delete({"appId": args.app_id})


def _duplicate(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import workflow_duplicate

    body: dict = {"appId": args.app_id}
    name = str(getattr(args, "name", "") or "").strip()
    if name:
        body["name"] = name
    return workflow_duplicate(body)


def _revisions(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import workflow_revisions

    return workflow_revisions({"appId": args.app_id})


def _restore_revision(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import workflow_restore_revision

    return workflow_restore_revision(
        {
            "appId": args.app_id,
            "version": int(args.version),
            "as_draft": bool(getattr(args, "as_draft", True)),
        }
    )
