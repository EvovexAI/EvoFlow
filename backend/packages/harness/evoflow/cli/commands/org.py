"""evoflow org — Organization Pack / 资源包 install · list · uninstall."""

from __future__ import annotations

import argparse

from evoflow.cli.common import add_output_flags
from evoflow.organizations.installer import (
    OrganizationInstallError,
    install_organization,
    preflight_organization,
    uninstall_organization,
)
from evoflow.organizations.registry import get_org_instance, list_org_instances


def register(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser(
        "org",
        help="Install / manage Organization Packs (资源包)",
    )
    sub = parser.add_subparsers(dest="org_cmd", required=True)

    pf = sub.add_parser("preflight", help="Validate pack without installing")
    pf.add_argument("path", help="Pack directory or .zip")
    pf.add_argument("--zip", action="store_true", help="Treat path as zip")
    pf.add_argument("--workspace", default="", help="Workspace path for placeholder check")
    pf.add_argument("--id-prefix", default="", help="Prefix for agent/employee codes")
    add_output_flags(pf)
    pf.set_defaults(handler=_preflight)

    inst = sub.add_parser("install", help="Install a resource pack")
    inst.add_argument("path", help="Pack directory or .zip")
    inst.add_argument("--zip", action="store_true", help="Treat path as zip")
    inst.add_argument("--workspace", default="", help="Workspace path to bind")
    inst.add_argument("--id-prefix", default="", help="Prefix for agent/employee codes")
    inst.add_argument(
        "--conflict",
        choices=("fail", "skip", "replace"),
        default="fail",
        help="Conflict policy",
    )
    add_output_flags(inst)
    inst.set_defaults(handler=_install)

    list_p = sub.add_parser("list", help="List installed organization instances")
    list_p.add_argument("--status", default="active", help="active|uninstalled|all")
    add_output_flags(list_p)
    list_p.set_defaults(handler=_list)

    get_p = sub.add_parser("get", help="Get one installed instance")
    get_p.add_argument("org_instance_id")
    add_output_flags(get_p)
    get_p.set_defaults(handler=_get)

    un = sub.add_parser("uninstall", help="Uninstall an organization instance")
    un.add_argument("org_instance_id")
    un.add_argument("--keep-primitives", action="store_true", help="Keep agents/skills")
    un.add_argument("--delete-workspace", action="store_true", help="Also delete workspace dir")
    add_output_flags(un)
    un.set_defaults(handler=_uninstall)

    exp = sub.add_parser("export", help="Export local employees/apps as a resource pack")
    exp.add_argument("--id", default="exported-pack", help="Pack id")
    exp.add_argument("--name", default="导出的资源包", help="Display name")
    exp.add_argument("--version", default="1.0.0")
    exp.add_argument("--employees", default="", help="Comma-separated agent_codes")
    exp.add_argument("--apps", default="", help="Comma-separated app ids")
    exp.add_argument("--output", "-o", required=True, help="Output directory")
    exp.add_argument("--zip", action="store_true", help="Also write a zip next to the directory")
    add_output_flags(exp)
    exp.set_defaults(handler=_export)

    mkt = sub.add_parser("market", help="Market helpers")
    mkt_sub = mkt.add_subparsers(dest="org_market_cmd", required=True)
    cat = mkt_sub.add_parser("catalog", help="Fetch configured catalog.json")
    add_output_flags(cat)
    cat.set_defaults(handler=_market_catalog)

    minst = mkt_sub.add_parser("install", help="Install pack by market path (e.g. packs/foo)")
    minst.add_argument("path", help="Relative path inside market repo")
    minst.add_argument("--workspace", default="")
    minst.add_argument("--repo", default="", help="Optional owner/repo@branch override")
    add_output_flags(minst)
    minst.set_defaults(handler=_market_install)


def _source(args: argparse.Namespace) -> dict:
    path = str(args.path or "").strip()
    is_zip = bool(getattr(args, "zip", False)) or path.lower().endswith(".zip")
    return {"type": "zip_path" if is_zip else "path", "path": path}


def _preflight(args: argparse.Namespace):
    return preflight_organization(
        source=_source(args),
        workspace_path=str(getattr(args, "workspace", "") or "") or None,
        options={"id_prefix": str(getattr(args, "id_prefix", "") or "")},
    )


def _install(args: argparse.Namespace):
    try:
        return install_organization(
            source=_source(args),
            workspace_path=str(getattr(args, "workspace", "") or "") or None,
            options={
                "id_prefix": str(getattr(args, "id_prefix", "") or ""),
                "conflict_policy": str(getattr(args, "conflict", "fail") or "fail"),
            },
        )
    except OrganizationInstallError as e:
        return {"ok": False, "error": str(e), "rolled_back": e.rolled_back}


def _list(args: argparse.Namespace):
    st = str(getattr(args, "status", "active") or "active")
    if st == "all":
        st = ""
    items = list_org_instances(status=st or None)
    return {"items": items, "count": len(items)}


def _get(args: argparse.Namespace):
    inst = get_org_instance(args.org_instance_id)
    if not inst:
        return {"ok": False, "error": f"not found: {args.org_instance_id}"}
    return inst


def _uninstall(args: argparse.Namespace):
    try:
        return uninstall_organization(
            args.org_instance_id,
            options={
                "keep_primitives": bool(getattr(args, "keep_primitives", False)),
                "keep_workspace": not bool(getattr(args, "delete_workspace", False)),
            },
        )
    except OrganizationInstallError as e:
        return {"ok": False, "error": str(e)}


def _export(args: argparse.Namespace):
    from evoflow.organizations.export import OrganizationExportError, export_organization

    employees = [x.strip() for x in str(getattr(args, "employees", "") or "").split(",") if x.strip()]
    apps = [x.strip() for x in str(getattr(args, "apps", "") or "").split(",") if x.strip()]
    try:
        return export_organization(
            pack={
                "id": str(getattr(args, "id", "") or "exported-pack"),
                "name": str(getattr(args, "name", "") or "导出的资源包"),
                "version": str(getattr(args, "version", "") or "1.0.0"),
            },
            include={"employee_codes": employees, "app_ids": apps},
            output={"dir": str(args.output), "zip": bool(getattr(args, "zip", False))},
        )
    except OrganizationExportError as e:
        return {"ok": False, "error": str(e)}


def _market_catalog(args: argparse.Namespace):
    import json
    import urllib.request

    from evoflow.organizations.fetch import market_catalog_url

    url = market_catalog_url()
    if not url:
        return {"configured": False, "packs": [], "schema": 1}
    with urllib.request.urlopen(url, timeout=15) as resp:  # noqa: S310
        data = json.loads(resp.read().decode("utf-8", errors="replace"))
    if isinstance(data, dict):
        data["configured"] = True
        data["source"] = url
    return data


def _market_install(args: argparse.Namespace):
    try:
        return install_organization(
            source={
                "type": "market_path",
                "path": str(args.path),
                "repo": str(getattr(args, "repo", "") or "") or None,
            },
            workspace_path=str(getattr(args, "workspace", "") or "") or None,
            options={"conflict_policy": "fail"},
        )
    except OrganizationInstallError as e:
        return {"ok": False, "error": str(e), "rolled_back": e.rolled_back}
