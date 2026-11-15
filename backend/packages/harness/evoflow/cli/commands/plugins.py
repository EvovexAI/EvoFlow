"""evoflow plugins — 插件与 marketplace（对齐 platform plugins.*）。"""

from __future__ import annotations

import argparse

from evoflow.admin.errors import ValidationError
from evoflow.cli.common import add_output_flags


def register(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser(
        "plugins",
        help="Manage plugins / marketplace (platform: plugins.*)",
    )
    sub = parser.add_subparsers(dest="plugins_cmd", required=True)

    ov_p = sub.add_parser("overview", help="Plugins overview (platform: plugins.overview)")
    add_output_flags(ov_p)
    ov_p.set_defaults(handler=_overview)

    list_p = sub.add_parser("list", help="List installed plugins (platform: plugins.list)")
    add_output_flags(list_p)
    list_p.set_defaults(handler=_list)

    desc_p = sub.add_parser("describe", help="Describe marketplace plugin (platform: plugins.describe)")
    desc_p.add_argument("marketplace")
    desc_p.add_argument("name")
    add_output_flags(desc_p)
    desc_p.set_defaults(handler=_describe)

    inst_p = sub.add_parser("install", help="Install plugin (platform: plugins.install)")
    inst_p.add_argument("marketplace")
    inst_p.add_argument("name", help="Plugin name")
    inst_p.add_argument("--scope", default="", help="Optional install scope")
    add_output_flags(inst_p)
    inst_p.set_defaults(handler=_install)

    en_p = sub.add_parser("enable", help="Enable/disable plugin (platform: plugins.enable)")
    en_p.add_argument("plugin_id")
    en_p.add_argument("--enabled", action="store_true", default=None)
    en_p.add_argument("--disabled", action="store_true")
    add_output_flags(en_p)
    en_p.set_defaults(handler=_enable)

    upd_p = sub.add_parser("update", help="Update plugin (platform: plugins.update)")
    upd_p.add_argument("plugin_id")
    add_output_flags(upd_p)
    upd_p.set_defaults(handler=_update)

    rst_p = sub.add_parser("restore", help="Restore plugin (platform: plugins.restore)")
    rst_p.add_argument("plugin_id")
    add_output_flags(rst_p)
    rst_p.set_defaults(handler=_restore)

    un_p = sub.add_parser("uninstall", help="Uninstall plugin (platform: plugins.uninstall)")
    un_p.add_argument("plugin_id")
    un_p.add_argument("--remove-cache", action="store_true")
    un_p.add_argument("--yes", "-y", action="store_true")
    add_output_flags(un_p)
    un_p.set_defaults(handler=_uninstall)

    m_add = sub.add_parser(
        "marketplace-add",
        help="Add marketplace source (platform: plugins.marketplace_add)",
    )
    m_add.add_argument("source", help="Marketplace source URL / id")
    add_output_flags(m_add)
    m_add.set_defaults(handler=_marketplace_add)

    m_rm = sub.add_parser(
        "marketplace-remove",
        help="Remove marketplace (platform: plugins.marketplace_remove)",
    )
    m_rm.add_argument("marketplace")
    m_rm.add_argument("--yes", "-y", action="store_true")
    add_output_flags(m_rm)
    m_rm.set_defaults(handler=_marketplace_remove)

    m_rf = sub.add_parser(
        "marketplace-refresh",
        help="Refresh marketplace catalog (platform: plugins.marketplace_refresh)",
    )
    m_rf.add_argument("--marketplace", default="", help="Optional marketplace id")
    add_output_flags(m_rf)
    m_rf.set_defaults(handler=_marketplace_refresh)


def _overview(_args: argparse.Namespace):
    from evoflow.admin.platform_handlers import plugins_overview

    return plugins_overview({})


def _list(_args: argparse.Namespace):
    from evoflow.admin.platform_handlers import plugins_list

    return plugins_list({})


def _describe(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import plugins_describe

    return plugins_describe({"marketplace": args.marketplace, "name": args.name})


def _install(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import plugins_install

    body: dict = {"marketplace": args.marketplace, "name": args.name}
    scope = str(getattr(args, "scope", "") or "").strip()
    if scope:
        body["scope"] = scope
    return plugins_install(body)


def _enable(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import plugins_enable

    enabled = False if args.disabled else True
    return plugins_enable({"pluginId": args.plugin_id, "enabled": enabled})


def _update(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import plugins_update

    return plugins_update({"pluginId": args.plugin_id})


def _restore(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import plugins_restore

    return plugins_restore({"pluginId": args.plugin_id})


def _uninstall(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import plugins_uninstall

    if not getattr(args, "yes", False):
        raise ValidationError("Refusing to uninstall without --yes")
    return plugins_uninstall(
        {
            "pluginId": args.plugin_id,
            "removeCache": bool(getattr(args, "remove_cache", False)),
        }
    )


def _marketplace_add(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import plugins_marketplace_add

    return plugins_marketplace_add({"source": args.source})


def _marketplace_remove(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import plugins_marketplace_remove

    if not getattr(args, "yes", False):
        raise ValidationError("Refusing to remove marketplace without --yes")
    return plugins_marketplace_remove({"marketplace": args.marketplace})


def _marketplace_refresh(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import plugins_marketplace_refresh

    body: dict = {}
    mp = str(getattr(args, "marketplace", "") or "").strip()
    if mp:
        body["marketplace"] = mp
    return plugins_marketplace_refresh(body)
