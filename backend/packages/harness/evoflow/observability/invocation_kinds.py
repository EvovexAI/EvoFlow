"""Canonical labels for model ``invocation_kind`` (observability / agent-trace)."""

from __future__ import annotations

from typing import Any

# Stable keys stored in SQLite / JSONL / agent-trace export.
KNOWN_INVOCATION_KINDS: frozenset[str] = frozenset(
    {
        "main",
        "title",
        "mission_state",
        "memory",
        "compress",
        "tool_summary",
        "subagent",
        "hosted",
        "hosted_panel",
        "hosted_closure",
        "auxiliary",  # legacy / unknown auxiliary bucket
    }
)

_LABELS_ZH: dict[str, str] = {
    "main": "主对话",
    "title": "会话标题",
    "mission_state": "意图 / 任务态分析",
    "memory": "长期记忆",
    "compress": "上下文压缩 / 摘要",
    "tool_summary": "工具结果摘要",
    "subagent": "子代理",
    "hosted": "目标（服务端自动跟进）",
    "hosted_panel": "目标（面板调度）",
    "hosted_closure": "目标（飞书小结）",
    "auxiliary": "辅助（未细分）",
    "unknown": "未知",
}

_HINTS_ZH: dict[str, str] = {
    "main": "主 Agent 流式回复（面板可见）",
    "title": "TitleMiddleware：首轮后生成会话标题，通常不推流",
    "mission_state": "异步 MissionState 分析器：意图、目标与子问题（非主对话）",
    "memory": "MemoryUpdater / 记忆插件：对话摘要写入长期记忆",
    "compress": "上下文压缩 / 结构化摘要（ContextCompaction）",
    "tool_summary": "工具返回分级摘要与历史老化（ToolResultShaper / ToolHistoryAger）",
    "subagent": "子任务 Subagent 执行器",
    "hosted": "目标通道自动跟进",
    "hosted_panel": "飞书等目标面板调度模型",
    "hosted_closure": "目标会话收尾小结",
    "auxiliary": "旧版辅助标签；新日志应使用 title / mission_state 等细分 kind",
    "unknown": "无法从 invocation_kind 或请求体推断",
}


def normalize_invocation_kind(value: Any) -> str | None:
    k = str(value or "").strip().lower()
    if not k:
        return None
    if k in KNOWN_INVOCATION_KINDS:
        return k
    return k


def label_zh(kind: str | None) -> str:
    k = normalize_invocation_kind(kind) or "unknown"
    return _LABELS_ZH.get(k, k)


def hint_zh(kind: str | None) -> str:
    k = normalize_invocation_kind(kind) or "unknown"
    return _HINTS_ZH.get(k, _HINTS_ZH["unknown"])


def _prompt_text_from_payload(payload: dict[str, Any] | None) -> str:
    if not isinstance(payload, dict):
        return ""
    parts: list[str] = []
    msgs = payload.get("messages")
    if isinstance(msgs, list):
        for m in msgs:
            if not isinstance(m, dict):
                continue
            c = m.get("content")
            if isinstance(c, str):
                parts.append(c)
            elif isinstance(c, list):
                for block in c:
                    if isinstance(block, dict) and block.get("type") == "text":
                        t = block.get("text")
                        if isinstance(t, str):
                            parts.append(t)
    for key in ("input", "prompt", "text"):
        v = payload.get(key)
        if isinstance(v, str) and v.strip():
            parts.append(v.strip())
    return "\n".join(parts)


def _prompt_text_from_row(payload_row: dict[str, Any] | None, vendor_row: dict[str, Any] | None) -> str:
    chunks: list[str] = []
    if isinstance(payload_row, dict):
        pl = payload_row.get("payload")
        if isinstance(pl, dict):
            chunks.append(_prompt_text_from_payload(pl))
        for key in ("system_prompt_preview", "system_prompt_full"):
            v = payload_row.get(key)
            if isinstance(v, str) and v.strip():
                chunks.append(v.strip())
    if isinstance(vendor_row, dict):
        vr = vendor_row.get("vendor_request")
        if isinstance(vr, dict):
            chunks.append(_prompt_text_from_payload(vr))
    return "\n".join(chunks)


def infer_invocation_kind_from_prompt(text: str) -> str | None:
    t = (text or "").strip().lower()
    if not t:
        return None
    if "generate a concise title" in t or ("user_msg" in t and "assistant_msg" in t and "max " in t and "words" in t):
        return "title"
    if "primary_objective" in t and ("intent_hint" in t or "active_subproblems" in t or "user-intent" in t):
        return "mission_state"
    if "mission state" in t or "mission_state" in t:
        return "mission_state"
    return None


def resolve_invocation_kind(
    *,
    vendor_row: dict[str, Any] | None = None,
    payload_row: dict[str, Any] | None = None,
) -> str:
    """Resolve the best-effort invocation kind for a vendor roundtrip + payload pair."""
    for src in (vendor_row, payload_row):
        if isinstance(src, dict):
            ik = normalize_invocation_kind(src.get("invocation_kind"))
            if ik and ik != "auxiliary":
                return ik
    text = _prompt_text_from_row(payload_row, vendor_row)
    inferred = infer_invocation_kind_from_prompt(text)
    if inferred:
        return inferred
    for src in (vendor_row, payload_row):
        if isinstance(src, dict):
            ik = normalize_invocation_kind(src.get("invocation_kind"))
            if ik:
                return ik
    if isinstance(payload_row, dict):
        pl = payload_row.get("payload")
        if isinstance(pl, dict):
            msgs = pl.get("messages")
            if isinstance(msgs, list) and len(msgs) > 0:
                return "main"
            if isinstance(msgs, list) and len(msgs) == 0:
                return "auxiliary"
    return "unknown"


def aggregate_vendor_latency_by_kind(vendor_calls: list[dict[str, Any]]) -> dict[str, float]:
    """Sum ``latency_ms`` per resolved ``invocation_kind``."""
    out: dict[str, float] = {}
    for row in vendor_calls:
        if not isinstance(row, dict):
            continue
        kind = str(row.get("invocation_kind") or row.get("role") or "unknown")
        lat = row.get("latency_ms")
        if lat is None:
            continue
        try:
            out[kind] = out.get(kind, 0.0) + float(lat)
        except (TypeError, ValueError):
            continue
    return {k: round(v, 1) for k, v in sorted(out.items())}


def invocation_kind_catalog() -> list[dict[str, str]]:
    """Export catalog for API / UI (zh label + hint)."""
    items: list[dict[str, str]] = []
    for k in sorted(KNOWN_INVOCATION_KINDS):
        items.append({"kind": k, "label_zh": label_zh(k), "hint_zh": hint_zh(k)})
    return items
