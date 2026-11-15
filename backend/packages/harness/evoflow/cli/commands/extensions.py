"""evoflow extensions — Agent 应用 / UI 扩展（对齐 platform extensions.*）。"""

from __future__ import annotations

import argparse

from evoflow.admin.errors import ValidationError
from evoflow.cli.common import add_json_input_flags, add_output_flags, load_json_payload


def register(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser(
        "extensions",
        help="Manage Agent apps / UI extensions (platform: extensions.*)",
    )
    sub = parser.add_subparsers(dest="extensions_cmd", required=True)

    list_p = sub.add_parser("list", help="List extensions (platform: extensions.list)")
    add_output_flags(list_p)
    list_p.set_defaults(handler=_list)

    get_p = sub.add_parser("get", help="Get one extension (platform: extensions.get)")
    get_p.add_argument("id")
    add_output_flags(get_p)
    get_p.set_defaults(handler=_get)

    inst_p = sub.add_parser(
        "install",
        help="Install extension (platform: extensions.install)",
        description=(
            "Local dir:  --path DIR [--link]\n"
            "Remote:     --id ID --url ENTRY [--name NAME]\n"
            "Manifest:   --file manifest.json [--install-path PATH]"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    inst_p.add_argument("--path", default="", help="Local extension directory")
    inst_p.add_argument("--id", dest="ext_id", default="", help="Remote extension id")
    inst_p.add_argument("--url", "--entry", dest="entry", default="", help="Remote entry URL")
    inst_p.add_argument("--name", default="", help="Display name (remote)")
    inst_p.add_argument("--install-path", default="", help="Install path for manifest mode")
    inst_p.add_argument("--link", action="store_true", help="Symlink local path instead of copy")
    inst_p.add_argument("--source", default="", help="Optional source label")
    add_json_input_flags(inst_p)
    add_output_flags(inst_p)
    inst_p.set_defaults(handler=_install)

    en_p = sub.add_parser("enable", help="Enable/disable extension (platform: extensions.enable)")
    en_p.add_argument("id")
    en_p.add_argument("--enabled", action="store_true", default=None)
    en_p.add_argument("--disabled", action="store_true")
    add_output_flags(en_p)
    en_p.set_defaults(handler=_enable)

    un_p = sub.add_parser("uninstall", help="Uninstall extension (platform: extensions.uninstall)")
    un_p.add_argument("id")
    un_p.add_argument("--yes", "-y", action="store_true")
    add_output_flags(un_p)
    un_p.set_defaults(handler=_uninstall)


def _list(_args: argparse.Namespace):
    from evoflow.admin.platform_handlers import extensions_list

    return extensions_list({})


def _get(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import extensions_get

    return extensions_get({"id": args.id})


def _install(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import extensions_install

    payload = load_json_payload(args)
    body: dict = {}
    path = str(getattr(args, "path", "") or "").strip()
    ext_id = str(getattr(args, "ext_id", "") or "").strip()
    entry = str(getattr(args, "entry", "") or "").strip()
    name = str(getattr(args, "name", "") or "").strip()
    install_path = str(getattr(args, "install_path", "") or "").strip()
    source = str(getattr(args, "source", "") or "").strip()
    if path:
        body["path"] = path
        if getattr(args, "link", False):
            body["link"] = True
    elif isinstance(payload, dict) and (payload.get("manifest") or payload.get("id") or payload.get("ui")):
        if "manifest" in payload:
            body["manifest"] = payload["manifest"]
        else:
            body["manifest"] = payload
        if install_path:
            body["install_path"] = install_path
        elif payload.get("install_path") or payload.get("installPath"):
            body["install_path"] = payload.get("install_path") or payload.get("installPath")
    elif ext_id and entry:
        body["id"] = ext_id
        body["url"] = entry
        if name:
            body["name"] = name
    else:
        raise ValidationError("Provide --path, or --id+--url, or manifest JSON via --file/--stdin")
    if source:
        body["source"] = source
    return extensions_install(body)


def _enable(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import extensions_enable

    enabled = False if args.disabled else True
    return extensions_enable({"id": args.id, "enabled": enabled})


def _uninstall(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import extensions_uninstall

    if not getattr(args, "yes", False):
        raise ValidationError("Refusing to uninstall without --yes")
    return extensions_uninstall({"id": args.id})
