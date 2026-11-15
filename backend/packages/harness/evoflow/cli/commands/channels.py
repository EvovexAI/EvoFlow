"""evoflow channels — IM 渠道（对齐 platform channels.*）。"""

from __future__ import annotations

import argparse

from evoflow.admin.errors import ValidationError
from evoflow.cli.common import add_json_input_flags, add_output_flags, load_json_payload


def register(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser(
        "channels",
        help="Manage IM channels (platform: channels.*)",
        description=(
            "飞书/企微/钉钉/微信等渠道运维入口，薄封装 platform_handlers。\n"
            "  evoflow channels list\n"
            "  evoflow channels get feishu\n"
            "  evoflow channels enable feishu --enabled\n"
            "  evoflow channels registration-begin --name feishu"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="channels_cmd", required=True)

    list_p = sub.add_parser("list", help="List channel status (platform: channels.list)")
    add_output_flags(list_p)
    list_p.set_defaults(handler=_list)

    get_p = sub.add_parser("get", help="Get one channel (platform: channels.get)")
    get_p.add_argument("name", help="Channel name: feishu|wecom|dingtalk|weixin|…")
    add_output_flags(get_p)
    get_p.set_defaults(handler=_get)

    set_p = sub.add_parser(
        "set-config",
        help="Patch channel config (platform: channels.set_config)",
        description="JSON via --file/--stdin as config object, or flat fields.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    set_p.add_argument("name")
    set_p.add_argument("--no-merge", action="store_true", help="Replace instead of merge")
    add_json_input_flags(set_p)
    add_output_flags(set_p)
    set_p.set_defaults(handler=_set_config)

    en_p = sub.add_parser("enable", help="Enable/disable channel (platform: channels.enable)")
    en_p.add_argument("name")
    en_p.add_argument("--enabled", action="store_true", default=None, help="Enable")
    en_p.add_argument("--disabled", action="store_true", help="Disable")
    add_output_flags(en_p)
    en_p.set_defaults(handler=_enable)

    rst_p = sub.add_parser("restart", help="Restart channel (platform: channels.restart)")
    rst_p.add_argument("name")
    add_output_flags(rst_p)
    rst_p.set_defaults(handler=_restart)

    targets_p = sub.add_parser(
        "push-targets",
        help="List recent push targets (platform: channels.push_targets)",
    )
    targets_p.add_argument("--limit", type=int, default=20)
    add_output_flags(targets_p)
    targets_p.set_defaults(handler=_push_targets)

    send_p = sub.add_parser(
        "send-message",
        help="Push text/files to originating IM chat (platform: channels.send_message)",
    )
    send_p.add_argument("--text", "-t", default="", help="Message text")
    send_p.add_argument("--title", default="", help="Optional title")
    send_p.add_argument(
        "--path",
        action="append",
        dest="paths",
        default=[],
        help="File path (repeatable)",
    )
    add_output_flags(send_p)
    send_p.set_defaults(handler=_send_message)

    begin_p = sub.add_parser(
        "registration-begin",
        help="Start QR registration (platform: channels.registration_begin)",
    )
    begin_p.add_argument("--name", default="feishu", help="feishu|weixin|wecom|dingtalk")
    add_output_flags(begin_p)
    begin_p.set_defaults(handler=_reg_begin)

    poll_p = sub.add_parser(
        "registration-poll",
        help="Poll QR registration (platform: channels.registration_poll)",
    )
    poll_p.add_argument("--session-id", required=True)
    poll_p.add_argument("--name", default="feishu")
    add_output_flags(poll_p)
    poll_p.set_defaults(handler=_reg_poll)

    apply_p = sub.add_parser(
        "registration-apply",
        help="Apply completed registration (platform: channels.registration_apply)",
    )
    apply_p.add_argument("--session-id", required=True)
    apply_p.add_argument("--name", default="feishu")
    apply_p.add_argument("--agent-code", default="", help="Optional dedicated bot agent_code")
    apply_p.add_argument("--enabled", action="store_true", default=None)
    add_output_flags(apply_p)
    apply_p.set_defaults(handler=_reg_apply)


def _list(_args: argparse.Namespace):
    from evoflow.admin.platform_handlers import channels_list

    return channels_list({})


def _get(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import channels_get

    return channels_get({"name": args.name})


def _set_config(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import channels_set_config

    payload = load_json_payload(args)
    if not isinstance(payload, dict):
        raise ValidationError("Provide JSON config via --file or --stdin")
    body: dict = {"name": args.name, "merge": not bool(getattr(args, "no_merge", False))}
    if "config" in payload and isinstance(payload.get("config"), dict):
        body["config"] = payload["config"]
    else:
        body["config"] = payload
    return channels_set_config(body)


def _enable(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import channels_enable

    if args.disabled:
        enabled = False
    elif args.enabled:
        enabled = True
    else:
        enabled = True
    return channels_enable({"name": args.name, "enabled": enabled})


def _restart(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import channels_restart

    return channels_restart({"name": args.name})


def _push_targets(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import channels_push_targets

    return channels_push_targets({"limit": int(getattr(args, "limit", 20) or 20)})


def _send_message(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import channels_send_message

    text = str(getattr(args, "text", "") or "").strip()
    paths = list(getattr(args, "paths", None) or [])
    if not text and not paths:
        raise ValidationError("Provide --text and/or --path")
    body: dict = {"confirm": True}
    if text:
        body["text"] = text
    if paths:
        body["paths"] = paths
    title = str(getattr(args, "title", "") or "").strip()
    if title:
        body["title"] = title
    return channels_send_message(body)


def _reg_begin(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import channels_registration_begin

    return channels_registration_begin({"name": str(args.name or "feishu")})


def _reg_poll(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import channels_registration_poll

    return channels_registration_poll(
        {"session_id": args.session_id, "name": str(args.name or "feishu")}
    )


def _reg_apply(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import channels_registration_apply

    body: dict = {
        "session_id": args.session_id,
        "name": str(args.name or "feishu"),
    }
    code = str(getattr(args, "agent_code", "") or "").strip()
    if code:
        body["agent_code"] = code
    if getattr(args, "enabled", None):
        body["enabled"] = True
    return channels_registration_apply(body)
