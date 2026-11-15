"""evoflow verification — 系统验证轮次（对齐 platform verification.*）。"""

from __future__ import annotations

import argparse

from evoflow.admin.errors import ValidationError
from evoflow.cli.common import add_json_input_flags, add_output_flags, load_json_payload


def register(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser(
        "verification",
        help="System verification rounds (platform: verification.*)",
    )
    sub = parser.add_subparsers(dest="verification_cmd", required=True)

    cat_p = sub.add_parser("catalog", help="API catalog (platform: verification.catalog)")
    cat_p.add_argument("--domain", default="")
    cat_p.add_argument("--risk", default="")
    cat_p.add_argument("--query", default="")
    cat_p.add_argument("--include-verification", action="store_true")
    add_output_flags(cat_p)
    cat_p.set_defaults(handler=_catalog)

    start_p = sub.add_parser(
        "start",
        help="Start verification round (platform: verification.start)",
        description="Optional JSON via --file/--stdin for full seed/config.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    start_p.add_argument("--title", default="")
    start_p.add_argument("--scenario", default="")
    start_p.add_argument("--round-id", default="")
    start_p.add_argument("--resume", action="store_true")
    add_json_input_flags(start_p)
    add_output_flags(start_p)
    start_p.set_defaults(handler=_start)

    init_p = sub.add_parser(
        "init",
        help="Init/seed round steps (platform: verification.init)",
    )
    init_p.add_argument("--round-id", default="")
    init_p.add_argument("--title", default="")
    init_p.add_argument("--scenario", default="")
    init_p.add_argument("--only-missing", action="store_true")
    init_p.add_argument("--include-verification", action="store_true")
    add_json_input_flags(init_p)
    add_output_flags(init_p)
    init_p.set_defaults(handler=_init)

    get_p = sub.add_parser("get", help="Get round (platform: verification.get)")
    get_p.add_argument("round_id")
    get_p.add_argument("--include-steps", action="store_true")
    add_output_flags(get_p)
    get_p.set_defaults(handler=_get)

    step_p = sub.add_parser(
        "step",
        help="Record a step (platform: verification.step)",
        description="JSON via --file/--stdin for request/response/result payloads.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    step_p.add_argument("--round-id", required=True)
    step_p.add_argument("--feature", "--api", dest="feature", default="", help="feature or api id")
    step_p.add_argument("--status", default="")
    step_p.add_argument("--detail", default="")
    step_p.add_argument("--seq", type=int, default=None)
    add_json_input_flags(step_p)
    add_output_flags(step_p)
    step_p.set_defaults(handler=_step)

    upd_p = sub.add_parser(
        "update",
        help="Update round (platform: verification.update)",
    )
    upd_p.add_argument("--round-id", required=True)
    upd_p.add_argument("--status", default="")
    upd_p.add_argument("--progress", type=float, default=None)
    upd_p.add_argument("--conclusion", default="")
    upd_p.add_argument("--summary", default="")
    upd_p.add_argument("--title", default="")
    upd_p.add_argument("--scenario", default="")
    add_json_input_flags(upd_p)
    add_output_flags(upd_p)
    upd_p.set_defaults(handler=_update)

    concl_p = sub.add_parser(
        "conclude",
        help="Conclude round (platform: verification.conclude)",
    )
    concl_p.add_argument("--round-id", required=True)
    concl_p.add_argument("--conclusion", default="")
    concl_p.add_argument("--status", default="")
    concl_p.add_argument("--summary", default="")
    concl_p.add_argument("--progress", type=float, default=None)
    add_json_input_flags(concl_p)
    add_output_flags(concl_p)
    concl_p.set_defaults(handler=_conclude)

    del_p = sub.add_parser("delete", help="Delete round (platform: verification.delete)")
    del_p.add_argument("round_id")
    del_p.add_argument("--yes", "-y", action="store_true")
    add_output_flags(del_p)
    del_p.set_defaults(handler=_delete)


def _merge(args: argparse.Namespace, **flags) -> dict:
    payload = load_json_payload(args)
    body = dict(payload) if isinstance(payload, dict) else {}
    for k, v in flags.items():
        if v is None:
            continue
        if isinstance(v, str) and not v.strip():
            continue
        if isinstance(v, bool) and not v and k.startswith(("resume", "only", "include")):
            continue
        body[k] = v
    return body


def _catalog(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import verification_catalog

    return verification_catalog(
        _merge(
            args,
            domain=str(getattr(args, "domain", "") or ""),
            risk=str(getattr(args, "risk", "") or ""),
            query=str(getattr(args, "query", "") or ""),
            includeVerification=bool(getattr(args, "include_verification", False)),
        )
    )


def _start(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import verification_start

    return verification_start(
        _merge(
            args,
            title=str(getattr(args, "title", "") or ""),
            scenario=str(getattr(args, "scenario", "") or ""),
            roundId=str(getattr(args, "round_id", "") or ""),
            resume=bool(getattr(args, "resume", False)),
        )
    )


def _init(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import verification_init

    return verification_init(
        _merge(
            args,
            roundId=str(getattr(args, "round_id", "") or ""),
            title=str(getattr(args, "title", "") or ""),
            scenario=str(getattr(args, "scenario", "") or ""),
            onlyMissing=bool(getattr(args, "only_missing", False)),
            includeVerification=bool(getattr(args, "include_verification", False)),
        )
    )


def _get(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import verification_get

    return verification_get(
        {
            "roundId": args.round_id,
            "includeSteps": bool(getattr(args, "include_steps", False)),
        }
    )


def _step(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import verification_step

    feature = str(getattr(args, "feature", "") or "").strip()
    body = _merge(
        args,
        roundId=str(args.round_id),
        feature=feature,
        status=str(getattr(args, "status", "") or ""),
        detail=str(getattr(args, "detail", "") or ""),
        seq=getattr(args, "seq", None),
    )
    if not body.get("feature") and not body.get("api"):
        raise ValidationError("--feature/--api is required (or JSON.feature/api)")
    return verification_step(body)


def _update(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import verification_update

    return verification_update(
        _merge(
            args,
            roundId=str(args.round_id),
            status=str(getattr(args, "status", "") or ""),
            progress=getattr(args, "progress", None),
            conclusion=str(getattr(args, "conclusion", "") or ""),
            summary=str(getattr(args, "summary", "") or ""),
            title=str(getattr(args, "title", "") or ""),
            scenario=str(getattr(args, "scenario", "") or ""),
        )
    )


def _conclude(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import verification_conclude

    return verification_conclude(
        _merge(
            args,
            roundId=str(args.round_id),
            conclusion=str(getattr(args, "conclusion", "") or ""),
            status=str(getattr(args, "status", "") or ""),
            summary=str(getattr(args, "summary", "") or ""),
            progress=getattr(args, "progress", None),
        )
    )


def _delete(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import verification_delete

    if not getattr(args, "yes", False):
        raise ValidationError("Refusing to delete verification round without --yes")
    return verification_delete({"roundId": args.round_id})
