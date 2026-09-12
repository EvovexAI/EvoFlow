"""CLI: issue Ed25519 activation codes (private key required).

Usage::

    # 一次性生成密钥对（私钥只放运营机，公钥已可写进客户端）
    python -m evoflow.license.cli keygen

    # 签发（需环境变量 EVOFLOW_LICENSE_PRIVATE_KEY）
    set EVOFLOW_LICENSE_PRIVATE_KEY=...
    python -m evoflow.license.cli issue --days 365
    python -m evoflow.license.cli issue --days 1
    python -m evoflow.license.cli issue --machine A1B2... --days 365

    python -m evoflow.license.cli machine-id
"""

from __future__ import annotations

import argparse
import sys
from datetime import UTC, datetime, timedelta


def _parse_expires(value: str) -> int:
    text = str(value or "").strip()
    if not text:
        raise ValueError("empty expiry")
    if len(text) == 10 and text[4] == "-" and text[7] == "-":
        dt = datetime.fromisoformat(text).replace(
            hour=23, minute=59, second=59, tzinfo=UTC
        )
        return int(dt.timestamp())
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return int(dt.astimezone(UTC).timestamp())


def cmd_keygen(_args: argparse.Namespace) -> int:
    from evoflow.license.keys import generate_keypair

    priv, pub, mac = generate_keypair()
    print("# Ed25519 license keypair — 私钥勿提交仓库、勿打进安装包", file=sys.stderr)
    print(f"EVOFLOW_LICENSE_PRIVATE_KEY={priv}")
    print(f"EVOFLOW_LICENSE_PUBLIC_KEY={pub}")
    print(f"EVOFLOW_LICENSE_CODE_MAC={mac}")
    print(
        "# 把 PUBLIC 写入 BUILTIN_LICENSE_PUBLIC_KEY_B64；"
        "把 CODE_MAC 写入 BUILTIN_LICENSE_CODE_MAC_B64（短激活码验签）",
        file=sys.stderr,
    )
    return 0


def cmd_issue(args: argparse.Namespace) -> int:
    from evoflow.license.codec import LicenseCodecError, issue_activation_code
    from evoflow.license.issued_store import insert_issued_code
    from evoflow.license.keys import LicenseKeyError, ensure_private_key_env_loaded
    from evoflow.license.machine import normalize_machine_id
    from evoflow.persistence.db import get_db

    ensure_private_key_env_loaded()

    mid_arg = str(args.machine or "").strip()
    mid: str | None = None
    if mid_arg:
        mid = normalize_machine_id(mid_arg)
        if len(mid) != 16:
            print("error: --machine must be 16 hex chars", file=sys.stderr)
            return 2

    if args.expires:
        exp = _parse_expires(args.expires)
    else:
        days = int(args.days)
        if days <= 0:
            print("error: --days must be > 0", file=sys.stderr)
            return 2
        exp = int((datetime.now(UTC) + timedelta(days=days)).timestamp())

    try:
        code = issue_activation_code(machine_id=mid, expires_at_unix=exp)
    except (LicenseCodecError, LicenseKeyError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    issued_to = str(getattr(args, "to", "") or "").strip()
    note = str(getattr(args, "note", "") or "").strip()
    try:
        get_db()
        insert_issued_code(
            code=code,
            expires_at_unix=exp,
            issued_to=issued_to,
            note=note,
            machine_id=mid or "",
        )
    except Exception as e:
        print(f"# warning: ledger write failed: {e}", file=sys.stderr)

    exp_iso = datetime.fromtimestamp(exp, tz=UTC).isoformat().replace("+00:00", "Z")
    print(code)
    bind = f"machine={mid}" if mid else "bind=first_use"
    who = f" to={issued_to}" if issued_to else ""
    print(f"# {bind}{who} expires_at={exp_iso}", file=sys.stderr)
    return 0


def cmd_machine_id(_args: argparse.Namespace) -> int:
    from evoflow.license.machine import get_machine_id

    print(get_machine_id())
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m evoflow.license.cli")
    sub = p.add_subparsers(dest="command", required=True)

    kg = sub.add_parser("keygen", help="Generate Ed25519 keypair for vendor ops")
    kg.set_defaults(func=cmd_keygen)

    issue = sub.add_parser(
        "issue",
        help="Issue signed activation code (needs EVOFLOW_LICENSE_PRIVATE_KEY)",
    )
    issue.add_argument(
        "--machine",
        default="",
        help="Optional 16-char machine id to pre-bind; omit for floating code",
    )
    issue.add_argument("--days", type=int, default=365)
    issue.add_argument("--expires", default="")
    issue.add_argument(
        "--to",
        default="",
        help="Who this code is for (customer / assignee label for ledger)",
    )
    issue.add_argument("--note", default="", help="Ops note stored in ledger")
    issue.set_defaults(func=cmd_issue)

    mid = sub.add_parser("machine-id", help="Print this host's machine id")
    mid.set_defaults(func=cmd_machine_id)
    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
