"""Tool execution approval — which tools require user consent before running."""

from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any

from evoflow.tools.tool_aliases import canonical_tool_name
from evoflow.utils.workspace_browse import flatten_bound_workspace_absolute, strip_bound_workspace_prefix

# Compound / side-effect shell — never bypass approval via allow_prefix alone.
_COMPOUND_CMD_RE = re.compile(r"[;|]|&&|\|\||`|\$\(|[<>]{1,2}", re.I)
_DESTRUCTIVE_CMD_RE = re.compile(
    r"\b("
    r"rm|rmdir|del|delete|remove-item|remove-itemproperty|move-item|copy-item|"
    r"set-content|out-file|truncate|format|shutdown|reboot|"
    r"curl|wget|docker|npm\s+install|pip\s+install|chmod|chown|kill"
    r")\b",
    re.I,
)


def command_allow_prefix_bypass_ok(command: str) -> bool:
    """``allow_prefixes`` may only skip approval for simple read-style one-liners."""
    cmd = str(command or "").strip()
    if not cmd:
        return False
    if _COMPOUND_CMD_RE.search(cmd):
        return False
    if _DESTRUCTIVE_CMD_RE.search(cmd):
        return False
    return True

_PATH_ARG_TOOLS = frozenset({"delete", "read", "write", "replace"})

# ── Risk levels ──────────────────────────────────────────────
RISK_AUTO = "auto"        # read-only tools — always auto-allowed
RISK_SESSION = "session"  # file modifications — session-level grant
RISK_CONFIRM = "confirm"  # irreversible / external — per-call confirmation

TOOL_RISK_LEVELS: dict[str, str] = {
    # Auto — read-only, no side effects
    "read": RISK_AUTO,
    "search_code_index": RISK_AUTO,
    "find": RISK_AUTO,
    "rg": RISK_AUTO,
    "tool_search": RISK_AUTO,
    "view_image": RISK_AUTO,
    "todo": RISK_AUTO,
    "mind_map": RISK_AUTO,
    "web_search": RISK_AUTO,
    "fetch_url": RISK_AUTO,
    "search_knowledge_base": RISK_AUTO,
    "knowledge": RISK_AUTO,
    "knowledge_search": RISK_AUTO,
    "knowledge_read": RISK_AUTO,
    "knowledge_graph": RISK_AUTO,
    "knowledge_status": RISK_AUTO,
    "knowledge_write": RISK_SESSION,
    "knowledge_ingest": RISK_SESSION,
    "ask_clarification": RISK_AUTO,
    "scenario": RISK_AUTO,
    "propose_goal": RISK_AUTO,
    "propose_hosted_agent": RISK_AUTO,  # legacy alias
    "read_lints": RISK_AUTO,
    "subagent": RISK_AUTO,
    # Session — file modifications (reversible)
    "write": RISK_SESSION,
    "replace": RISK_SESSION,
    # Confirm — irreversible / external side effects
    "delete": RISK_CONFIRM,
    "terminal": RISK_CONFIRM,
    "process": RISK_CONFIRM,
    "bash": RISK_CONFIRM,  # legacy sandbox-mode shell (same risk as terminal)
}

# Tools that require approval (risk > auto); derived from TOOL_RISK_LEVELS
_TOOLS_REQUIRING_APPROVAL = frozenset(
    name for name, level in TOOL_RISK_LEVELS.items() if level != RISK_AUTO
)

# ── Worker task action → risk level mapping ─────────────────
# Worker risk is dynamic: determined by the most dangerous action in ``tasks``.
_WORKER_ACTION_RISK: dict[str, str] = {
    "search": RISK_AUTO,
    "locate": RISK_AUTO,
    "write": RISK_SESSION,
    "replace": RISK_SESSION,
    "edit": RISK_SESSION,
    "delete": RISK_CONFIRM,
}

_LEGACY_PROCESS_START_NAMES = frozenset({"process_start", "process"})

