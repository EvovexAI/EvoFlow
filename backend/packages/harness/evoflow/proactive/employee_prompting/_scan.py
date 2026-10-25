"""Shared prompt-piece sanitization for employee blocks."""

from __future__ import annotations


def scan_prompt_piece(text: str, *, source: str) -> str:
    body = str(text or "").strip()
    if not body:
        return ""
    try:
        # 真实扫描器在 evoflow.agents.content_scanner；历史上引用过不存在的
        # evoflow.security.*，导致员工侧扫描静默空转。
        from evoflow.agents.content_scanner import scan_content

        return scan_content(body, source=source).strip()
    except Exception:
        return body


def strip_soul_wrapper(text: str) -> str:
    raw = str(text or "").strip()
    if raw.startswith("<soul>") and raw.endswith("</soul>"):
        return raw[len("<soul>") : -len("</soul>")].strip()
    return raw
