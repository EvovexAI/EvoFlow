"""Diagram node helpers for session mind map (Mermaid source in node body)."""

from __future__ import annotations

import re
from typing import Any

DIAGRAM_LANG_DEFAULT = "mermaid"

# diagram_type → user-facing label (zh) / mermaid keyword hint
DIAGRAM_TYPE_SPECS: dict[str, dict[str, str]] = {
    "flowchart": {"label_zh": "流程图", "keyword": "flowchart"},
    "sequence": {"label_zh": "时序图", "keyword": "sequenceDiagram"},
    "state": {"label_zh": "状态图", "keyword": "stateDiagram-v2"},
    "class": {"label_zh": "类图", "keyword": "classDiagram"},
    "er": {"label_zh": "ER 图", "keyword": "erDiagram"},
    "architecture": {"label_zh": "架构图", "keyword": "architecture-beta"},
    "mindmap": {"label_zh": "思维导图", "keyword": "mindmap"},
    "gantt": {"label_zh": "甘特图", "keyword": "gantt"},
    "journey": {"label_zh": "用户旅程", "keyword": "journey"},
    "git": {"label_zh": "Git 图", "keyword": "gitGraph"},
    "block": {"label_zh": "块图", "keyword": "block-beta"},
    "c4": {"label_zh": "C4 图", "keyword": "C4Context"},
    "quadrant": {"label_zh": "象限图", "keyword": "quadrantChart"},
    "timeline": {"label_zh": "时间线", "keyword": "timeline"},
    "ishikawa": {"label_zh": "鱼骨图", "keyword": "ishikawa"},
}

_MERMAID_DETECT_RULES: list[tuple[str, re.Pattern[str]]] = [
    ("sequence", re.compile(r"^sequenceDiagram\b", re.I | re.M)),
    ("state", re.compile(r"^stateDiagram(?:-v2)?\b", re.I | re.M)),
    ("class", re.compile(r"^classDiagram\b", re.I | re.M)),
    ("er", re.compile(r"^erDiagram\b", re.I | re.M)),
    ("gantt", re.compile(r"^gantt\b", re.I | re.M)),
    ("journey", re.compile(r"^journey\b", re.I | re.M)),
    ("mindmap", re.compile(r"^mindmap\b", re.I | re.M)),
    ("git", re.compile(r"^gitGraph\b", re.I | re.M)),
    ("architecture", re.compile(r"^architecture(?:-beta)?\b", re.I | re.M)),
    ("block", re.compile(r"^block(?:-beta)?\b", re.I | re.M)),
    ("c4", re.compile(r"^C4(?:Context|Container|Component|Dynamic|Deployment)\b", re.I | re.M)),
    ("quadrant", re.compile(r"^quadrantChart\b", re.I | re.M)),
    ("timeline", re.compile(r"^timeline\b", re.I | re.M)),
    ("ishikawa", re.compile(r"^ishikawa\b", re.I | re.M)),
    ("flowchart", re.compile(r"^(?:flowchart|graph)\b", re.I | re.M)),
]


def normalize_diagram_type(raw: Any) -> str:
    key = str(raw or "").strip().lower()
    if not key:
        return ""
    aliases = {
        "flow": "flowchart",
        "seq": "sequence",
        "sequence_diagram": "sequence",
        "state_diagram": "state",
        "class_diagram": "class",
        "er_diagram": "er",
        "arch": "architecture",
    }
    return aliases.get(key, key)


def detect_diagram_type_from_source(source: str) -> str:
    text = _strip_mermaid_fence(source)
    for dtype, pattern in _MERMAID_DETECT_RULES:
        if pattern.search(text):
            return dtype
    return ""


def diagram_type_label(dtype: str, *, lang: str = "zh") -> str:
    key = normalize_diagram_type(dtype)
    spec = DIAGRAM_TYPE_SPECS.get(key)
    if not spec:
        return "图表" if lang == "zh" else "Diagram"
    return spec["label_zh"] if lang == "zh" else key


def _strip_mermaid_fence(text: str) -> str:
    raw = str(text or "").strip()
    m = re.match(r"^```(?:mermaid)?\s*\n?([\s\S]*?)```\s*$", raw, re.I)
    return str(m.group(1) if m else raw).strip()


def enrich_diagram_meta(
    *,
    meta: dict[str, Any] | None,
    kind: str = "",
    diagram_type: Any = None,
    body: str = "",
) -> dict[str, Any]:
    """Merge diagram_type into meta for diagram nodes or mermaid bodies."""
    out = dict(meta or {})
    kind_norm = str(kind or "").strip().lower()
    dtype = normalize_diagram_type(diagram_type or out.get("diagram_type"))
    if not dtype and (kind_norm == "diagram" or str(body or "").strip()):
        dtype = detect_diagram_type_from_source(body)
    if dtype:
        out["diagram_type"] = dtype
        out.setdefault("diagram_lang", DIAGRAM_LANG_DEFAULT)
    return out


def is_diagram_node(kind: str, external_id: str = "") -> bool:
    k = str(kind or "").strip().lower()
    if k == "diagram":
        return True
    return str(external_id or "").strip().lower().startswith("diagram:")