_APPROVE_ALL_PATTERNS = (
    re.compile(r"^\s*/approve\s+all\s*$", re.I),
    re.compile(r"^\s*全部授权\s*$"),
    re.compile(r"^\s*全部允许\s*$"),
    re.compile(r"^\s*grant\s+all\s*$", re.I),
)

_APPROVE_ONE = re.compile(r"^\s*/approve(?:\s+tool)?\s+(\S+)\s*$", re.I)
_DENY_ONE = re.compile(r"^\s*/deny(?:\s+tool)?\s+(\S+)\s*$", re.I)
_APPROVE_ZH = re.compile(r"^\s*批准\s*(\S+)?\s*$")
_DENY_ZH = re.compile(r"^\s*拒绝\s*(\S+)?\s*$")

_PREFIX = "__evf_tool_approval_v1__:"


def _worker_risk_level(args: dict[str, Any]) -> str:
    """Determine worker risk from its ``tasks`` — the highest risk among all sub-tasks."""
    tasks = args.get("tasks")
    if not isinstance(tasks, list):
        return RISK_AUTO  # no tasks → safe (will likely error elsewhere)
    worst = RISK_AUTO
    for task in tasks:
        if not isinstance(task, dict):
            continue
        action = str(task.get("action") or "").strip().lower()
        level = _WORKER_ACTION_RISK.get(action, RISK_AUTO)
        if level == RISK_CONFIRM:
            return RISK_CONFIRM  # can't get worse
        if level == RISK_SESSION:
            worst = RISK_SESSION
    return worst


def _knowledge_write_risk(args: dict[str, Any]) -> str:
    """Risk for knowledge write/ingest based on operation + path."""
    op = str((args or {}).get("operation") or "").strip().lower()
    path = str((args or {}).get("path") or "").replace("\\", "/").strip().lstrip("/")
    if op in ("append", "patch", "set_frontmatter", "update_tags"):
        return RISK_CONFIRM
    if op == "create":
        first = path.split("/", 1)[0].lower() if path else ""
        if "inbox" in first:
            return RISK_SESSION
        return RISK_CONFIRM
    return RISK_SESSION


def _knowledge_tool_risk(args: dict[str, Any] | None) -> str:
    """Risk for unified ``knowledge`` tool — branch on ``action``."""
    action = str((args or {}).get("action") or "").strip().lower()
    if action in ("list", "ls", "browse", "search", "read", "graph", "status", ""):
        return RISK_AUTO
    if action == "ingest":
        return RISK_SESSION
    if action == "write":
        return _knowledge_write_risk(args or {})
    return RISK_AUTO


def tool_risk_level(tool_name: str, args: dict[str, Any] | None = None) -> str:
    """Return the risk level for a tool: auto | session | confirm."""
    name = canonical_tool_name(str(tool_name or "").strip())
    name = str(name or "").strip().lower()
    if name == "process":
        action = str((args or {}).get("action") or "start").strip().lower()
        if action != "start":
            return RISK_AUTO  # log/wait/kill on existing sessions — not dangerous
    if name == "worker":
        return _worker_risk_level(args or {})
    if name == "knowledge":
        return _knowledge_tool_risk(args)
    if name == "knowledge_write":
        return _knowledge_write_risk(args or {})
    if name == "knowledge_ingest":
        return RISK_SESSION

    level = TOOL_RISK_LEVELS.get(name, RISK_AUTO)

    # Bridge execution_security.approval onto shell tools so we
    # do not invent a second UI gate. Middleware still owns prompts.
    if name in ("terminal", "process", "process_start", "bash") and level != RISK_AUTO:
        try:
            from evoflow.execution_security.approval import AskForApproval
            from evoflow.execution_security.config import (
                get_execution_security_config,
                is_execution_security_active,
                resolved_ask,
            )

            cfg = get_execution_security_config()
            if is_execution_security_active(cfg):
                ask = resolved_ask(cfg)
                if ask is AskForApproval.NEVER:
                    return RISK_AUTO
                if ask is AskForApproval.UNTRUSTED:
                    return RISK_CONFIRM
        except Exception:
            pass

    return level


