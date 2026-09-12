"""Repair malformed ask_clarification ``questions`` payloads from LLM tool calls."""

from __future__ import annotations

import json
import re
from typing import Any

_PROMPT_DOUBLED_END_RE = re.compile(
    r'("(?:prompt|context|question)":\s*)""([^"]+?)"([^",}\]]+)"'
)
_PROMPT_DOUBLED_PAIR_RE = re.compile(
    r'("(?:prompt|context|question)":\s*)""([^"]+?)""'
)
_OPTIONS_RE = re.compile(r'"options"\s*:\s*(\[[^\]]*\])')
_PROMPT_RE = re.compile(r'"prompt"\s*:\s*"((?:[^"\\]|\\.)*)"')
_QUESTION_RE = re.compile(r'"question"\s*:\s*"((?:[^"\\]|\\.)*)"')
_CONTEXT_RE = re.compile(r'"context"\s*:\s*"((?:[^"\\]|\\.)*)"')
_ID_RE = re.compile(r'"id"\s*:\s*"([^"]*)"')
_LEADING_ID_RE = re.compile(r':\s*"([^"]*)"')


def _fix_prompt_doubled_quotes(chunk: str) -> str:
    s = _PROMPT_DOUBLED_PAIR_RE.sub(r'\1"\2"', chunk)
    return _PROMPT_DOUBLED_END_RE.sub(r'\1"\2\3"', s)


def _question_has_body(q: dict[str, Any]) -> bool:
    prompt = str(q.get("prompt") or q.get("question") or "").strip()
    opts = q.get("options")
    if isinstance(opts, list) and len(opts) >= 2:
        return bool(prompt)
    if isinstance(opts, str) and opts.strip():
        return bool(prompt)
    return False


def _regex_extract_question(chunk: str) -> dict[str, Any] | None:
    qid = _ID_RE.search(chunk)
    if not qid:
        lead = _LEADING_ID_RE.search(chunk)
        qid_val = lead.group(1).strip() if lead else ""
    else:
        qid_val = qid.group(1).strip()

    prompt_m = _PROMPT_RE.search(chunk) or _QUESTION_RE.search(chunk)
    prompt = prompt_m.group(1).strip() if prompt_m else ""
    if not prompt:
        loose = _PROMPT_DOUBLED_END_RE.search(chunk)
        if loose:
            prompt = f"{loose.group(2)}{loose.group(3)}".strip()

    ctx_m = _CONTEXT_RE.search(chunk)
    context = ctx_m.group(1).strip() if ctx_m else ""

    options: list[Any] = []
    opt_m = _OPTIONS_RE.search(chunk)
    if opt_m:
        try:
            parsed = json.loads(_fix_prompt_doubled_quotes(opt_m.group(1)))
            if isinstance(parsed, list):
                options = parsed
        except Exception:
            pass

    if not prompt or len(options) < 2:
        return None

    out: dict[str, Any] = {"prompt": prompt, "options": options}
    if qid_val:
        out["id"] = qid_val
    if context:
        out["context"] = context
    return out


def _wrap_blob_object(chunk: str) -> str:
    p = chunk.strip().strip("[]").strip()
    if p.startswith(":"):
        p = '{"id"' + p
    elif not p.startswith("{"):
        p = "{" + p
    if not p.rstrip().endswith("}"):
        q = p.rstrip().rstrip(",")
        open_brackets = q.count("[")
        close_brackets = q.count("]")
        if open_brackets > close_brackets:
            q += "]" * (open_brackets - close_brackets)
        if not q.endswith("}"):
            q += "}"
        p = q
    return _fix_prompt_doubled_quotes(p)


def parse_questions_json_blob(blob: str) -> list[dict[str, Any]]:
    """Parse one or more question objects embedded in a malformed ``id`` string."""
    raw = str(blob or "").strip()
    if len(raw) < 12:
        return []
    if not any(k in raw for k in ('"prompt"', '"question"', '"options"', "prompt")):
        return []

    inner = raw.strip().strip("[]")
    parts = re.split(r"\}\s*,\s*\{", inner)
    objs: list[dict[str, Any]] = []

    for i, part in enumerate(parts):
        chunk = _wrap_blob_object(part if i > 0 else part)
        if i > 0 and not chunk.lstrip().startswith("{"):
            chunk = "{" + chunk.lstrip()
        try:
            parsed = json.loads(chunk)
            if isinstance(parsed, dict) and _question_has_body(parsed):
                objs.append(parsed)
                continue
        except Exception:
            pass
        extracted = _regex_extract_question(chunk)
        if extracted:
            objs.append(extracted)

    if objs:
        return objs

    wrapped = raw if raw.startswith("[") else f"[{_wrap_blob_object(raw)}]"
    try:
        parsed = json.loads(_fix_prompt_doubled_quotes(wrapped))
        if isinstance(parsed, list):
            rows = [x for x in parsed if isinstance(x, dict) and _question_has_body(x)]
            if rows:
                return rows
    except Exception:
        pass
    return []


def repair_clarification_questions(
    items: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], str | None]:
    """Expand malformed rows; hoist ``title`` from a single wrapper question."""
    out: list[dict[str, Any]] = []
    hoisted_title: str | None = None

    for q in items:
        if not isinstance(q, dict):
            continue
        if _question_has_body(q):
            out.append(q)
            continue

        blob = str(q.get("id") or "").strip()
        title_on_row = str(q.get("title") or "").strip()
        if title_on_row and not hoisted_title:
            hoisted_title = title_on_row

        if len(blob) >= 12 and ("prompt" in blob or "options" in blob or '"prompt"' in blob):
            expanded = parse_questions_json_blob(blob)
            if expanded:
                out.extend(expanded)
                continue

        prompt = str(q.get("prompt") or q.get("question") or "").strip()
        if prompt:
            out.append(q)

    if len(items) == 1 and len(out) >= 1 and not hoisted_title:
        only_title = str(items[0].get("title") or "").strip()
        if only_title:
            hoisted_title = only_title

    return out, hoisted_title


MAX_CLARIFICATION_QUESTIONS = 3


def cap_clarification_questions(items: list[Any]) -> list[Any]:
    """Return at most ``MAX_CLARIFICATION_QUESTIONS`` items (ask_clarification UI limit)."""
    if len(items) <= MAX_CLARIFICATION_QUESTIONS:
        return items
    return items[:MAX_CLARIFICATION_QUESTIONS]
