"""Load runtime-adapted Asset Hub memory prompt templates."""

from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

_PROMPTS_DIR = Path(__file__).resolve().parent / "prompts" / "memories"
# Match {{ key }} with optional spaces — same surface as render_memory_prompt's
# replace loops. Used to discover unfilled placeholders so they can be cleared.
_PLACEHOLDER_RE = re.compile(r"\{\{\s*([a-zA-Z_][\w]*)\s*\}\}")


@lru_cache(maxsize=16)
def load_memory_prompt(name: str) -> str:
    """Load a template by stem, e.g. ``read_path``, ``stage_one_system``."""
    stem = str(name or "").strip().removesuffix(".md")
    path = _PROMPTS_DIR / f"{stem}.md"
    if not path.is_file():
        raise FileNotFoundError(f"memory prompt template not found: {path}")
    return path.read_text(encoding="utf-8")


def render_memory_prompt(name: str, **vars: str) -> str:
    """Simple ``{{ key }}`` substitution (native-style placeholders).

    Unfilled placeholders become empty strings (instead of leaking the literal
    ``{{ key }}`` token), so callers can omit optional vars without breaking
    the rendered prompt.
    """
    text = load_memory_prompt(name)
    for key, value in vars.items():
        text = text.replace("{{ " + key + " }}", str(value or ""))
        text = text.replace("{{" + key + "}}", str(value or ""))
    # Drop any remaining {{ key }} the caller didn't supply — better to emit
    # empty space than to leak template syntax into a runtime prompt.
    text = _PLACEHOLDER_RE.sub("", text)
    return text
