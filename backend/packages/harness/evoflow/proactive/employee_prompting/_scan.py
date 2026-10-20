"""Shared prompt-piece sanitization for employee blocks."""

from __future__ import annotations


def scan_prompt_piece(text: str, *, source: str) -> str:
    body = str(text or "").strip()
    if not body:
        return ""
    try:
        from evoflow.security.prompt_injection_scanner import scan_content

        return scan_content(body, source=source).strip()
    except Exception:
        return body


def strip_soul_wrapper(text: str) -> str:
    raw = str(text or "").strip()
    if raw.startswith("<soul>") and raw.endswith("</soul>"):
        return raw[len("<soul>") : -len("</soul>")].strip()
    return raw