def command_security_decision(
    tool_name: str,
    args: dict[str, Any] | None = None,
) -> str | None:
    """Check command against security center allow/prompt prefix lists.

    Returns:
        'allow'  — command matches an allow prefix, skip approval
        'prompt' — command matches a prompt prefix, force approval
        None     — no match, fall through to normal risk assessment
    """
    name = str(tool_name or "").strip().lower()
    if name not in ("terminal", "process", "process_start", "bash"):
        return None
    if name == "process":
        action = str((args or {}).get("action") or "start").strip().lower()
        if action != "start":
            return None
    command = str((args or {}).get("command") or "").strip()
    if not command:
        return None
    try:
        from evoflow.persistence.security_settings_repositories import get_security_settings

        settings = get_security_settings()
        cmd_sec = settings.get("sandbox", {}).get("command_security", {})
        cmd_lower = command.lower()
        # Check prompt prefixes first (higher priority — safety first)
        for prefix in cmd_sec.get("prompt_prefixes", []):
            p = str(prefix).strip().lower()
            if p and (cmd_lower == p or cmd_lower.startswith(p + " ")):
                return "prompt"
        # Check allow prefixes
        for prefix in cmd_sec.get("allow_prefixes", []):
            p = str(prefix).strip().lower()
            if p and (cmd_lower == p or cmd_lower.startswith(p + " ")):
                if command_allow_prefix_bypass_ok(command):
                    return "allow"
    except Exception:
        pass
    return None


def tool_requires_approval(tool_name: str, args: dict[str, Any] | None = None) -> bool:
    """True when the tool's risk level is session or confirm (i.e. not auto).

    Security center command policy can override:
    - 'allow'  → skip approval (return False)
    - 'prompt' → force approval (return True)
    """
    decision = command_security_decision(tool_name, args)
    if decision == "allow":
        return False
    if decision == "prompt":
        return True
    return tool_risk_level(tool_name, args) != RISK_AUTO


def should_persist_tool_name_grant(tool_name: str, args: dict[str, Any] | None = None) -> bool:
    """True when approving should grant the *entire tool name* for the session.

    Disabled for normal prompt-mode approve: a single approve must not blanket-auto
    all future calls of that tool (e.g. every write in the session). Session-wide
    auto-run belongs in explicit session/grant_all policy, not one click on one row.
    """
    return False


def normalize_path_for_approval(path: str, *, workspace_root: str | None = None) -> str:
    """Canonical path for grant matching (strip virtual ``workspace/`` segments)."""
    raw = str(path or "").strip()
    if not raw:
        return ""
    norm = raw.replace("\\", "/")
    lower = norm.lower()
    for marker, head in (
        ("/workspace/outputs/", "outputs"),
        ("/outputs/", "outputs"),
        ("/uploads/", "uploads"),
        ("/workspace/", ""),
    ):
        idx = lower.rfind(marker)
        if idx >= 0:
            rel = norm[idx + len(marker) :].lstrip("/")
            if head:
                return f"{head}/{rel}" if rel else head
            return rel
    root_s = str(workspace_root or "").strip()
    if root_s and (os.path.isabs(raw) or (len(norm) >= 2 and norm[1] == ":")):
        try:
            root = Path(os.path.expanduser(os.path.expandvars(root_s))).resolve()
            target = flatten_bound_workspace_absolute(Path(os.path.expanduser(os.path.expandvars(raw))).resolve(), root)
            rel = target.relative_to(root)
            return rel.as_posix()
        except (OSError, ValueError):
            pass
    rel = strip_bound_workspace_prefix(norm.lstrip("/"))
    if os.path.isabs(raw) or (len(norm) >= 2 and norm[1] == ":"):
        return os.path.normcase(os.path.normpath(raw))
    return rel.replace("\\", "/")


