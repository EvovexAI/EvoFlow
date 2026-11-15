"""evoflow appearance — 外观主题（对齐 platform appearance.patch）。"""

from __future__ import annotations

import argparse

from evoflow.admin.errors import ValidationError
from evoflow.cli.common import add_json_input_flags, add_output_flags, load_json_payload


def register(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser(
        "appearance",
        help="Patch UI appearance (platform: appearance.patch)",
    )
    sub = parser.add_subparsers(dest="appearance_cmd", required=True)

    patch_p = sub.add_parser(
        "patch",
        help="Patch appearance settings (platform: appearance.patch)",
        description=(
            "JSON via --file/--stdin. Keys: theme?, accentPalette?, accentCustom?,\n"
            "backgroundImage?, backgroundOpacity?, liquidGlassEnabled?, …"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    patch_p.add_argument("--theme", default="", help="Theme id / name")
    patch_p.add_argument("--accent-palette", default="")
    patch_p.add_argument("--clear-background", action="store_true")
    add_json_input_flags(patch_p)
    add_output_flags(patch_p)
    patch_p.set_defaults(handler=_patch)


def _patch(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import appearance_patch

    payload = load_json_payload(args)
    body = dict(payload) if isinstance(payload, dict) else {}
    theme = str(getattr(args, "theme", "") or "").strip()
    accent = str(getattr(args, "accent_palette", "") or "").strip()
    if theme:
        body["theme"] = theme
    if accent:
        body["accentPalette"] = accent
    if getattr(args, "clear_background", False):
        body["clearBackground"] = True
    if not body:
        raise ValidationError("Provide appearance fields via flags or JSON --file/--stdin")
    return appearance_patch(body)
