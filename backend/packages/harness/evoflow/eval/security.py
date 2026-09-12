"""Security evaluator - real-data security metrics.

Covers: data leak scan, permission matrix, config audit, vulnerabilities.
All results come from real database/config - NO mock data.
Empty data returns empty structures.
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any

from evoflow.persistence.db import get_db

logger = logging.getLogger(__name__)

# Sensitive data patterns for leak detection
_LEAK_PATTERNS: dict[str, re.Pattern] = {
    "api_key": re.compile(r"\bsk-[A-Za-z0-9]{20,}\b"),
    "jwt": re.compile(
        r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"
    ),
    "private_key": re.compile(
        r"-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----"
    ),
    "password_field": re.compile(
        r"(?:password|passwd|pwd)\s*[:=]\s*['\"]?[^\s'\";]{6,}", re.IGNORECASE
    ),
    "email": re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
    "phone_cn": re.compile(r"\b1[3-9]\d{9}\b"),
    "aws_access_key": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "github_token": re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),
}


def _table_exists(db: Any, name: str) -> bool:
    try:
        row = db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            (name,),
        ).fetchone()
        return row is not None
    except Exception:  # noqa: BLE001
        return False


def _columns(db: Any, name: str) -> set[str]:
    if not _table_exists(db, name):
        return set()
    try:
        rows = db.execute(f'PRAGMA table_info("{name}")').fetchall()
        return {str(r[1]) for r in rows}
    except Exception:  # noqa: BLE001
        return set()


# ---------------------------------------------------------------------------
# Data leak scan
# ---------------------------------------------------------------------------

def scan_data_leaks(days: int = 7, limit: int = 50, *, module: str | None = None) -> dict[str, Any]:
    """Scan chat messages for sensitive data leaks.

    Args:
        days: Lookback window in days.
        limit: Max findings to return.
        module: Eval framework taxonomy key (e.g. 'obs_security'). Unused here but accepted for compatibility.
    """
    db = get_db()

    if not _table_exists(db, "evoflow_chat_messages"):
        return {
            "days": days,
            "total_findings": 0,
            "by_type": {},
            "findings": [],
            "scanned_messages": 0,
            "_table_missing": True,
        }

    cols = _columns(db, "evoflow_chat_messages")
    content_col = None
    for c in ("content_json", "content", "content_text"):
        if c in cols:
            content_col = c
            break

    if not content_col:
        return {
            "days": days,
            "total_findings": 0,
            "by_type": {},
            "findings": [],
            "scanned_messages": 0,
            "_table_missing": False,
            "_reason": "no_content_column",
        }

    import time as _t
    since_ms = int(_t.time() * 1000) - days * 86400 * 1000

    try:
        ts_col = "created_at_ms" if "created_at_ms" in cols else None
        if ts_col:
            rows = db.execute(
                f"""
                SELECT id, session_key, {content_col} AS content, {ts_col} AS ts
                FROM evoflow_chat_messages
                WHERE {ts_col} >= ?
                LIMIT 5000
                """,
                (since_ms,),
            ).fetchall()
        else:
            rows = db.execute(
                f"SELECT id, session_key, {content_col} AS content "
                f"FROM evoflow_chat_messages LIMIT 5000"
            ).fetchall()
    except Exception:  # noqa: BLE001
        logger.exception("data leak scan query failed")
        return {
            "days": days,
            "total_findings": 0,
            "by_type": {},
            "findings": [],
            "scanned_messages": 0,
            "_table_missing": False,
        }

    findings: list[dict[str, Any]] = []
    by_type: dict[str, int] = {k: 0 for k in _LEAK_PATTERNS}
    scanned = len(rows)

    for row in rows:
        content = str(row["content"] or "")
        if not content:
            continue
        for leak_type, pattern in _LEAK_PATTERNS.items():
            matches = pattern.findall(content)
            if not matches:
                continue
            by_type[leak_type] += len(matches)
            if len(findings) < limit:
                masked = []
                for m in matches[:3]:
                    m_str = str(m)
                    if len(m_str) > 6:
                        masked.append(m_str[:4] + "***" + m_str[-2:])
                    else:
                        masked.append("***")
                findings.append({
                    "type": leak_type,
                    "message_id": row["id"],
                    "session_key": row["session_key"],
                    "preview_masked": "; ".join(masked),
                    "match_count": len(matches),
                })

    by_type = {k: v for k, v in by_type.items() if v > 0}

    return {
        "days": days,
        "total_findings": sum(by_type.values()),
        "by_type": by_type,
        "findings": findings,
        "scanned_messages": scanned,
        "_table_missing": False,
    }


# ---------------------------------------------------------------------------
# Permission matrix
# ---------------------------------------------------------------------------

def get_permission_matrix(*, module: str | None = None) -> dict[str, Any]:
    """Get role -> permission mapping from auth tables.

    Args:
        module: Eval framework taxonomy key (e.g. 'obs_security'). Unused here but accepted for compatibility.
    """
    db = get_db()
    roles: list[dict[str, Any]] = []
    permissions: list[dict[str, Any]] = []
    role_perms: dict[str, list[str]] = {}

    role_table = None
    for t in ("evoflow_roles", "evoflow_user_roles", "roles"):
        if _table_exists(db, t):
            role_table = t
            break

    perm_table = None
    for t in ("evoflow_permissions", "evoflow_role_permissions", "permissions"):
        if _table_exists(db, t):
            perm_table = t
            break

    if role_table:
        try:
            rows = db.execute(f"SELECT * FROM {role_table} LIMIT 50").fetchall()
            for r in rows:
                d = {k: r[k] for k in r.keys()} if hasattr(r, "keys") else dict(r)
                roles.append(d)
        except Exception:  # noqa: BLE001
            pass

    if perm_table:
        try:
            rows = db.execute(f"SELECT * FROM {perm_table} LIMIT 100").fetchall()
            for r in rows:
                d = {k: r[k] for k in r.keys()} if hasattr(r, "keys") else dict(r)
                permissions.append(d)
        except Exception:  # noqa: BLE001
            pass

    user_count = 0
    for t in ("evoflow_users", "evoflow_auth_users", "users"):
        if _table_exists(db, t):
            try:
                row = db.execute(f"SELECT COUNT(*) AS c FROM {t}").fetchone()
                user_count = int(row[0]) if row else 0
            except Exception:  # noqa: BLE001
                pass
            break

    return {
        "roles": roles,
        "permissions": permissions,
        "role_permission_map": role_perms,
        "user_count": user_count,
        "_table_missing": role_table is None and perm_table is None,
    }


# ---------------------------------------------------------------------------
# Security config check (vulnerability scan)
# ---------------------------------------------------------------------------

def check_security_config(*, module: str | None = None) -> dict[str, Any]:
    """Check security config and generate vulnerability list.

    Args:
        module: Eval framework taxonomy key (e.g. 'obs_security'). Unused here but accepted for compatibility.
    """
    vulns: list[dict[str, Any]] = []

    # 1. Debug mode
    debug_env = os.getenv("DEBUG", "").lower()
    if debug_env in ("1", "true", "yes"):
        vulns.append({
            "id": "SEC-001",
            "name": "Debug mode is enabled",
            "severity": "high",
            "category": "configuration",
            "description": "DEBUG env var is true, should be off in production",
            "recommendation": "Set DEBUG=false or remove the DEBUG env var",
            "status": "open",
        })

    # 2. Weak secrets
    weak_keywords = ("test", "default", "changeme", "123456", "secret")
    for env_name in ("API_KEY", "SECRET_KEY", "JWT_SECRET", "DB_PASSWORD"):
        val = os.getenv(env_name, "")
        if val and any(kw in val.lower() for kw in weak_keywords):
            vulns.append({
                "id": f"SEC-002-{env_name}",
                "name": f"Weak secret detected for {env_name}",
                "severity": "critical",
                "category": "secret",
                "description": f"Env var {env_name} contains a weak keyword",
                "recommendation": "Use a strong random secret, at least 32 chars",
                "status": "open",
            })

    # 3. CORS wildcard
    cors_origin = os.getenv("CORS_ORIGIN", os.getenv("ALLOWED_ORIGINS", ""))
    if cors_origin == "*":
        vulns.append({
            "id": "SEC-003",
            "name": "CORS allows all origins",
            "severity": "medium",
            "category": "configuration",
            "description": "CORS_ORIGIN is set to *, allowing any cross-origin request",
            "recommendation": "Restrict to a list of trusted domains",
            "status": "open",
        })

    # 4. Auto-approve ACP
    auto_approve = os.getenv("AUTO_APPROVE_ACP", "").lower()
    if auto_approve in ("1", "true", "yes"):
        vulns.append({
            "id": "SEC-004",
            "name": "ACP auto-approve is enabled",
            "severity": "medium",
            "category": "permission",
            "description": "auto_approve_acp is true, agent tool calls skip human review",
            "recommendation": "Disable auto-approve for sensitive operations in production",
            "status": "open",
        })

    # 5. HTTPS not enforced
    use_https = os.getenv("USE_HTTPS", os.getenv("FORCE_HTTPS", "")).lower()
    if not use_https or use_https in ("0", "false", "no"):
        vulns.append({
            "id": "SEC-005",
            "name": "HTTPS enforcement not detected",
            "severity": "medium",
            "category": "transport",
            "description": "No HTTPS enforcement config detected",
            "recommendation": "Enable HTTPS and configure HSTS in production",
            "status": "open",
        })

    # 6. Sandbox disabled
    sandbox_disabled = os.getenv("DISABLE_SANDBOX", "").lower()
    if sandbox_disabled in ("1", "true", "yes"):
        vulns.append({
            "id": "SEC-006",
            "name": "Sandbox is disabled",
            "severity": "high",
            "category": "sandbox",
            "description": "DISABLE_SANDBOX is true, MCP tools run without sandbox limits",
            "recommendation": "Enable sandbox to restrict MCP tool system access",
            "status": "open",
        })

    by_severity: dict[str, int] = {}
    for v in vulns:
        sev = v["severity"]
        by_severity[sev] = by_severity.get(sev, 0) + 1

    return {
        "total": len(vulns),
        "by_severity": by_severity,
        "vulnerabilities": vulns,
        "_table_missing": False,
    }


def list_vulnerabilities(
    limit: int = 50,
    severity: str | None = None,
) -> dict[str, Any]:
    """List vulnerabilities, optionally filtered by severity."""
    result = check_security_config()
    vulns = result["vulnerabilities"]
    if severity:
        vulns = [v for v in vulns if v["severity"] == severity]
    vulns = vulns[:limit]
    return {
        "total": len(vulns),
        "vulnerabilities": vulns,
        "by_severity": result["by_severity"],
        "_table_missing": False,
    }


# ---------------------------------------------------------------------------
# Audit log stats
# ---------------------------------------------------------------------------

def get_audit_stats(days: int = 7) -> dict[str, Any]:
    """Audit log statistics. Empty if no audit table exists."""
    db = get_db()

    audit_table = None
    for t in ("evoflow_audit_logs", "evoflow_audit", "audit_logs"):
        if _table_exists(db, t):
            audit_table = t
            break

    if not audit_table:
        return {
            "days": days,
            "total": 0,
            "by_action": {},
            "by_user": {},
            "recent": [],
            "_table_missing": True,
        }

    try:
        row = db.execute(f"SELECT COUNT(*) AS c FROM {audit_table}").fetchone()
        total = int(row[0]) if row else 0
    except Exception:  # noqa: BLE001
        total = 0

    return {
        "days": days,
        "total": total,
        "by_action": {},
        "by_user": {},
        "recent": [],
        "_table_missing": False,
    }


# ---------------------------------------------------------------------------
# Security summary
# ---------------------------------------------------------------------------

def get_security_summary(days: int = 7) -> dict[str, Any]:
    """Overall security summary."""
    leak_result = scan_data_leaks(days, limit=10)
    perm_result = get_permission_matrix()
    vuln_result = check_security_config()
    audit_result = get_audit_stats(days)

    # Score calculation (out of 100)
    score = 100
    by_sev = vuln_result.get("by_severity", {})
    score -= by_sev.get("critical", 0) * 20
    score -= by_sev.get("high", 0) * 15
    score -= by_sev.get("medium", 0) * 8
    score -= by_sev.get("low", 0) * 3
    score -= min(leak_result["total_findings"], 10) * 5
    score = max(0, min(100, score))

    if score >= 90:
        level = "excellent"
    elif score >= 75:
        level = "good"
    elif score >= 60:
        level = "warning"
    else:
        level = "critical"

    return {
        "score": score,
        "level": level,
        "days": days,
        "vulnerabilities": {
            "total": vuln_result["total"],
            "by_severity": vuln_result["by_severity"],
        },
        "data_leaks": {
            "total": leak_result["total_findings"],
            "by_type": leak_result["by_type"],
            "scanned_messages": leak_result["scanned_messages"],
        },
        "permissions": {
            "role_count": len(perm_result["roles"]),
            "user_count": perm_result["user_count"],
        },
        "audit": {
            "total": audit_result["total"],
            "table_exists": not audit_result.get("_table_missing", False),
        },
        "_table_missing": {
            "chat_messages": leak_result.get("_table_missing", False),
            "auth": perm_result.get("_table_missing", False),
            "audit": audit_result.get("_table_missing", False),
        },
    }