def normalize_args_for_approval(
    tool_name: str,
    args: dict[str, Any],
    *,
    workspace_root: str | None = None,
) -> dict[str, Any]:
    out = dict(args or {})
    name = canonical_tool_name(str(tool_name or "").strip().lower())
    if name in _PATH_ARG_TOOLS:
        for key in ("path", "file_path", "target_file"):
            if isinstance(out.get(key), str):
                out[key] = normalize_path_for_approval(out[key], workspace_root=workspace_root)
    if name in ("terminal", "process", "process_start") and isinstance(out.get("command"), str):
        out["command"] = str(out["command"]).strip()
    if name == "process":
        out["action"] = str(out.get("action") or "start").strip().lower()
    return out


def canonical_args_for_approval(
    tool_name: str,
    args: dict[str, Any],
    *,
    workspace_root: str | None = None,
) -> dict[str, Any]:
    """Identity fields only — ignore ``reason`` etc. so approve/check signatures stay stable."""
    raw = dict(args or {})
    name = canonical_tool_name(str(tool_name or "").strip().lower())
    if name == "delete":
        p = raw.get("path") or raw.get("file_path") or raw.get("target_file") or ""
        return {"path": normalize_path_for_approval(str(p), workspace_root=workspace_root)}
    if name in ("read", "write", "replace"):
        p = raw.get("path") or raw.get("file_path") or raw.get("target_file") or ""
        return {"path": normalize_path_for_approval(str(p), workspace_root=workspace_root)}
    if name in ("terminal", "process", "process_start"):
        if name == "process" and str(raw.get("action") or "start").strip().lower() != "start":
            return {"action": str(raw.get("action") or "").strip().lower()}
        return {"command": str(raw.get("command") or "").strip()}
    if name == "worker":
        tasks = raw.get("tasks")
        if isinstance(tasks, list):
            actions = sorted(set(
                str(t.get("action") or "").strip().lower()
                for t in tasks if isinstance(t, dict)
            ))
            return {"actions": actions}
        return {"actions": []}
    return normalize_args_for_approval(tool_name, args, workspace_root=workspace_root)


def approval_signature(
    tool_name: str,
    args: dict[str, Any],
    *,
    workspace_root: str | None = None,
) -> str:
    norm_args = canonical_args_for_approval(tool_name, args, workspace_root=workspace_root)
    payload = json.dumps(
        {"name": str(tool_name or "").lower(), "args": norm_args},
        sort_keys=True,
        ensure_ascii=False,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]


