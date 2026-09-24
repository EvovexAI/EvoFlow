#!/usr/bin/env python
"""prompt-audit · 通用 Agent 提示词栈审计器 (stdlib-only)。

参考 .codebasewiki/meta/agent-prompt-architecture.md 的反模式库，对任意
L1/L2/L3 文本做结构化扫描，输出 Markdown 报告与 JSON 结果。

用法：
    # 审计单文件（自动判层）
    python prompt_audit.py path/to/file.md

    # 审计多文件（按 --layer 显式指定 L1/L2/L3）
    python prompt_audit.py --layer L1 system_prompt.txt
    python prompt_audit.py --layer L2 AGENTS.md --layer L3 .cursor/rules/foo.mdc

    # 输出 JSON
    python prompt_audit.py AGENTS.md --json

退出码：HIGH 问题存在 → 1；否则 0。
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import sys
from dataclasses import dataclass, field, asdict
from typing import Iterable


# --- 反模式库（与 SKILL.md 第 4 节同步） -----------------------

PATTERNS = [
    # (id, name, layer, severity, regex_or_callable)
    ("P-001", "硬编码工作空间路径", "L1", "HIGH",
     re.compile(r"(C:\\\\Users\\\\|/Users/[a-z]+/|/home/[a-z]+/)", re.I)),
    ("P-002", "多重互不兼容的 identity", "L1", "HIGH", "_check_identity_conflict"),
    ("P-003", "虚构的 skill 工具调用语法", "L1", "HIGH",
     # NOTE: read("skill:...") 是 EvoFlow 真实 skill URI，不误报。
     # <skill:.../> 是未实现的标签语法，应命中。
     re.compile(r"<skill:[a-z_-]+/>", re.I)),
    ("P-004", "未声明的裁决链", "L1", "HIGH", "_check_decision_chain"),
    ("P-005", "引用未声明的 facts/lessons 段", "L1", "MEDIUM",
     re.compile(r"<(facts|lessons|memories|reflections|process)>", re.I)),
    ("P-011", "<soul> 块内残留 Identity 标题", "L1", "HIGH", "_check_soul_identity_leak"),
    ("P-006", "单文件超长", "L1L2L3", "MEDIUM", "_check_length"),
    ("P-007", "重复上层内容关键词", "L2L3", "MEDIUM", "_check_redundancy"),
    ("P-008", "缺 frontmatter", "L2L3", "LOW", "_check_frontmatter"),
    ("P-009", "缺 last_updated", "L2L3", "LOW", "_check_last_updated"),
    ("P-010", "路径斜杠风格混用", "L1L2L3", "LOW",
     re.compile(r"\\\\[^\\]*?[a-zA-Z]:\\\\|\\\\\\\\")),
]

# identity 关键词聚类（任一层包含 ≥2 个不同聚类 → 命中 P-002）。
# `IDENTITY_ANCHORS` 是显式身份锚点模板（如 ``{{agent_name}}``），它出现时
# 强制视为单一身份，即使伴随公司/产品名称也不报警——这是 P-002 的安全带。
# EvovexAI / EvoFlow助手 等只在没有 anchor 时才算冲突集群。
IDENTITY_ANCHORS = [
    r"\{\s*agent_name\s*\}",
    r"\{\s*role_name\s*\}",
    r"\{\s*display_name\s*\}",
    r"<agent[_-]?name\b",
]
IDENTITY_ANCHOR_RE = re.compile("|".join(IDENTITY_ANCHORS), re.IGNORECASE)
IDENTITY_CLUSTERS = {
    "EvovexAI": ["EvovexAI", "evovex"],
    "EvoFlow_Product": ["EvoFlow助手", "EvoFlow 产品", "EvoFlow 助手"],
    "Orchestrator": ["编排伙伴", "任务编排", "派岗"],
    "Generic_Assistant": ["超级助手", "通用助手", "编程助手"],
    "Cursor": ["Cursor", "Cursor IDE"],
}


@dataclass
class Issue:
    pid: str
    name: str
    layer: str
    severity: str
    file: str
    line: int
    msg: str
    snippet: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Report:
    target: str
    audited_at: str
    layers: dict[str, list[str]] = field(default_factory=dict)
    issues: list[Issue] = field(default_factory=list)

    @property
    def high_count(self) -> int:
        return sum(1 for i in self.issues if i.severity == "HIGH")

    @property
    def medium_count(self) -> int:
        return sum(1 for i in self.issues if i.severity == "MEDIUM")

    @property
    def low_count(self) -> int:
        return sum(1 for i in self.issues if i.severity == "LOW")

    def exit_code(self) -> int:
        return 1 if self.high_count > 0 else 0

    def to_markdown(self) -> str:
        lines = [
            "## Prompt Audit Report",
            "",
            f"**审计对象**：`{self.target}`  ",
            f"**审计日期**：{self.audited_at}  ",
            f"**审计依据**：`.codebasewiki/meta/agent-prompt-architecture.md`",
            "",
            "### 严重度汇总",
            f"- HIGH: {self.high_count}",
            f"- MEDIUM: {self.medium_count}",
            f"- LOW: {self.low_count}",
            "",
        ]
        for sev in ("HIGH", "MEDIUM", "LOW"):
            bucket = [i for i in self.issues if i.severity == sev]
            if not bucket:
                continue
            lines.append(f"### {sev} 级问题")
            for i, issue in enumerate(bucket, 1):
                lines.append(
                    f"{i}. **{issue.name}** (`{issue.pid}`)  \n"
                    f"   - 文件：`{issue.file}:{issue.line}`  \n"
                    f"   - 引用：`{issue.snippet[:120]}`  \n"
                    f"   - 修复：见 `agent-prompt-architecture.md` §2"
                )
            lines.append("")
        return "\n".join(lines)


# --- 检测器 ---------------------------------------------------

def _lineof(text: str, idx: int) -> int:
    return text.count("\n", 0, idx) + 1


def _snippet(text: str, idx: int, size: int = 80) -> str:
    start = max(0, idx - size // 2)
    end = min(len(text), idx + size // 2)
    return text[start:end].replace("\n", " ").strip()


_COMMENT_LINE_RE = re.compile(r"^\s*#[^\n]*$", re.MULTILINE)
_FENCED_CODE_RE = re.compile(r"```.*?```", re.DOTALL)
_INLINE_CODE_RE = re.compile(r"`[^`\n]+`")


def _scan_text(text: str) -> str:
    """Strip noise channels before keyword-based audits (P-002 / P-004 / P-005).

    Masked channels:
      - Python comments (``# ...``) — full-line only.
      - Triple-backtick fenced code blocks.
      - Single-backtick inline code spans (`` `...` ``).

    We replace masked content with whitespace of equal length so character offsets
    in the report still point at the original line/column.
    """
    def _blank(match: re.Match) -> str:
        return re.sub(r"[^\n]", " ", match.group(0))

    masked = _FENCED_CODE_RE.sub(_blank, text)
    masked = _COMMENT_LINE_RE.sub(_blank, masked)
    masked = _INLINE_CODE_RE.sub(_blank, masked)
    return masked


def _check_identity_conflict(text: str, file_path: str) -> Iterable[dict]:
    """同一层包含 ≥2 个不同 identity 聚类关键词 → 命中 P-002。

    Comments / inline code / fenced blocks are masked (see ``_scan_text``) so that
    self-referential guard rails like "anti-pattern: 同时声明「我是 EvovexAI」"
    do not trip the detector against themselves.

    Identity anchors (e.g. ``{agent_name}``) suppress the warning: the template
    declares the agent's actual identity at runtime via the anchor — surrounding
    brand / product / role names are user-facing aliases, not a competing identity.
    """
    scanned = _scan_text(text)
    if IDENTITY_ANCHOR_RE.search(scanned):
        return
    hits = {}
    for cluster, kws in IDENTITY_CLUSTERS.items():
        for kw in kws:
            idx = scanned.lower().find(kw.lower())
            if idx >= 0:
                hits[cluster] = (idx, kw)
                break
    if len(hits) >= 2:
        for cluster, (idx, kw) in hits.items():
            yield {
                "line": _lineof(text, idx),
                "snippet": _snippet(text, idx, 60),
                "extra": cluster,
            }


def _check_decision_chain(text: str, file_path: str) -> Iterable[dict]:
    """全文搜不到 裁决链 / priority / 优先级 关键词 → 命中 P-004。

    Comments / inline code / fenced blocks are masked so that docstring anti-pattern
    guards like "# reference: see <decision_chain>" don't satisfy the rule on their own.
    """
    scanned = _scan_text(text)
    if not re.search(r"(裁决链|priority|优先级)", scanned, re.I):
        yield {
            "line": 1,
            "snippet": text[:60],
            "extra": "no decision chain keyword found",
        }


# 在 <soul>...</soul> 段内禁用 Identity / 身份 标题，避免与 <role> 重复身份（P-002 子型）。
# 用非贪婪 + 兼容同一文件多个 soul 块；多行模式让 ^ 真正锚定行首。
_SOUL_BLOCK_RE = re.compile(r"<soul\b[^>]*>(.*?)</soul>", re.IGNORECASE | re.DOTALL)
_IDENTITY_HEADING_IN_SOUL_RE = re.compile(
    r"(?im)^\s*(?:\*\*(?:Identity|身份)\*\*|#{1,3}\s*(?:Identity|身份)|(?:Identity|身份))\s*$"
)


def _is_real_soul_block(start: int, text: str, body: str) -> bool:
    """Reject false matches where <soul> is the **reverse reference** inside other blocks.

    A real <soul> block is preceded by either a fresh line (own block) or whitespace.
    A false match (inside <decision_chain>, an example paragraph, etc.) typically
    sits inline like '…参考（`<soul>`）'. We check that the byte just before the
    match start is whitespace or beginning-of-text.
    """
    if start == 0:
        return True
    prev = text[start - 1]
    return prev in (" ", "\n", "\t", "\r")


def _check_soul_identity_leak(text: str, file_path: str) -> Iterable[dict]:
    """P-011: <soul> 块内残留 Identity/身份 标题 → 命中。"""
    for m in _SOUL_BLOCK_RE.finditer(text):
        if not _is_real_soul_block(m.start(), text, m.group(1)):
            continue
        if _IDENTITY_HEADING_IN_SOUL_RE.search(m.group(1)):
            yield {
                "line": _lineof(text, m.start()),
                "snippet": _snippet(text, m.start(), 60),
                "extra": "soul block must not contain an Identity heading; identity lives in <role>",
            }


def _check_length(text: str, file_path: str) -> Iterable[dict]:
    """P-006: 单文件超长。

    对 ``.py`` 模块聚合多个静态 prompt 块这类文件放宽到 800 行；
    纯 ``.txt`` / 用户贴出的 prompt 实例限制在 200 行内（更适合模型上下文）。
    """
    is_py = file_path.endswith(".py")
    cap = 800 if is_py else 200
    lines = text.count("\n") + 1
    if lines > cap:
        yield {
            "line": cap,
            "snippet": f"<{lines} lines, exceeds {cap}>",
            "extra": f"{lines} lines",
        }


def _check_redundancy(text: str, file_path: str) -> Iterable[dict]:
    """检测 '我是谁' 类身份描述出现在 L2/L3（关键词命中而非路径命中）。

    EvovexAI/EvoFlow 这种仓库名是合法 token，不该误报。
    """
    # 身份描述模式：我/你是 + 名词、隶属/属于 + 公司
    identity_pat = re.compile(
        r"(我[\u4e00-\u9fa5A-Za-z]*(?:是|属于|隶属)|隶属[\u4e00-\u9fa5A-Za-z]+|"
        r"我是\s+\S+|assistant by\s+\S+|powered by\s+\S+)",
        re.I,
    )
    for m in identity_pat.finditer(text):
        yield {
            "line": _lineof(text, m.start()),
            "snippet": _snippet(text, m.start(), 60),
            "extra": "identity phrasing in non-L1 layer",
        }


def _check_frontmatter(text: str, file_path: str) -> Iterable[dict]:
    """mdc/md 文件首部应含 YAML frontmatter。"""
    if not file_path.endswith((".md", ".mdc")):
        return
    if not text.lstrip().startswith("---"):
        yield {
            "line": 1,
            "snippet": text[:60].replace("\n", " "),
            "extra": "missing --- frontmatter",
        }


def _check_last_updated(text: str, file_path: str) -> Iterable[dict]:
    if not file_path.endswith((".md", ".mdc")):
        return
    if not re.search(r"last_updated\s*[:=]", text):
        yield {
            "line": 1,
            "snippet": text[:60].replace("\n", " "),
            "extra": "missing last_updated",
        }


# --- 主流程 ---------------------------------------------------

def _detect_layer(file_path: str, explicit: str | None) -> str:
    if explicit:
        return explicit
    name = os.path.basename(file_path).lower()
    if name == "agents.md":
        return "L2"
    if file_path.endswith(".mdc") or "/rules/" in file_path.replace("\\", "/"):
        return "L3"
    if "system_prompt" in name or "system-prompt" in name:
        return "L1"
    return "L1"


def audit_file(file_path: str, layer: str | None = None) -> Report:
    with open(file_path, "r", encoding="utf-8") as fh:
        text = fh.read()
    effective_layer = _detect_layer(file_path, layer)
    report = Report(
        target=file_path,
        audited_at=datetime.date.today().isoformat(),
        layers={effective_layer: [file_path]},
    )

    for pid, name, scope, severity, pattern in PATTERNS:
        if effective_layer not in scope and scope != effective_layer:
            # scope 形如 "L1" / "L2L3" / "L1L2L3"
            if effective_layer not in scope:
                continue
        try:
            if isinstance(pattern, str):
                # callable
                fn = globals()[pattern]
                for hit in fn(text, file_path):
                    report.issues.append(Issue(
                        pid=pid, name=name, layer=effective_layer,
                        severity=severity, file=file_path,
                        line=hit["line"], msg=hit.get("extra", ""),
                        snippet=hit.get("snippet", ""),
                    ))
            elif callable(pattern):
                for hit in pattern(text):
                    report.issues.append(Issue(
                        pid=pid, name=name, layer=effective_layer,
                        severity=severity, file=file_path,
                        line=hit["line"], msg=hit.get("extra", ""),
                        snippet=hit.get("snippet", ""),
                    ))
            else:
                for m in pattern.finditer(text):
                    report.issues.append(Issue(
                        pid=pid, name=name, layer=effective_layer,
                        severity=severity, file=file_path,
                        line=_lineof(text, m.start()),
                        msg=m.group(0)[:60],
                        snippet=_snippet(text, m.start()),
                    ))
        except Exception as exc:
            report.issues.append(Issue(
                pid=pid, name=f"{name} (检测异常)",
                layer=effective_layer, severity="LOW",
                file=file_path, line=0, msg=str(exc)[:60],
            ))

    return report


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description="prompt-audit · 通用 Agent 提示词栈审计")
    p.add_argument("files", nargs="+", help="要审计的文件路径")
    p.add_argument("--layer", action="append", choices=["L1", "L2", "L3"],
                   help="显式指定层；多次按顺序对应 files")
    p.add_argument("--json", action="store_true", help="输出 JSON 而非 Markdown")
    args = p.parse_args(argv)

    # Windows 下避免 GBK 默认编码导致中文乱码
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    layers = args.layer or []
    merged = Report(
        target=",".join(args.files),
        audited_at=datetime.date.today().isoformat(),
    )
    for idx, f in enumerate(args.files):
        layer = layers[idx] if idx < len(layers) else None
        sub = audit_file(f, layer)
        merged.issues.extend(sub.issues)
        for k, v in sub.layers.items():
            merged.layers.setdefault(k, []).extend(v)

    if args.json:
        print(json.dumps({
            "target": merged.target,
            "audited_at": merged.audited_at,
            "layers": merged.layers,
            "counts": {
                "HIGH": merged.high_count,
                "MEDIUM": merged.medium_count,
                "LOW": merged.low_count,
            },
            "issues": [i.to_dict() for i in merged.issues],
        }, ensure_ascii=False, indent=2))
    else:
        print(merged.to_markdown())

    return merged.exit_code()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
