"""evoflow approvals — request / list / approve / reject 岗位工作项审批."""

from __future__ import annotations

import argparse

from evoflow.admin import approvals as approvals_admin
from evoflow.cli.common import add_output_flags


def register(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser(
        "approvals",
        help="岗位工作项审批（员工 request / 用户 approve|reject）",
        description=(
            "智能体员工提审：\n"
            "  evoflow approvals request Task_xxx --note \"请批准方案后再拆下游\"\n"
            "用户处理：\n"
            "  evoflow approvals list\n"
            "  evoflow approvals approve Task_xxx\n"
            "  evoflow approvals reject Task_xxx --reason \"需补充验收标准\"\n"
            "同意后执行走 Gateway（需 Gateway 在跑）。"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="approvals_cmd", required=True)

    list_p = sub.add_parser("list", help="List approvals (default: pending)")
    list_p.add_argument(
        "--status",
        default="pending",
        help="pending|approved|rejected|timeout|all (default pending)",
    )
    list_p.add_argument("--limit", type=int, default=50, help="Max rows")
    add_output_flags(list_p)
    list_p.set_defaults(handler=_list)

    req_p = sub.add_parser(
        "request",
        help="员工：将岗位工作项推入待审批（推送面板/飞书）",
    )
    req_p.add_argument("task_id", help="岗位工作项 Task id")
    req_p.add_argument(
        "--note",
        "-n",
        default="",
        help="提审说明（写入 rationale，用户在详情可见）",
    )
    req_p.add_argument(
        "--risk-level",
        default="",
        help="可选覆盖风险: low|medium|high|critical",
    )
    add_output_flags(req_p)
    req_p.set_defaults(handler=_request)

    ap_p = sub.add_parser("approve", help="用户：同意并执行（需 Gateway）")
    ap_p.add_argument("item_id", help="task_id / approval_id / initiative_id")
    ap_p.add_argument("--comment", default="", help="可选批注")
    ap_p.add_argument("--by", default="cli", help="decided_by label (default cli)")
    add_output_flags(ap_p)
    ap_p.set_defaults(handler=_approve)

    rj_p = sub.add_parser("reject", help="用户：驳回（须写原因）")
    rj_p.add_argument("item_id", help="task_id / approval_id / initiative_id")
    rj_p.add_argument("--reason", "-r", required=True, help="驳回原因（员工下一轮会看到）")
    rj_p.add_argument("--comment", default="", help="可选补充")
    rj_p.add_argument("--by", default="cli", help="decided_by label (default cli)")
    add_output_flags(rj_p)
    rj_p.set_defaults(handler=_reject)


def _list(args: argparse.Namespace):
    return approvals_admin.list_approvals(status=args.status, limit=args.limit)


def _request(args: argparse.Namespace):
    return approvals_admin.request(
        args.task_id,
        note=str(getattr(args, "note", "") or ""),
        risk_level=str(getattr(args, "risk_level", "") or ""),
    )


def _approve(args: argparse.Namespace):
    return approvals_admin.approve(
        args.item_id,
        comment=str(getattr(args, "comment", "") or ""),
        decided_by=str(getattr(args, "by", "") or "cli"),
    )


def _reject(args: argparse.Namespace):
    return approvals_admin.reject(
        args.item_id,
        reason=str(args.reason or ""),
        comment=str(getattr(args, "comment", "") or ""),
        decided_by=str(getattr(args, "by", "") or "cli"),
    )
