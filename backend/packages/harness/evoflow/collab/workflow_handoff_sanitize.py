"""Sanitize workflow step handoffs — paths/refs only, never megabyte payloads in prompts.

Workflow steps must not pass full file contents, JSON blobs with embedded images,
or base64 through ``input_bindings`` / upstream dependency context. Downstream
agents should ``read`` paths from the workspace.
"""

from __future__ import annotations

import json
import re
from typing import Any

_DATA_IMAGE_URI_RE = re.compile(
    r"data:image/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+",
    re.IGNORECASE,
)
_LONG_BASE64_RE = re.compile(r"base64,[A-Za-z0-9+/=\s]{500,}", re.IGNORECASE)
_FILE_EXT_RE = re.compile(r"\.(md|html?|pdf|json|ya?ml|tsx?|jsx?|py|css|txt|csv|mp4|mov|png|jpg|jpeg|webp)$", re.I)

_DEFAULT_MAX_STR = 2000
_DEFAULT_SUMMARY_MAX = 800
_DEFAULT_MAX_LIST = 32
_DEFAULT_MAX_DEPTH = 14

_OMITTED_BINARY = "[binary/image data omitted — use file path or URL from outputs]"
_TRUNCATED_SUFFIX = "…(truncated — read full content from output paths)"


def strip_binary_payloads_from_text(text: str) -> str:
    raw = str(text or "")
    if not raw:
        return raw
    out = _DATA_IMAGE_URI_RE.sub("[image base64 omitted]", raw)
    out = _LONG_BASE64_RE.sub("[base64 blob omitted]", out)
    return out


def is_path_or_url(value: str) -> bool:
    s = str(value or "").strip().replace("\\", "/")
    if not s or len(s) > 2048:
        return False
    low = s.lower()
    if low.startswith(("http://", "https://", "outputs/", "docs/", "evoflow/")):
        return True
    if "/" in s and _FILE_EXT_RE.search(s):
        return True
    if _FILE_EXT_RE.search(s) and " " not in s[:120]:
        return True
    return False


def sanitize_string_for_handoff(text: str, max_len: int = _DEFAULT_MAX_STR) -> str:
    s = strip_binary_payloads_from_text(str(text or "").strip())
    if not s:
        return ""
    if len(s) <= max_len:
        return s
    # Prefer path hints when truncating huge blobs (e.g. accidental JSON dumps).
    if is_path_or_url(s[:512]):
        return s[:max_len] + _TRUNCATED_SUFFIX
    return s[:max_len] + _TRUNCATED_SUFFIX


def sanitize_output_value_field(value: str) -> str:
    """Normalize a single deliverable ``value`` before persistence or handoff."""
    s = str(value or "").strip()
    if not s:
        return ""
    if s.lower().startswith("data:image") or "base64," in s.lower() and len(s) > 500:
        return _OMITTED_BINARY
    s = strip_binary_payloads_from_text(s)
    if len(s) > 4000 and not is_path_or_url(s):
        return sanitize_string_for_handoff(s, 400)
    return s[:4000]


def sanitize_value_for_handoff(
    value: Any,
    *,
    max_str_len: int = _DEFAULT_MAX_STR,
    max_list: int = _DEFAULT_MAX_LIST,
    depth: int = 0,
) -> Any:
    if depth > _DEFAULT_MAX_DEPTH:
        return "[nested depth limit]"
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        if value.strip().lower().startswith("data:image"):
            return _OMITTED_BINARY
        if "base64," in value.lower() and len(value) > 500:
            return _OMITTED_BINARY
        if len(value) > max_str_len and not is_path_or_url(value):
            return sanitize_string_for_handoff(value, max_str_len)
        return strip_binary_payloads_from_text(value)
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, item in value.items():
            k = str(key)
            if k.lower() in {"base64", "image_base64", "image_data", "bytes", "content_bytes"}:
                if isinstance(item, str) and len(item) > 200:
                    out[k] = _OMITTED_BINARY
                    continue
            out[key] = sanitize_value_for_handoff(
                item,
                max_str_len=max_str_len,
                max_list=max_list,
                depth=depth + 1,
            )
        return out
    if isinstance(value, list):
        return [
            sanitize_value_for_handoff(
                item,
                max_str_len=max_str_len,
                max_list=max_list,
                depth=depth + 1,
            )
            for item in value[:max_list]
        ]
    return value


