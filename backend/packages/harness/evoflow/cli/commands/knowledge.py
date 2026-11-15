"""evoflow knowledge — owned knowledge bases (legacy Obsidian vaults removed).

对齐 platform knowledge.*：``bases``=knowledge.list（列库）、``list``=knowledge.notes
（列笔记）、``recall``=knowledge.search、``remember``=knowledge.ingest、
``get``=knowledge.note_get、``delete``=knowledge.note_delete、``create``=knowledge.create、
``delete-base``=knowledge.delete、``requeue``=knowledge.requeue、``reindex``=knowledge.reindex。
遗留 Obsidian Vault API（list_vaults/set_vault_enabled/create_managed_vault）已随
「知识库归一」移除，对应 CLI 死链子命令一并删除。
"""

from __future__ import annotations

import argparse

from evoflow.admin import knowledge as knowledge_admin
from evoflow.admin.errors import ValidationError
from evoflow.cli.common import add_json_input_flags, add_output_flags, load_json_payload


def register(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser(
        "knowledge",
        help="Search / browse platform-owned knowledge bases",
        description=(
            "Platform-owned knowledge bases (kb_…).\n"
            "Omit --vault to search/list across all owned bases; pass --vault kb_… for one base.\n"
            "Subcommands mirror platform knowledge.* (bases/list/recall/remember/get/delete/create)."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="knowledge_cmd", required=True)

    bases_p = sub.add_parser("bases", help="List owned knowledge bases (platform: knowledge.list)")
    add_output_flags(bases_p)
    bases_p.set_defaults(handler=_bases)

    create_p = sub.add_parser(
        "create",
        help="Create a platform-owned knowledge base (platform: knowledge.create)",
        description=(
            "Create an owned knowledge base (kb_…), same as platform knowledge.create.\n"
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
    add_json_input_flags(create_p)
    add_output_flags(create_p)
    create_p.set_defaults(handler=_create)

    list_p = sub.add_parser("list", help="List notes in owned KB (platform: knowledge.notes)")
    list_p.add_argument("--vault", help="Owned kb_… id (optional)")
    list_p.add_argument("--prefix", default="", help="Only notes under this path prefix")
    list_p.add_argument("--limit", type=int, default=80)
    add_output_flags(list_p)
    list_p.set_defaults(handler=_list)

    get_p = sub.add_parser("get", help="Read one note (platform: knowledge.note_get)")
    get_p.add_argument("path", help="docId or relative path, e.g. guides/foo.md")
    get_p.add_argument("--vault", help="Owned kb_… id (optional; searches all if omitted)")
    add_output_flags(get_p)
    get_p.set_defaults(handler=_get)

    remember_p = sub.add_parser(
        "remember",
        help="Ingest a note into an owned KB inbox (platform: knowledge.ingest)",
        description="JSON payload fields:\n"
        "  title (required)               Note title\n"
        "  knowledge|content (required)   Note body\n"
        "  vaultId                        Optional kb_… id (or use --vault)\n"
        "  inboxPath                      Optional inbox folder (default 00-Inbox)\n",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    remember_p.add_argument("--vault", help="Owned kb_… id")
    add_json_input_flags(remember_p)
    add_output_flags(remember_p)
    remember_p.set_defaults(handler=_remember)

    recall_p = sub.add_parser("recall", help="Search owned knowledge bases (platform: knowledge.search)")
    recall_p.add_argument("query")
    recall_p.add_argument("--vault", help="Owned kb_… id (omit = all owned bases)")
    recall_p.add_argument(
        "--mode",
        default="hybrid",
        help="hybrid|semantic|keyword|title",
    )
    recall_p.add_argument("--category", help="Optional tag filter")
    recall_p.add_argument("--limit", type=int, default=8)
    add_output_flags(recall_p)
    recall_p.set_defaults(handler=_recall)

    del_p = sub.add_parser("delete", help="Delete a note (platform: knowledge.note_delete)")
    del_p.add_argument("path", help="KB-relative note path")
    del_p.add_argument("--vault", help="Owned kb_… id")
    add_output_flags(del_p)
    del_p.set_defaults(handler=_delete)

    delete_base_p = sub.add_parser(
        "delete-base",
        help="Delete an owned knowledge base (platform: knowledge.delete)",
    )
    delete_base_p.add_argument("kb_id", help="Owned kb_… id")
    delete_base_p.add_argument(
        "--yes",
        "-y",
        action="store_true",
        help="Skip interactive confirm (required in non-TTY / agent duty)",
    )
    add_output_flags(delete_base_p)
    delete_base_p.set_defaults(handler=_delete_base)

    requeue_p = sub.add_parser(
        "requeue",
        help="Requeue stuck index jobs (platform: knowledge.requeue)",
    )
    requeue_p.add_argument("--vault", "--kb", dest="vault", default="", help="Owned kb_… id (optional)")
    requeue_p.add_argument("--limit", type=int, default=200)
    add_output_flags(requeue_p)
    requeue_p.set_defaults(handler=_requeue)

    reindex_p = sub.add_parser(
        "reindex",
        help="Reindex an owned knowledge base (platform: knowledge.reindex)",
    )
    reindex_p.add_argument("kb_id", help="Owned kb_… id")
    reindex_p.add_argument(
        "--embedding-model-ref",
        default="",
        help="Optional embedding model registry ref",
    )
    reindex_p.add_argument(
        "--force",
        action="store_true",
        help="Force full rebuild (default: incremental)",
    )
    add_output_flags(reindex_p)
    reindex_p.set_defaults(handler=_reindex)


def _bases(args: argparse.Namespace):
    return knowledge_admin.list_bases()


def _create(args: argparse.Namespace):
    payload = load_json_payload(args)
    data = dict(payload) if isinstance(payload, dict) else {}
    name = str(args.name or data.get("name") or data.get("title") or "").strip()
    if not name:
        raise ValidationError("name is required (--name or JSON.name)")
    description = str(args.description or data.get("description") or data.get("desc") or "").strip()
    emb_ref = str(args.embedding_model_ref or data.get("embeddingModelRef") or data.get("embedding_model_ref") or "").strip() or None
    return knowledge_admin.create_owned_base(
        name=name,
        description=description,
        embedding_model_ref=emb_ref,
    )


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
        kb_id=args.vault,
        category=args.category,
        limit=args.limit,
        mode=args.mode,
    )


def _delete(args: argparse.Namespace):
    return knowledge_admin.delete_knowledge(args.path, vault_id=args.vault)


def _delete_base(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import knowledge_delete

    if not getattr(args, "yes", False):
        raise ValidationError("Refusing to delete knowledge base without --yes (irreversible soft-delete)")
    return knowledge_delete({"kbId": args.kb_id})


def _requeue(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import knowledge_requeue

    return knowledge_requeue(
        {
            "kbId": str(getattr(args, "vault", "") or "").strip() or None,
            "limit": int(getattr(args, "limit", 200) or 200),
        }
    )


def _reindex(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import knowledge_reindex

    return knowledge_reindex(
        {
            "kbId": args.kb_id,
            "embeddingModelRef": str(getattr(args, "embedding_model_ref", "") or "").strip() or None,
            "force": bool(getattr(args, "force", False)),
        }
    )
