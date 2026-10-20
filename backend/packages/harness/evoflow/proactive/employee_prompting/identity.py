"""Employee agent_code normalization and hired-role identity resolution."""

from __future__ import annotations

from typing import Any


def normalize_employee_agent_code(raw: str | None) -> str:
    """Strip ``proactive:`` / ``:task:`` / ``:duty:`` / ``:chat:`` session suffixes."""
    code = str(raw or "").strip()
    if not code:
        return ""
    if code.startswith("proactive:"):
        try:
            from evoflow.proactive.chat_session import proactive_agent_code_from_session_key

            parsed = proactive_agent_code_from_session_key(code)
            if parsed:
                return parsed
        except Exception:
            code = code[len("proactive:") :].strip()
    for kind in ("task", "duty", "chat"):
        marker = f":{kind}:"
        if marker in code:
            return code.split(marker, 1)[0].strip()
    return code


def resolve_employee_identity(agent_code: str | None) -> dict[str, Any] | None:
    """Resolve hired employee identity, or None if not an active/paused posting."""
    code = normalize_employee_agent_code(agent_code)
    if not code or code.lower() in {"main", "lead_agent", "auto"}:
        return None
    try:
        from evoflow.agents.xiaomi.identity import is_xiaomi_agent

        if is_xiaomi_agent(code):
            return None
    except Exception:
        if code.lower() in {"xiaomi", "小v", "小蜜", "xiaov"}:
            return None
    try:
        from evoflow.proactive.repositories import ProactiveRepository

        role = ProactiveRepository.get_role(code)
    except Exception:
        return None
    if role is None:
        return None
    status = str(getattr(role, "status", "") or "").strip().lower()
    if status == "draft":
        return None
    cfg = getattr(role, "config", None)
    resp_raw = list(getattr(cfg, "responsibilities", None) or []) if cfg is not None else []
    resp = [str(x).strip() for x in resp_raw if str(x).strip()]
    workspace = ""
    if cfg is not None:
        workspace = str(getattr(cfg, "workspace_path", "") or "").strip()
    return {
        "code": str(getattr(role, "agent_code", None) or code).strip() or code,
        "role_name": str(getattr(role, "role_name", None) or code).strip() or code,
        "department": str(getattr(role, "department", None) or getattr(cfg, "department", None) or "").strip(),
        "responsibilities": resp[:8],
        "workspace_path": workspace,
        "status": status,
    }


def identity_or_fallback(
    identity: dict[str, Any] | None = None,
    *,
    agent_code: str | None = None,
    role_name: str = "",
) -> dict[str, Any]:
    """Return resolved identity or a minimal fallback dict."""
    info = identity or resolve_employee_identity(agent_code)
    if info is not None:
        return info
    code = normalize_employee_agent_code(agent_code)
    name = str(role_name or "").strip() or code or "本岗同事"
    return {
        "code": code,
        "role_name": name,
        "department": "",
        "responsibilities": [],
        "workspace_path": "",
    }


def is_employee_chat_session(
    session_key: str | None,
    agent_name: str | None = None,
) -> tuple[bool, dict[str, Any] | None]:
    """True when this run should use the employee prompt skeleton (not duty, not main, not xiaomi)."""
    sk = str(session_key or "").strip()
    if not sk.startswith("proactive:"):
        return False, None
    code = normalize_employee_agent_code(sk) or normalize_employee_agent_code(agent_name)
    info = resolve_employee_identity(code)
    if info is None:
        return False, None
    return True, info


def load_role_for_code(agent_code: str | None):
    """Load ``ProactiveRole`` for org / duty sections, or None."""
    code = normalize_employee_agent_code(agent_code)
    if not code:
        return None
    try:
        from evoflow.proactive.repositories import ProactiveRepository

        return ProactiveRepository.get_role(code)
    except Exception:
        return None