def summarize_tool_for_approval(tool_name: str, args: dict[str, Any]) -> str:
    name = str(tool_name or "").strip()
    if name in ("terminal", "process", "process_start"):
        if name == "process" and str((args or {}).get("action") or "start").strip().lower() != "start":
            act = str((args or {}).get("action") or "").strip().lower()
            sid = str((args or {}).get("session_id") or "").strip()
            return f"{act} {sid}".strip() or act
        cmd = str((args or {}).get("command") or "").strip()
        return cmd[:500] if cmd else "(无命令)"
    if name in ("delete", "read") or canonical_tool_name(name.lower()) in ("delete", "read"):
        raw = str((args or {}).get("path") or (args or {}).get("file_path") or "").strip()
        return normalize_path_for_approval(raw) if raw else "(无路径)"
    if name in ("write", "replace", "str_replace", "write_to_file", "replace_in_file", "write_file"):
        raw = str((args or {}).get("path") or (args or {}).get("file_path") or (args or {}).get("target_file") or "").strip()
        return normalize_path_for_approval(raw) if raw else "(无路径)"
    if name in ("knowledge_write", "knowledge_ingest") or (
        canonical_tool_name(name.lower()) == "knowledge"
        and str((args or {}).get("action") or "").strip().lower() in ("write", "ingest")
    ):
        a = args or {}
        vault_id = str(a.get("vault_id") or a.get("vaultId") or "").strip()
        vault_name = vault_id or "?"
        try:
            from evoflow.knowledge.vault import store as vault_store

            cfg = vault_store.get_vault_config(vault_id) if vault_id else None
            if cfg is not None:
                vault_name = str(getattr(cfg, "name", None) or vault_id)
        except Exception:
            pass
        path = str(a.get("path") or "").strip()
        action = str(a.get("action") or "").strip().lower()
        op = str(
            a.get("operation")
            or ("ingest" if name == "knowledge_ingest" or action == "ingest" else "")
        ).strip()
        risk_key = {
            "create": "knowledge_write:create_in_inbox" if "inbox" in path.replace("\\", "/").split("/")[0].lower() else "knowledge_write:create",
            "append": "knowledge_write:append",
            "patch": "knowledge_write:patch_existing",
            "set_frontmatter": "knowledge_write:set_frontmatter",
            "update_tags": "knowledge_write:update_tags",
            "ingest": "knowledge_ingest",
        }.get(op, "knowledge_ingest" if action == "ingest" else name)
        bits = [
            f"Vault={vault_name}",
            f"路径={path or '?'}",
            f"操作={risk_key}",
        ]
        for key, label in (("target", "章节/字段"), ("section", "章节"), ("key", "字段")):
            val = a.get(key)
            if val:
                bits.append(f"{label}={val}")
        content = str(a.get("content") or a.get("title") or "")
        if content:
            preview = content.replace("\n", " ")[:120]
            bits.append(f"摘要={preview}")
        return "; ".join(bits)[:500]
    if name == "worker":
        tasks = (args or {}).get("tasks")
        if isinstance(tasks, list):
            parts = []
            for t in tasks:
                if not isinstance(t, dict):
                    continue
                act = str(t.get("action") or "").strip().lower()
                if act in ("write", "replace", "edit"):
                    parts.append(f"{act}: {t.get('path', '?')}")
                elif act in ("search", "locate"):
                    parts.append(f"{act}: {t.get('query', '?')}")
                elif act == "delete":
                    parts.append(f"delete: {t.get('path', '?')}")
                else:
                    parts.append(act or "?")
            return "; ".join(parts)[:400] if parts else "(空任务)"
        return "(无任务)"
    return json.dumps(args or {}, ensure_ascii=False, default=str)[:400]


def parse_user_approval_message(text: str) -> dict[str, Any] | None:
    """Parse structured prefix or slash commands from user input."""
    raw = str(text or "").strip()
    if not raw:
        return None
    low = raw.lower()
    if low.startswith(_PREFIX.lower()):
        body = raw[len(_PREFIX) :].strip()
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            return None
        return data if isinstance(data, dict) else None
    for pat in _APPROVE_ALL_PATTERNS:
        if pat.match(raw):
            return {"action": "grant_all"}
    m = _APPROVE_ONE.match(raw) or _APPROVE_ZH.match(raw)
    if m and m.group(1):
        return {"action": "approve", "tool_call_id": m.group(1).strip()}
    m = _DENY_ONE.match(raw) or _DENY_ZH.match(raw)
    if m and m.group(1):
        return {"action": "deny", "tool_call_id": m.group(1).strip()}
    if raw in ("/approve", "批准"):
        return {"action": "approve_latest"}
    return None


def format_approval_payload_text(
    *,
    tool_name: str,
    tool_call_id: str,
    summary: str,
    risk: str = "side_effect",
) -> str:
    return json.dumps(
        {
            "title": "需要您的授权",
            "tool_name": tool_name,
            "tool_call_id": tool_call_id,
            "summary": summary,
            "risk": risk,
            "hints": [
                "请在对话中点击该工具卡片，在弹窗中确认授权",
                "批准后系统将自动执行，无需模型再次调用",
            ],
        },
        ensure_ascii=False,
    )
