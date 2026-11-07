"""Single-file user profile SoT under ``profile/USER.md``.

Legacy split (``basic-info.md`` / ``preferences.md`` / ``persona.md``) is merged
on ensure and then retired.
"""

from __future__ import annotations

import re
from typing import Literal

from evoflow.assets.injection_budget import TIER0_USER_PROFILE_CHARS, cap_text_chars
from evoflow.assets.paths import EntityRef, profile_dir, profile_path

ProfileInjectionScope = Literal["full", "identity"]

USER_PROFILE_FILENAME = "USER.md"
LEGACY_PROFILE_DIMENSION_FILES: tuple[str, ...] = (
    "basic-info.md",
    "preferences.md",
    "persona.md",
)
# Compat aliases: tools / UI may still pass old dim names → all write USER.md.
_LEGACY_ALIASES = {
    "basic-info": USER_PROFILE_FILENAME,
    "basic-info.md": USER_PROFILE_FILENAME,
    "basic_info": USER_PROFILE_FILENAME,
    "preferences": USER_PROFILE_FILENAME,
    "preferences.md": USER_PROFILE_FILENAME,
    "persona": USER_PROFILE_FILENAME,
    "persona.md": USER_PROFILE_FILENAME,
    "user": USER_PROFILE_FILENAME,
    "user.md": USER_PROFILE_FILENAME,
    "profile": USER_PROFILE_FILENAME,
    "profile.md": USER_PROFILE_FILENAME,
    USER_PROFILE_FILENAME.lower(): USER_PROFILE_FILENAME,
}


def default_user_profile_md() -> str:
    return (
        "# 用户画像\n\n"
        "填写后会注入每个 Agent 的系统提示词。一块文档即可，按需填写。\n\n"
        "## 基本信息\n"
        "（希望 Agent 如何称呼您；常用语言、时区或所在城市；职业/角色）\n\n"
        "## 偏好与爱好\n"
        "（回复风格：简洁/详细；爱好；希望避免的话题）\n\n"
        "## 沟通与工作习惯\n"
        "（如：结论先行、先诊断再改、常用工具栈）\n"
    )


def resolve_profile_filename(path_or_tag: str | None = None) -> str:
    """Any legacy dim name / empty → ``USER.md``."""
    raw = str(path_or_tag or "").strip().lower()
    if not raw:
        return USER_PROFILE_FILENAME
    key = raw.replace("_", "-")
    if key in _LEGACY_ALIASES:
        return _LEGACY_ALIASES[key]
    if key.endswith(".md") and key in _LEGACY_ALIASES:
        return _LEGACY_ALIASES[key]
    # Unknown path still lands on the single profile file.
    return USER_PROFILE_FILENAME


def resolve_profile_dimension(path_or_tag: str) -> str:
    """Compat: return filename (always USER.md)."""
    return resolve_profile_filename(path_or_tag)


def resolve_profile_injection_scope(
    *,
    agent_name: str | None = None,
    entity_type: str | None = None,
) -> ProfileInjectionScope:
    _ = (agent_name, entity_type)
    return "full"


def profile_dimensions_for_scope(scope: ProfileInjectionScope) -> tuple[str, ...]:
    """Compat shim — single file for both scopes."""
    _ = scope
    return (USER_PROFILE_FILENAME,)


def _append_profile_content(existing: str, addition: str) -> str:
    add = str(addition or "").strip()
    if not add:
        return existing
    from evoflow.assets.ad_hoc_note import as_bullet_block

    bullet = as_bullet_block(add)
    if not bullet:
        return existing
    base = str(existing or "").strip() or default_user_profile_md().strip()
    if add in base or bullet in base:
        return base + "\n"
    section = "## Agent 补充"
    if section not in base:
        return base.rstrip() + f"\n\n{section}\n{bullet}\n"
    # Insert **at the end of that section**, not at end-of-file: the section is
    # usually followed by more headings, and appending to the document put the
    # bullet under whatever heading happened to be last (and a multi-line note
    # there silently promoted its own lines into real sections).
    idx = base.find(section)
    rest = base[idx + len(section) :]
    nxt = re.search(r"\n#{1,3}\s", rest)
    insert_at = idx + len(section) + (nxt.start() if nxt else len(rest))
    head = base[:insert_at].rstrip()
    return f"{head}\n{bullet}\n{base[insert_at:].lstrip()}" if nxt else f"{head}\n{bullet}\n"


