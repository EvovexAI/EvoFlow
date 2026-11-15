"""evoflow assets — Entity Asset Hub maintenance."""

from __future__ import annotations

import argparse

from evoflow.assets.migrate import (
    migrate_all,
    migrate_experiences,
    migrate_memory_namespaces,
    migrate_slim_atoms,
)
from evoflow.cli.common import add_json_input_flags, add_output_flags, load_json_payload


def register(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser("assets", help="Entity Asset Hub (~/.evoflow/assets/)")
    sub = parser.add_subparsers(dest="assets_cmd", required=True)

    init_p = sub.add_parser("init", help="Ensure assets tree + builtin vault")
    add_output_flags(init_p)
    init_p.set_defaults(handler=_init)

    profile_get = sub.add_parser(
        "get-profile",
        help="Read user profile (platform: assets.get_profile)",
    )
    add_output_flags(profile_get)
    profile_get.set_defaults(handler=_get_profile)

    profile_upd = sub.add_parser(
        "update-profile",
        help="Update user profile dimension (platform: assets.update_profile)",
        description="JSON via --file/--stdin: path/dimension?, content (required), mode?=append|replace",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    profile_upd.add_argument("--path", default="", help="Dimension path (default USER.md)")
    profile_upd.add_argument("--content", default="", help="Content text (or pass via JSON)")
    profile_upd.add_argument("--mode", default="append", help="append|replace")
    add_json_input_flags(profile_upd)
    add_output_flags(profile_upd)
    profile_upd.set_defaults(handler=_update_profile)

    mig_p = sub.add_parser("migrate", help="Migrate legacy SQLite data into asset files")
    mig_p.add_argument("--dry-run", action="store_true", help="Report only, do not write")
    mig_p.add_argument(
        "--only",
        choices=("all", "experience", "memory", "slim", "agent-memory"),
        default="all",
        help="Migration scope (slim = truncate mem_atoms after file mirror)",
    )
    add_output_flags(mig_p)
    mig_p.set_defaults(handler=_migrate)

    exp_p = sub.add_parser("export", help="Export entity assets as .evoflow-pack")
    exp_p.add_argument("--type", dest="entity_type", default="user", choices=("user", "agent", "employee"))
    exp_p.add_argument("--id", dest="entity_id", default="user")
    exp_p.add_argument("-o", "--output", default="", help="Output path for .evoflow-pack")
    add_output_flags(exp_p)
    exp_p.set_defaults(handler=_export)

    imp_p = sub.add_parser("import", help="Import .evoflow-pack into an entity")
    imp_p.add_argument("pack", help="Path to .evoflow-pack zip")
    imp_p.add_argument("--type", dest="entity_type", required=True, choices=("user", "agent", "employee"))
    imp_p.add_argument("--id", dest="entity_id", required=True)
    imp_p.add_argument("--conflict", choices=("skip", "rename", "overwrite"), default="skip")
    add_output_flags(imp_p)
    imp_p.set_defaults(handler=_import)


def _init(_args: argparse.Namespace):
    from evoflow.admin.platform_handlers import assets_init

    return assets_init({})


def _get_profile(_args: argparse.Namespace):
    from evoflow.admin.platform_handlers import assets_get_profile

    return assets_get_profile({})


def _update_profile(args: argparse.Namespace):
    from evoflow.admin.errors import ValidationError
    from evoflow.admin.platform_handlers import assets_update_profile

    payload = load_json_payload(args)
    data = dict(payload) if isinstance(payload, dict) else {}
    path = str(args.path or data.get("path") or data.get("dimension") or data.get("dim") or "").strip()
    content = args.content or data.get("content") or data.get("text") or data.get("profile")
    mode = str(args.mode or data.get("mode") or "append").strip() or "append"
    if content is None or not str(content).strip():
        raise ValidationError("content is required (--content or JSON.content)")
    body: dict = {"content": content, "mode": mode}
    if path:
        body["path"] = path
    return assets_update_profile(body)


def _migrate(args: argparse.Namespace):
    dry = bool(args.dry_run)
    if args.only == "experience":
        return migrate_experiences(dry_run=dry)
    if args.only == "memory":
        return migrate_memory_namespaces(dry_run=dry)
    if args.only == "slim":
        return migrate_slim_atoms(dry_run=dry)
    if args.only == "agent-memory":
        from evoflow.assets.migrate_agent_memory import migrate_agent_memory_to_user

        return migrate_agent_memory_to_user(dry_run=dry)
    return migrate_all(dry_run=dry)


def _export(args: argparse.Namespace):
    from pathlib import Path

    from evoflow.assets.pack import export_entity_pack
    from evoflow.assets.paths import EntityRef

    out = Path(args.output).expanduser() if str(args.output or "").strip() else None
    return export_entity_pack(
        EntityRef(args.entity_type, args.entity_id),
        output_path=out,
    )


def _import(args: argparse.Namespace):
    from evoflow.assets.pack import import_entity_pack
    from evoflow.assets.paths import EntityRef

    return import_entity_pack(
        args.pack,
        EntityRef(args.entity_type, args.entity_id),
        conflict=args.conflict,
    )
