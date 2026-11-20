"""evoflow sessions subcommands — search past chat history."""

from __future__ import annotations

import argparse

from evoflow.cli.common import add_output_flags


def register(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser(
        "sessions",
        help="Search / status / compact chat sessions (历史会话)",
    )
    sub = parser.add_subparsers(dest="sessions_cmd", required=True)

    search_p = sub.add_parser("search", help="Keyword search in past conversations")
    search_p.add_argument("--query", "-q", required=True, help="Search keywords or phrase")
    search_p.add_argument("--titles", action="store_true", help="Also search session titles when no message hits")
    search_p.add_argument("--limit", type=int, default=5, help="Max sessions to return (default 5)")
    search_p.add_argument("--max-age-days", type=int, default=90, help="Look back N days (0 = ~10 years)")
    add_output_flags(search_p)
    search_p.set_defaults(handler=_search)

    status_p = sub.add_parser(
        "status",
        help="Session / context status (platform: sessions.status)",
    )
    status_p.add_argument("--session-key", default="", help="Session key")
    status_p.add_argument("--thread-id", default="", help="Thread id")
    add_output_flags(status_p)
    status_p.set_defaults(handler=_status)

    compact_p = sub.add_parser(
        "compact",
        help="Compact session context (platform: sessions.compact)",
    )
    compact_p.add_argument("--session-key", default="", help="Session key")
    compact_p.add_argument("--thread-id", default="", help="Thread id")
    # 【self-evolution-bot · 2026-11-20 · 第94轮 · 模型:deepseek-v4.1-flash-1017】
    # 改了什么：补 `--summary` / `--summary-file` 两个参数，与 platform 动作的
    #   `summary` 对齐。
    # 为什么：`sessions.compact` 后端已支持调用方自带摘要（0 次压缩模型调用），
    #   但 CLI 这一层只透传 session_key/thread_id —— 命令行是**人**最常用的入口，
    #   缺这两个参数等于把一个已交付能力挡在门外。属「功能做了但入口没接」，
    #   与前几轮「接线对了但键/入口漏了」同型。
    compact_p.add_argument(
        "--summary",
        default="",
        help="你的结构化摘要正文；给了就跳过压缩模型（不自带则走原路径）",
    )
    compact_p.add_argument(
        "--summary-file",
        default="",
        help="从文件读摘要正文（与 --summary 二选一，优先 file）",
    )
    add_output_flags(compact_p)
    compact_p.set_defaults(handler=_compact)


def _search(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import sessions_search

    return sessions_search(
        {
            "query": args.query,
            "search_titles": bool(args.titles),
            "limit": int(args.limit or 5),
            "max_age_days": int(args.max_age_days or 90),
        }
    )


def _status(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import sessions_status

    return sessions_status(
        {
            "session_key": str(getattr(args, "session_key", "") or "").strip() or None,
            "thread_id": str(getattr(args, "thread_id", "") or "").strip() or None,
        }
    )


def _compact(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import sessions_compact

    # 【self-evolution-bot · 2026-11-20 · 第94轮 · 模型:deepseek-v4.1-flash-1017】
    # 改了什么：把 `--summary` / `--summary-file` 传给 handler 的 `summary` 键。
    # 为什么：handler 读 `summary`/`compacted_summary`/`digest` 三个别名；CLI 不传
    #   就等于只能走压缩模型老路。摘要正文可能很长，`--summary-file` 走文件更实用。
    summary = str(getattr(args, "summary", "") or "").strip()
    summary_file = str(getattr(args, "summary_file", "") or "").strip()
    if summary_file:
        from pathlib import Path

        try:
            summary = Path(summary_file).read_text(encoding="utf-8").strip()
        except OSError as exc:
            return {"ok": False, "error": f"读不到摘要文件: {exc}", "path": summary_file}
    return sessions_compact(
        {
            "session_key": str(getattr(args, "session_key", "") or "").strip() or None,
            "thread_id": str(getattr(args, "thread_id", "") or "").strip() or None,
            "summary": summary or None,
        }
    )
