"""Per-person downstream handlers on a Task (交工时指定谁处理、做什么、读哪些产物).

Each entry is independent::

    {
      "agent_code": "frontend-dev",
      "content": "修复登录页闪烁…",
      "read_outputs": [{"type":"file","key":"report","value":"docs/…/analysis.md"}],
      "role": "前端工程师"   # optional display
    }

``read_outputs`` = references the assignee should **read** (usually a subset of the
parent task's ``outputs``). Legacy key ``outputs`` / ``artifacts`` is accepted on
read and normalized to ``read_outputs``.

Child tasks created on confirm store those refs in ``input_refs``, never in the
child's own ``outputs`` (which are the child's deliverables).
"""

from __future__ import annotations

import json
import re
from typing import Any

from evoflow.collab.task_outputs import normalize_task_outputs

_HANDLER_MAX_ITEMS = 20
_AGENT_MAX = 64
_ROLE_MAX = 64
_CONTENT_MAX = 4000

_KEY_QUOTE_RE = re.compile(r"([{,\[]\s*)([A-Za-z_][\w]*)\s*:")
_BARE_VALUE_RE = re.compile(r":\s*([A-Za-z_][\w./-]*)(?=\s*[,}\]])")
_FREE_TEXT_RE = re.compile(
    r'("(?:content|label|value|description|work|task|path|url|title)"\s*:\s*)(?!")'
    r'(.*?)(?=\s*,\s*"[A-Za-z_][\w]*"\s*:|\s*[,}\]])',
    re.DOTALL,
)


def _looks_like_handler_object_blob(text: str) -> bool:
    s = text or ""
    return bool(
        re.search(r"[{}\[\]]", s)
        or re.search(r"agent_code\s*:", s, re.I)
        or '"agent_code"' in s
        or re.search(r"(?:read_)?outputs\s*:", s, re.I)
    )


def try_parse_handlers_json(text: str) -> Any | None:
    """Parse handlers JSON; repair common unquoted-key LLM payloads."""
    raw = (text or "").strip()
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        pass

    s = _KEY_QUOTE_RE.sub(r'\1"\2":', raw)
    s = _BARE_VALUE_RE.sub(r':"\1"', s)
    try:
        return json.loads(s)
    except Exception:
        pass

    def _quote_free(m: re.Match[str]) -> str:
        val = m.group(2).strip().replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")
        return f'{m.group(1)}"{val}"'

    s = _FREE_TEXT_RE.sub(_quote_free, s)
    try:
        return json.loads(s)
    except Exception:
        return None


def _try_reassemble_handler_fragments(parts: list[Any]) -> Any | None:
    if len(parts) < 2 or not all(isinstance(p, str) for p in parts):
        return None
    joined = ",".join(parts)
    if not _looks_like_handler_object_blob(joined):
        return None
    body = joined.strip()
    if not body.startswith("["):
        body = f"[{body}"
    if not body.endswith("]"):
        body = f"{body}]"
    return try_parse_handlers_json(body)


def normalize_handler_entry(item: Any, *, index: int = 0) -> dict[str, Any] | None:
    """Normalize one handler row to ``{agent_code, content, read_outputs, role?}``."""
    del index
    if item is None:
        return None
    if isinstance(item, str):
        code = item.strip()
        if not code:
            return None
        if re.match(r"^(content|read_outputs|outputs|type|key|value|label)\s*:", code, re.I):
            return None
        if code[:1] in "{[]}" or "{" in code or "[" in code:
            return None
        return {"agent_code": code[:_AGENT_MAX], "content": "", "read_outputs": []}
    if not isinstance(item, dict):
        return None

    code = str(
        item.get("agent_code")
        or item.get("assignee")
        or item.get("handler")
        or item.get("code")
        or ""
    ).strip()
    if not code:
        return None

    content = str(
        item.get("content")
        or item.get("description")
        or item.get("work")
        or item.get("task")
        or ""
    ).strip()[:_CONTENT_MAX]

    role = str(
        item.get("role") or item.get("assigned_role") or item.get("role_name") or ""
    ).strip()[:_ROLE_MAX]

    # agent_code is the routing key; role_name is display. Fill from roster when omitted.
    if not role:
        try:
            from evoflow.proactive.repositories import ProactiveRepository

            emp = ProactiveRepository.get_role(code[:_AGENT_MAX])
            if emp and str(emp.role_name or "").strip():
                role = str(emp.role_name).strip()[:_ROLE_MAX]
        except Exception:
            pass

    read_raw = item.get("read_outputs")
    if read_raw is None:
        read_raw = item.get("outputs") if item.get("outputs") is not None else item.get("artifacts")
    read_outputs = normalize_task_outputs(read_raw)

    out: dict[str, Any] = {
        "agent_code": code[:_AGENT_MAX],
        "content": content,
        "read_outputs": read_outputs,
    }
    if role:
        out["role"] = role
    return out


def normalize_task_handlers(raw: Any) -> list[dict[str, Any]]:
    """Normalize handlers list / JSON string; drops invalids; caps length."""
    if raw is None:
        return []
    items: Any = raw
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            return []
        parsed = try_parse_handlers_json(text)
        if parsed is not None:
            items = parsed
        elif _looks_like_handler_object_blob(text):
            return []
        else:
            parts = [p.strip() for p in text.replace(";", ",").split(",") if p.strip()]
            items = parts
    if isinstance(items, dict):
        items = [items]
    if not isinstance(items, list):
        return []

    reassembled = _try_reassemble_handler_fragments(items)
    if reassembled is not None:
        items = reassembled if isinstance(reassembled, list) else [reassembled]

    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for i, item in enumerate(items):
        if len(out) >= _HANDLER_MAX_ITEMS:
            break
        normalized = normalize_handler_entry(item, index=i)
        if not normalized:
            continue
        code = normalized["agent_code"].lower()
        sig = f"{code}|{normalized.get('content') or ''}"
        if sig in seen:
            continue
        seen.add(sig)
        out.append(normalized)
    return out


def task_handlers_of(row: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Read handlers from a task row (``handlers`` preferred; ``suggested_handlers`` alias).

    ``read_outputs`` file paths are absolutized against the role workspace when possible.
    """
    if not isinstance(row, dict):
        return []
    direct = normalize_task_handlers(row.get("handlers"))
    if not direct:
        direct = normalize_task_handlers(row.get("suggested_handlers"))
    if not direct:
        return []
    from evoflow.collab.task_outputs import (
        agent_code_for_task_row,
        absolutize_handlers_paths,
        workspace_root_for_task_row,
    )

    return absolutize_handlers_paths(
        direct,
        workspace_root_for_task_row(row),
        agent_code=agent_code_for_task_row(row),
    )


__all__ = [
    "normalize_handler_entry",
    "normalize_task_handlers",
    "task_handlers_of",
    "try_parse_handlers_json",
]