def update_profile_dimension(
    *,
    dimension: str = "",
    content: str,
    mode: str = "append",
    entity: EntityRef | None = None,
) -> dict[str, str]:
    """Agent/user write to the single ``USER.md`` profile."""
    _ = resolve_profile_filename(dimension)
    ent = (entity or EntityRef("user", "user")).normalized()
    if ent.entity_type != "user":
        raise ValueError("profile updates only supported for user entity")
    ensure_user_profile_files(ent)
    p = profile_path(ent, USER_PROFILE_FILENAME)
    try:
        existing = p.read_text(encoding="utf-8") if p.is_file() else default_user_profile_md()
    except OSError:
        existing = default_user_profile_md()
    text = str(content or "").strip()
    if not text:
        raise ValueError("content required")
    act = str(mode or "append").strip().lower()
    if act == "replace":
        new_body = text if text.lstrip().startswith("#") else f"# 用户画像\n\n{text}".strip() + "\n"
    elif act == "append":
        new_body = _append_profile_content(existing, text)
    else:
        raise ValueError("mode must be append or replace")
    from evoflow.assets.hub import write_profile_field

    write_profile_field(ent, USER_PROFILE_FILENAME, new_body)
    return {"filename": USER_PROFILE_FILENAME, "tag": "user_profile", "mode": act}


_PLACEHOLDER_LINE_RE = None


def _placeholder_line_re():
    global _PLACEHOLDER_LINE_RE
    if _PLACEHOLDER_LINE_RE is None:
        _PLACEHOLDER_LINE_RE = re.compile(
            r"^\s*(?:[-*]\s*)?[（(]\s*(?:如|例|可选|例如|等待|希望|e\.g\.)[^）)]*[）)]\s*$"
            r"|^[^\n]{0,20}填写后会注入[^\n]*$"
            r"|^\s*(?:[-*]\s*)?[（(][^）)]*(?:待补|尚未提供|尚未补充|未提供身份)[^）)]*[）)]\s*$"
            r"|^\s*(?:[-*]\s*)?(?:待补|尚未提供)[：:].*$"
            r"|^[^\n]{0,24}一块文档即可[^\n]*$",
            re.MULTILINE,
        )
    return _PLACEHOLDER_LINE_RE


def _strip_yaml_frontmatter(text: str) -> str:
    raw = str(text or "")
    if not raw.lstrip().startswith("---"):
        return raw
    m = re.match(r"^\s*---\s*\n[\s\S]*?\n---\s*\n?", raw)
    return raw[m.end() :] if m else raw


def _strip_orphaned_section_headings(text: str) -> str:
    lines = text.splitlines()
    result: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        m = re.match(r"^#+\s+\S", line)
        if m:
            has_content = False
            j = i + 1
            blank_count = 0
            while j < len(lines):
                next_line = lines[j].strip()
                if re.match(r"^#+\s+\S", next_line):
                    break
                if next_line:
                    has_content = True
                    break
                blank_count += 1
                if blank_count > 3:
                    break
                j += 1
            if has_content:
                result.append(line)
        else:
            result.append(line)
        i += 1
    return "\n".join(result)


def _strip_placeholder_body(text: str, *, filename: str = USER_PROFILE_FILENAME) -> str:
    _ = filename
    raw = _strip_yaml_frontmatter(str(text or "")).strip()
    if not raw:
        return ""
    default = default_user_profile_md().strip()
    if raw == default:
        return ""
    # Also treat pure legacy templates as empty.
    for legacy_name, legacy_default in (
        ("basic-info.md", _legacy_basic_info_md()),
        ("preferences.md", _legacy_preferences_md()),
        ("persona.md", _legacy_persona_md()),
    ):
        if raw == legacy_default.strip():
            return ""
    body = _placeholder_line_re().sub("", raw)
    body = _strip_orphaned_section_headings(body)
    body = re.sub(r"\n{3,}", "\n\n", body).strip()
    if not body:
        return ""

    def _prose_len(s: str) -> int:
        b = re.sub(r"^#+\s*[^\n]+\n?", "", s, flags=re.M)
        return len(re.sub(r"\s+", "", b))

    if _prose_len(body) == 0:
        return ""
    return body


def dimension_is_filled(text: str, *, filename: str = USER_PROFILE_FILENAME) -> bool:
    return bool(_strip_placeholder_body(text, filename=filename))


def _legacy_basic_info_md() -> str:
    return (
        "# 基本信息\n\n"
        "填写后会注入每个 Agent 的 Tier-0 提示词。\n\n"
        "## 称呼\n"
        "（希望 Agent 如何称呼您，如：老张 / Alex）\n\n"
        "## 语言与时区\n"
        "（如：中文；UTC+8 / 上海）\n\n"
        "## 职业与角色\n"
        "（如：全栈工程师、产品经理、学生）\n\n"
        "## 所在地\n"
        "（可选；城市或地区）\n"
    )


def _legacy_preferences_md() -> str:
    return "# 偏好与爱好\n\n## 回复风格\n（如：结论先行、中文、简洁、少 emoji）\n\n## 爱好与兴趣\n（可选；用于闲聊与共情，非任务必需）\n\n## 避免事项\n（可选；不想被提及的话题或禁忌）\n"


def _legacy_persona_md() -> str:
    return "# 画像与行为特征\n\n## 沟通方式\n（如：直接、偏技术、需要步骤清单）\n\n## 工作习惯\n（如：先读文档再改代码、偏好 PR 小步提交）\n\n## 决策与协作\n（如：风险敏感、重要操作前先确认）\n"


