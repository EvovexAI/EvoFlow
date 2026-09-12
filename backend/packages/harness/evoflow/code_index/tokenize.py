"""Code-aware tokenization for FTS index + query expansion.

SQLite FTS5 ``unicode61`` keeps CamelCase identifiers as single tokens
(``applyAssistantTextDelta``), so substring queries miss unless we index
split parts (``apply``, ``Assistant``, ``Text``, ``Delta``).

Chinese comments/docs use char-bigram fallback (jieba removed for perf).
"""

from __future__ import annotations

import re

_CAMEL_BOUNDARY = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")
_CJK_RUN = re.compile(r"[\u4e00-\u9fff]{2,}")
_ASCII_IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]{2,}")
_PATH_SEG = re.compile(r"[A-Za-z0-9_.-]+")

_INDEX_TOKENIZER_VERSION = "code_tokens_v1"


def index_tokenizer_version() -> str:
    return _INDEX_TOKENIZER_VERSION


def split_identifier(name: str) -> list[str]:
    """Split CamelCase / snake_case identifier into searchable tokens."""
    raw = str(name or "").strip().strip("\"'")
    if not raw or len(raw) < 2:
        return []
    out: list[str] = []
    seen: set[str] = set()

    def add(t: str) -> None:
        t = t.strip().strip("_")
        if len(t) < 2:
            return
        key = t.casefold()
        if key in seen:
            return
        seen.add(key)
        out.append(t)

    add(raw)
    if "_" in raw:
        for seg in raw.split("_"):
            add(seg)
    camel = _CAMEL_BOUNDARY.sub(" ", raw.replace("_", " "))
    for seg in camel.split():
        add(seg)
    return out


def _segment_cjk(text: str) -> list[str]:
    """Character-bigram fallback for Chinese text (jieba removed to avoid cache IO lag)."""
    text = str(text or "").strip()
    if not text:
        return []
    out: list[str] = []
    for m in _CJK_RUN.finditer(text):
        run = m.group(0)
        out.append(run)
        if len(run) >= 4:
            for i in range(len(run) - 1):
                bigram = run[i : i + 2]
                if len(bigram) >= 2:
                    out.append(bigram)
    return out


def tokens_from_text(text: str, *, max_tokens: int = 2500) -> list[str]:
    """Extract index/query tokens from source text, paths, or NL queries."""
    s = str(text or "")
    if not s.strip():
        return []
    out: list[str] = []
    seen: set[str] = set()

    def add(raw: str, *, force: bool = False) -> None:
        t = str(raw or "").strip().strip("\"'")
        if not t:
            return
        if not force and len(t) < 2:
            return
        key = t.casefold()
        if key in seen:
            return
        seen.add(key)
        out.append(t)

    for m in _ASCII_IDENT.finditer(s):
        ident = m.group(0)
        add(ident, force=True)
        for part in split_identifier(ident):
            add(part, force=True)

    for m in _CJK_RUN.finditer(s):
        for tok in _segment_cjk(m.group(0)):
            add(tok, force=True)

    for seg in re.split(r"[\s,;|/\\]+", s):
        seg = seg.strip()
        if not seg:
            continue
        add(seg)
        for part in split_identifier(seg):
            add(part, force=True)
        for sub in _PATH_SEG.findall(seg):
            add(sub)
            for part in split_identifier(sub):
                add(part, force=True)

    return out[:max_tokens]


def build_fts_aux_text(
    rel: str,
    snippet: str,
    symbol_names: list[str] | None = None,
    *,
    max_tokens: int = 2500,
) -> str:
    """Space-separated extra tokens stored after path+snippet in fts_content."""
    parts: list[str] = []
    seen: set[str] = set()

    def push(token: str) -> None:
        key = token.casefold()
        if key in seen or len(token) < 2:
            return
        seen.add(key)
        parts.append(token)

    for raw in [rel, *str(rel).replace("\\", "/").split("/")]:
        for t in tokens_from_text(raw, max_tokens=200):
            push(t)

    for name in symbol_names or []:
        for t in tokens_from_text(str(name), max_tokens=50):
            push(t)

    for t in tokens_from_text(snippet[:24_000], max_tokens=max_tokens):
        push(t)

    return " ".join(parts[:max_tokens])