def sanitize_output_item(item: dict[str, Any]) -> dict[str, str]:
    """Keep handoff-safe artifact fields (path/url refs, short labels)."""
    if not isinstance(item, dict):
        return {}
    out: dict[str, str] = {}
    for key in ("type", "key", "label"):
        val = str(item.get(key) or "").strip()
        if val:
            out[key] = val[:200]
    raw_val = str(item.get("value") or item.get("path") or item.get("url") or "").strip()
    out["value"] = sanitize_output_value_field(raw_val)
    return out


def sanitize_resolved_bindings(resolved: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(resolved, dict):
        return {}
    return {
        str(k): sanitize_value_for_handoff(v)
        for k, v in resolved.items()
    }


def sanitize_steps_output_entry(entry: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(entry, dict):
        return {}
    output = sanitize_value_for_handoff(entry.get("output") or {}, max_str_len=1500)
    summary = sanitize_string_for_handoff(str(entry.get("summary") or ""), _DEFAULT_SUMMARY_MAX)
    artifacts_raw = entry.get("artifacts") if isinstance(entry.get("artifacts"), list) else []
    artifacts = [sanitize_output_item(a) for a in artifacts_raw[:20] if isinstance(a, dict)]
    artifacts_keyed: dict[str, dict[str, str]] = {}
    for item in artifacts:
        item_key = str(item.get("key") or "").strip()
        if item_key:
            artifacts_keyed[item_key] = item
    return {
        "output": output if isinstance(output, dict) else {},
        "summary": summary,
        "artifacts": artifacts,
        "artifacts_keyed": artifacts_keyed,
    }


def format_upstream_subtask_handoff(
    dep: dict[str, Any],
    *,
    dep_name: str,
    dep_id: str,
) -> str:
    """Path-first upstream handoff block (no inline file/base64 payloads)."""
    from evoflow.collab.subtask_outcome import build_subtask_outcome_snapshot

    snap = build_subtask_outcome_snapshot(dep)
    lines = [f"- Upstream subtask `{dep_name}` (id={dep_id}) completed."]
    outputs = snap.get("outputs") if isinstance(snap.get("outputs"), list) else []
    paths: list[str] = []
    for item in outputs:
        if not isinstance(item, dict):
            continue
        val = sanitize_output_value_field(str(item.get("value") or ""))
        if val and val != _OMITTED_BINARY and is_path_or_url(val):
            paths.append(val)
    evidence = snap.get("evidence_paths") if isinstance(snap.get("evidence_paths"), list) else []
    for p in evidence:
        ps = str(p or "").strip()
        if ps and is_path_or_url(ps) and ps not in paths:
            paths.append(ps)
    if paths:
        lines.append("  - 产出路径（请 read/terminal 读取，勿假定内容已在上下文中）：")
        for p in paths[:20]:
            lines.append(f"    - `{p}`")
    summary = sanitize_string_for_handoff(str(snap.get("task_report") or ""), _DEFAULT_SUMMARY_MAX)
    if summary:
        lines.append(f"  - 摘要: {summary}")
    return "\n".join(lines)


def json_for_handoff_prompt(value: Any, max_chars: int = 4000) -> str:
    """Serialize binding values for prompt injection with size cap."""
    sanitized = sanitize_value_for_handoff(value)
    try:
        text = json.dumps(sanitized, ensure_ascii=False, indent=2)
    except (TypeError, ValueError):
        text = str(sanitized)
    text = strip_binary_payloads_from_text(text)
    if len(text) > max_chars:
        return text[:max_chars] + _TRUNCATED_SUFFIX
    return text


__all__ = [
    "format_upstream_subtask_handoff",
    "is_path_or_url",
    "json_for_handoff_prompt",
    "sanitize_output_item",
    "sanitize_output_value_field",
    "sanitize_resolved_bindings",
    "sanitize_steps_output_entry",
    "sanitize_string_for_handoff",
    "sanitize_value_for_handoff",
    "strip_binary_payloads_from_text",
]
