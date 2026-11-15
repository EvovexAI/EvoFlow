"""evoflow ui — 右侧面板控制（对齐 platform ui.*；需面板/Gateway 会话环境）。"""

from __future__ import annotations

import argparse

from evoflow.cli.common import add_json_input_flags, add_output_flags, load_json_payload


def register(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser(
        "ui",
        help="Right-panel show/update/hide (platform: ui.*)",
        description=(
            "Chat-panel surface control. Best-effort outside a live chat session;\n"
            "kind examples: collab-workflow | employeeProcess | web-embed | artifacts"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="ui_cmd", required=True)

    show_p = sub.add_parser("show", help="Show right panel (platform: ui.show)")
    show_p.add_argument("--kind", required=True, help="Panel kind")
    show_p.add_argument("--title", default="")
    show_p.add_argument("--layout", default="")
    add_json_input_flags(show_p)
    add_output_flags(show_p)
    show_p.set_defaults(handler=_show)

    upd_p = sub.add_parser("update", help="Update right panel (platform: ui.update)")
    upd_p.add_argument("--kind", required=True)
    upd_p.add_argument("--title", default="")
    upd_p.add_argument("--layout", default="")
    add_json_input_flags(upd_p)
    add_output_flags(upd_p)
    upd_p.set_defaults(handler=_update)

    hide_p = sub.add_parser("hide", help="Hide right panel (platform: ui.hide)")
    add_output_flags(hide_p)
    hide_p.set_defaults(handler=_hide)


def _panel_body(args: argparse.Namespace) -> dict:
    payload = load_json_payload(args)
    data = payload if isinstance(payload, dict) else {}
    # Allow nested data key or flat fields as panel data.
    if "data" in data and isinstance(data.get("data"), dict):
        panel_data = data["data"]
    else:
        panel_data = {
            k: v
            for k, v in data.items()
            if k not in {"kind", "title", "layout", "panel_kind", "surface_kind"}
        }
    body: dict = {"kind": args.kind, "data": panel_data}
    title = str(getattr(args, "title", "") or data.get("title") or "").strip()
    layout = str(getattr(args, "layout", "") or data.get("layout") or "").strip()
    if title:
        body["title"] = title
    if layout:
        body["layout"] = layout
    return body


def _show(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import ui_show

    return ui_show(_panel_body(args))


def _update(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import ui_update

    return ui_update(_panel_body(args))


def _hide(_args: argparse.Namespace):
    from evoflow.admin.platform_handlers import ui_hide

    return ui_hide({})