def _merge_legacy_dimensions(root) -> str | None:
    """Combine filled legacy files into one USER.md body; None if nothing real."""
    titles = {
        "basic-info.md": "基本信息",
        "preferences.md": "偏好与爱好",
        "persona.md": "沟通与工作习惯",
    }
    parts: list[str] = []
    for name in LEGACY_PROFILE_DIMENSION_FILES:
        p = root / name
        if not p.is_file():
            continue
        try:
            raw = p.read_text(encoding="utf-8")
        except OSError:
            continue
        filled = _strip_placeholder_body(raw, filename=name)
        if not filled:
            continue
        # Drop a leading H1 that duplicates the section title.
        body = re.sub(r"^#\s+[^\n]+\n+", "", filled).strip()
        if not body:
            continue
        parts.append(f"## {titles.get(name, name)}\n{body}")
    if not parts:
        return None
    return "# 用户画像\n\n" + "\n\n".join(parts) + "\n"


def ensure_user_profile_files(entity: EntityRef | None = None) -> None:
    """Ensure ``USER.md`` exists; migrate legacy three-file split once."""
    ent = (entity or EntityRef("user", "user")).normalized()
    root = profile_dir(ent)
    root.mkdir(parents=True, exist_ok=True)
    user_md = root / USER_PROFILE_FILENAME

    if not user_md.is_file():
        merged = _merge_legacy_dimensions(root)
        user_md.write_text(merged or default_user_profile_md(), encoding="utf-8")

    # Retire split files after USER.md exists (keep README if present).
    for name in LEGACY_PROFILE_DIMENSION_FILES:
        legacy = root / name
        if legacy.is_file():
            try:
                legacy.unlink()
            except OSError:
                pass


def read_user_profile_raw(
    *,
    entity: EntityRef | None = None,
    max_chars: int | None = None,
) -> str:
    """Read ``profile/USER.md`` verbatim (ensure file exists; no placeholder strip)."""
    ent = (entity or EntityRef("user", "user")).normalized()
    ensure_user_profile_files(ent)
    p = profile_path(ent, USER_PROFILE_FILENAME)
    try:
        raw = p.read_text(encoding="utf-8") if p.is_file() else ""
    except OSError:
        raw = ""
    text = str(raw or "").strip()
    if not text:
        return ""
    cap = int(max_chars if max_chars is not None else TIER0_USER_PROFILE_CHARS)
    return cap_text_chars(text, cap) if cap > 0 else text


def read_user_profile_dimensions(
    *,
    max_chars_per_dim: int | None = None,
    entity: EntityRef | None = None,
    strip_placeholders: bool = False,
) -> dict[str, str]:
    """Compat: returns ``{USER.md: text}``.

    Default inject path keeps the **whole** document (scaffold + Agent 补充).
    Pass ``strip_placeholders=True`` only for \"is this filled?\" UI/audit checks.
    """
    ent = (entity or EntityRef("user", "user")).normalized()
    ensure_user_profile_files(ent)
    cap = int(max_chars_per_dim if max_chars_per_dim is not None else TIER0_USER_PROFILE_CHARS)
    p = profile_path(ent, USER_PROFILE_FILENAME)
    try:
        raw = p.read_text(encoding="utf-8") if p.is_file() else ""
    except OSError:
        raw = ""
    text = (
        _strip_placeholder_body(raw, filename=USER_PROFILE_FILENAME)
        if strip_placeholders
        else str(raw or "").strip()
    )
    if not text:
        return {USER_PROFILE_FILENAME: ""}
    return {USER_PROFILE_FILENAME: cap_text_chars(text, cap) if cap > 0 else text}


def read_user_profile_combined(*, max_chars: int | None = None) -> str:
    return read_user_profile_raw(max_chars=max_chars)


def missing_profile_dimensions() -> list[str]:
    """True missing only when stripped body has no real facts (scaffold alone counts as missing for UI)."""
    dims = read_user_profile_dimensions(max_chars_per_dim=8000, strip_placeholders=True)
    if (dims.get(USER_PROFILE_FILENAME) or "").strip():
        return []
    return [USER_PROFILE_FILENAME]


def build_user_profile_injection_block(
    *,
    prompt_language: str | None = None,
    scope: ProfileInjectionScope = "full",
    entity: EntityRef | None = None,
) -> str:
    """Inject the full ``profile/USER.md`` document (verbatim, including scaffold).

    Asset Center edits are the SoT — do not strip placeholders or skip empty-looking
    templates; always load the whole markdown file when memory/profile injection is on.
    """
    _ = prompt_language
    ent = (entity or EntityRef("user", "user")).normalized()
    text = read_user_profile_raw(entity=ent).strip()
    if not text:
        # ensure created an empty/unreadable file — still emit a minimal tag so the
        # model knows the slot exists (path relative to user asset root).
        text = default_user_profile_md().strip()
    # identity scope still injects the same single profile (global user facts).
    _ = scope
    root_tag = "user_profile" if scope == "full" else "user_identity"
    return f"<{root_tag}>\n{text}\n</{root_tag}>"
