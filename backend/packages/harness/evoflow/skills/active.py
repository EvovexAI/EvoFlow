"""Turn-level active skill names for shell path rewriting."""

from __future__ import annotations

from contextvars import ContextVar, Token

_active_skill_names: ContextVar[tuple[str, ...]] = ContextVar("evf_active_skill_names", default=())


def set_active_skills(names: list[str]) -> Token:
    cleaned = tuple(dict.fromkeys(str(n).strip().lower() for n in names if str(n).strip()))
    return _active_skill_names.set(cleaned)


def reset_active_skills(token: Token) -> None:
    _active_skill_names.reset(token)


def get_active_skills() -> list[str]:
    return list(_active_skill_names.get())
