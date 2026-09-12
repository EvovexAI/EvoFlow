"""evoflow knowledge — owned knowledge bases (Obsidian vaults are legacy)."""

from __future__ import annotations

import argparse

from evoflow.admin import knowledge as knowledge_admin
from evoflow.admin.errors import ValidationError
from evoflow.cli.common import add_json_input_flags, add_output_flags, load_json_payload


def register(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser(
        "knowledge",
        help="Search / browse owned knowledge bases (Obsidian vaults are legacy)",
        description=(
            "Default: self-owned knowledge bases (knowledge.primary=owned).\n"
            "Omit --vault to search/list across all owned bases; pass --vault kb_… for one base.\n"
            "Legacy Obsidian vaults: set knowledge.primary=vault, or use `knowledge vaults`."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="knowledge_cmd", required=True)

    vaults_p = sub.add_parser("vaults", help="List configured Obsidian Knowledge Vaults (legacy)")
    add_output_flags(vaults_p)
    vaults_p.set_defaults(handler=_vaults)

    create_p = sub.add_parser(
        "create",
        help="Create a platform-owned knowledge base (default)",
        description=(
            "Default: create an owned knowledge base (kb_…), same as platform knowledge.create.\n"
            "Legacy Obsidian vault: pass --legacy-vault (optional --path under EVOFLOW_HOME).\n"
            "JSON optional via --file/--stdin: name?, description?, embeddingModelRef?"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    create_p.add_argument("--name", default="", help="Display name (or pass in JSON)")
    create_p.add_argument("--description", default="", help="Optional description")
    create_p.add_argument(
        "--embedding-model-ref",
        dest="embedding_model_ref",
        default="",
        help="Optional embedding model registry ref",
    )
    create_p.add_argument(
        "--legacy-vault",
        action="store_true",
        help="Create Obsidian vault connection instead of owned KB",
    )
    create_p.add_argument("--path", "--vault-path", dest="vault_path", default="", help="Legacy vault directory")
    create_p.add_argument("--access-mode", default="read_write", help="Legacy vault: read_write|read_only")
    create_p.add_argument("--disabled", action="store_true", help="Legacy vault: create as disabled")
    add_json_input_flags(create_p)
    add_output_flags(create_p)
    create_p.set_defaults(handler=_create)

    enable_p = sub.add_parser("enable", help="Enable a vault (platform: knowledge.enable)")
    enable_p.add_argument("vault_id")
    add_output_flags(enable_p)
    enable_p.set_defaults(handler=_enable)

    disable_p = sub.add_parser("disable", help="Disable a vault")
    disable_p.add_argument("vault_id")
    add_output_flags(disable_p)
    disable_p.set_defaults(handler=_disable)

    list_p = sub.add_parser("list", help="List documents in owned KB (or vault notes if primary=vault)")
    list_p.add_argument("--vault", help="Owned kb_… id, or legacy vault id when primary=vault")
    list_p.add_argument("--prefix", default="", help="Only notes under this path prefix")
    list_p.add_argument("--limit", type=int, default=80)
    add_output_flags(list_p)
    list_p.set_defaults(handler=_list)

    get_p = sub.add_parser("get", help="Read one document (docId / path) from owned KB")
    get_p.add_argument("path", help="docId or relative path, e.g. guides/foo.md")
    get_p.add_argument("--vault", help="Owned kb_… id (optional; searches all if omitted)")
    add_output_flags(get_p)
    get_p.set_defaults(handler=_get)

    remember_p = sub.add_parser(
        "remember",
        help="Ingest a note into a read_write vault inbox",
        description="JSON payload fields:\n"
        "  title (required)               Note title\n"
        "  knowledge|content (required)   Note body\n"
        "  tags                           Optional tag list\n"
        "  vaultId                        Optional vault id (or use --vault)\n"
        "  inboxPath                      Optional inbox folder (default 00-Inbox)\n",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    remember_p.add_argument("--vault", help="Vault id (must be read_write)")
    add_json_input_flags(remember_p)
    add_output_flags(remember_p)
    remember_p.set_defaults(handler=_remember)

    recall_p = sub.add_parser("recall", help="Search owned knowledge bases (hybrid by default via owned)")
    recall_p.add_argument("query")
    recall_p.add_argument("--vault", help="Owned kb_… id (omit = all owned bases)")
    recall_p.add_argument(
        "--mode",
        default="hybrid",
        help="hybrid|semantic|keyword|title (owned); legacy vault also supports fulltext",
    )
    recall_p.add_argument("--category", help="Optional tag filter")
    recall_p.add_argument("--limit", type=int, default=8)
    add_output_flags(recall_p)
    recall_p.set_defaults(handler=_recall)

    del_p = sub.add_parser("delete", help="Delete a note path in a read_write vault")
    del_p.add_argument("path", help="Vault-relative note path")
    del_p.add_argument("--vault", help="Vault id")
    add_output_flags(del_p)
    del_p.set_defaults(handler=_delete)


def _vaults(args: argparse.Namespace):
    return knowledge_admin.list_vaults()


def _create(args: argparse.Namespace):
    payload = load_json_payload(args)
    data = dict(payload) if isinstance(payload, dict) else {}
    name = str(args.name or data.get("name") or data.get("title") or "").strip()
    if not name:
        raise ValidationError("name is required (--name or JSON.name)")

    if getattr(args, "legacy_vault", False) or data.get("legacyVault") or data.get("legacy_vault"):
        path = str(args.vault_path or data.get("vaultPath") or data.get("vault_path") or "").strip() or None
        access = str(
            args.access_mode or data.get("accessMode") or data.get("access_mode") or "read_write"
        ).strip()
        enabled = True
        if args.disabled:
            enabled = False
        elif "enabled" in data:
            enabled = bool(data.get("enabled"))
        return knowledge_admin.create_managed_vault(
            name=name,
            vault_path=path,
            enabled=enabled,
            access_mode=access,
        )

    description = str(
        args.description or data.get("description") or data.get("desc") or ""
    ).strip()
    emb_ref = str(
        args.embedding_model_ref
        or data.get("embeddingModelRef")
        or data.get("embedding_model_ref")
        or ""
    ).strip() or None
    return knowledge_admin.create_owned_base(
        name=name,
        description=description,
        embedding_model_ref=emb_ref,
    )


def _enable(args: argparse.Namespace):
    return knowledge_admin.set_vault_enabled(args.vault_id, True)


def _disable(args: argparse.Namespace):
    return knowledge_admin.set_vault_enabled(args.vault_id, False)


def _list(args: argparse.Namespace):
    return knowledge_admin.list_knowledge(
        vault_id=args.vault,
        prefix=args.prefix,
        limit=args.limit,
    )


def _get(args: argparse.Namespace):
    return knowledge_admin.get_knowledge(args.path, vault_id=args.vault)


def _remember(args: argparse.Namespace):
    payload = load_json_payload(args)
    if payload is None:
        raise ValidationError("Provide JSON via --file or --stdin")
    return knowledge_admin.remember(payload, vault_id=args.vault)


def _recall(args: argparse.Namespace):
    return knowledge_admin.recall(
        args.query,
        vault_id=args.vault,
        category=args.category,
        limit=args.limit,
        mode=args.mode,
    )


def _delete(args: argparse.Namespace):
    return knowledge_admin.delete_knowledge(args.path, vault_id=args.vault)
