"""User profile split into maintainable dimension files under ``profile/``.

Inspired by portable identity schemas (e.g. life.json ``identity`` + ``preferences``,
UCS ``persona`` + ``preference_corpus``): stable facts vs style vs behavior.

SoT: ``assets/user/profile/{basic-info,preferences,persona}.md``（资产中心）。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from evoflow.assets.injection_budget import TIER0_USER_PROFILE_CHARS, cap_text_chars
from evoflow.assets.paths import EntityRef, profile_dir, profile_path

ProfileInjectionScope = Literal["full", "identity"]

USER_PROFILE_DIMENSION_FILES: tuple[str, ...] = (
    "basic-info.md",
    "preferences.md",
    "persona.md",
)


@dataclass(frozen=True)
class UserProfileDimension:
    filename: str
    tag: str
    title_zh: str
    title_en: str
    ask_zh: str
    ask_en: str


USER_PROFILE_DIMENSIONS: tuple[UserProfileDimension, ...] = (
    UserProfileDimension(
        filename="basic-info.md",
        tag="basic_info",
        title_zh="基本信息",
        title_en="Basic info",
        ask_zh="您希望我怎么称呼您？常用语言、时区或所在城市、职业/角色？",
        ask_en="How should I address you? Preferred language, timezone, city, or role?",
    ),
    UserProfileDimension(
        filename="preferences.md",
        tag="preferences",
        title_zh="偏好与爱好",
        title_en="Preferences & interests",
        ask_zh="您偏好的回复风格（简洁/详细）、爱好、或希望避免的话题？",
        ask_en="Reply style (brief/detailed), hobbies, or topics to avoid?",
    ),
    UserProfileDimension(
        filename="persona.md",
        tag="persona",
        title_zh="画像与行为特征",
        title_en="Persona & behavior",
        ask_zh="您平时的工作/沟通习惯？例如结论先行、先诊断再改、常用工具栈？",
        ask_en="Work and communication habits? e.g. lead with conclusions, diagnose first?",
    ),
)

_DIM_BY_FILE = {d.filename: d for d in USER_PROFILE_DIMENSIONS}
_DIM_BY_TAG = {d.tag: d for d in USER_PROFILE_DIMENSIONS}

USER_PROFILE_IDENTITY_DIMENSION = USER_PROFILE_DIMENSIONS[0]


def profile_dimensions_for_scope(scope: ProfileInjectionScope) -> tuple[UserProfileDimension, ...]:
    """``full``: dialogue (basic + preferences + persona). ``identity``: employee duty (basic only)."""
    if scope == "identity":
        return (USER_PROFILE_IDENTITY_DIMENSION,)
    return USER_PROFILE_DIMENSIONS


def resolve_profile_injection_scope(
    *,
    agent_name: str | None = None,
    entity_type: str | None = None,
) -> ProfileInjectionScope:
    """Employees get identity-only; main/custom-agent chat gets full profile."""
    if str(entity_type or "").strip().lower() == "employee":
        return "identity"
    code = str(agent_name or "").strip().lower()
    if not code or code in ("main", "user", "default", "lead_agent"):
        return "full"
    try:
        from evoflow.assets.guidance import is_employee_agent_name

        if is_employee_agent_name(agent_name):
            return "identity"
    except Exception:
        pass
    return "full"


def resolve_profile_dimension(path_or_tag: str) -> UserProfileDimension:
    """Map filename, tag, or shorthand to a profile dimension."""
    raw = str(path_or_tag or "").strip().lower()
    if not raw:
        raise ValueError("profile dimension required (basic-info, preferences, persona)")
    key = raw.replace("_", "-")
    if not key.endswith(".md"):
        key_md = f"{key}.md" if key in {d.filename.removesuffix(".md") for d in USER_PROFILE_DIMENSIONS} else raw
    else:
        key_md = raw
    if key_md in _DIM_BY_FILE:
        return _DIM_BY_FILE[key_md]
    tag = raw.replace("-", "_")
    if tag in _DIM_BY_TAG:
        return _DIM_BY_TAG[tag]
    raise ValueError(f"unsupported profile dimension: {path_or_tag!r}")


def _append_profile_content(existing: str, addition: str, *, filename: str) -> str:
    add = str(addition or "").strip()
    if not add:
        return existing
    base = str(existing or "").strip() or _default_for_file(filename).strip()
    if add in base:
        return base + "\n"
    section = "## Agent 补充"
    if section in base:
        return base.rstrip() + f"\n- {add}\n"
    return base.rstrip() + f"\n\n{section}\n- {add}\n"


def update_profile_dimension(
    *,
    dimension: str,
    content: str,
    mode: str = "append",
    entity: EntityRef | None = None,
) -> dict[str, str]:
    """Agent/user write to one profile dimension file."""
    dim = resolve_profile_dimension(dimension)
    ent = (entity or EntityRef("user", "user")).normalized()
    if ent.entity_type != "user":
        raise ValueError("profile updates only supported for user entity")
    ensure_user_profile_files(ent)
    p = profile_path(ent, dim.filename)
    try:
        existing = p.read_text(encoding="utf-8") if p.is_file() else _default_for_file(dim.filename)
    except OSError:
        existing = _default_for_file(dim.filename)
    text = str(content or "").strip()
    if not text:
        raise ValueError("content required")
    act = str(mode or "append").strip().lower()
    if act == "replace":
        new_body = text if text.lstrip().startswith("#") else f"{existing.split(chr(10), 1)[0]}\n\n{text}".strip() + "\n"
    elif act == "append":
        new_body = _append_profile_content(existing, text, filename=dim.filename)
    else:
        raise ValueError("mode must be append or replace")
    from evoflow.assets.hub import write_profile_field

    write_profile_field(ent, dim.filename, new_body)
    return {"filename": dim.filename, "tag": dim.tag, "mode": act}


def default_basic_info_md() -> str:
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


def default_preferences_md() -> str:
    return "# 偏好与爱好\n\n## 回复风格\n（如：结论先行、中文、简洁、少 emoji）\n\n## 爱好与兴趣\n（可选；用于闲聊与共情，非任务必需）\n\n## 避免事项\n（可选；不想被提及的话题或禁忌）\n"


def default_persona_md() -> str:
    return "# 画像与行为特征\n\n## 沟通方式\n（如：直接、偏技术、需要步骤清单）\n\n## 工作习惯\n（如：先读文档再改代码、偏好 PR 小步提交）\n\n## 决策与协作\n（如：风险敏感、重要操作前先确认）\n"


def _default_for_file(filename: str) -> str:
    return {
        "basic-info.md": default_basic_info_md(),
        "preferences.md": default_preferences_md(),
        "persona.md": default_persona_md(),
    }.get(filename, "")


_PLACEHOLDER_LINE_RE = None


def _placeholder_line_re():
    """Lazy compiled regex matching whole-line placeholder prompts.

    Covers template hints like ``（如：…）`` / ``（可选；…）`` / ``(e.g. …)`` —
    example scaffolds, not real user input. Also matches the ``## 填写后会注入…``
    intro lines of the default templates.
    """
    global _PLACEHOLDER_LINE_RE
    if _PLACEHOLDER_LINE_RE is None:
        import re as _re

        _PLACEHOLDER_LINE_RE = _re.compile(
            r"^\s*(?:[-*]\s*)?[（(]\s*(?:如|例|可选|例如|等待|希望|e\.g\.)[^）)]*[）)]\s*$"
            r"|^[^\n]{0,12}填写后会注入[^\n]*$",
            _re.MULTILINE,
        )
    return _PLACEHOLDER_LINE_RE


def _strip_orphaned_section_headings(text: str) -> str:
    """Remove section headings (# heading\n) that have no non-empty content immediately below them.

    After stripping placeholder lines, some sections may be left with just a heading
    and no prose. These orphan headings count as "decorative" and should be removed.
    """
    import re as _re

    lines = text.splitlines()
    result: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        # Match section heading (any level: # ## ### etc.)
        m = _re.match(r"^#+\s+\S", line)
        if m:
            # Check if there's non-empty content in the next N lines
            has_content = False
            j = i + 1
            # Allow up to 3 blank lines before next heading
            blank_count = 0
            while j < len(lines):
                next_line = lines[j].strip()
                if _re.match(r"^#+\s+\S", next_line):
                    # Next heading reached — this heading has no content
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


def _strip_placeholder_body(text: str, *, filename: str) -> str:
    raw = str(text or "").strip()
    if not raw:
        return ""
    default = _default_for_file(filename).strip()
    if raw == default:
        return ""
    # Strip whole-line placeholder scaffolds (（如：…）/（可选；…）) instead of
    # comparing total prose length — partial fills previously leaked the leftover
    # template examples into prompt injection as if they were real preferences.
    body = _placeholder_line_re().sub("", raw)

    # Strip orphaned section headings that no longer have any content below them
    # (e.g. "## 回复风格\n" with no prose underneath after placeholder stripping).
    body = _strip_orphaned_section_headings(body)

    body = re.sub(r"\n{3,}", "\n\n", body).strip()
    if not body:
        return ""

    def _prose_len(s: str) -> int:
        b = re.sub(r"^#+\s*[^\n]+\n?", "", s, flags=re.M)
        return len(re.sub(r"\s+", "", b))

    # A file reduced to bare section headings (no real content) counts as empty.
    if _prose_len(body) == 0:
        return ""
    return body


def dimension_is_filled(text: str, *, filename: str) -> bool:
    return bool(_strip_placeholder_body(text, filename=filename))


def ensure_user_profile_files(entity: EntityRef | None = None) -> None:
    """Ensure dimension files exist under ``profile/`` (asset center SoT)."""
    ent = (entity or EntityRef("user", "user")).normalized()
    root = profile_dir(ent)
    root.mkdir(parents=True, exist_ok=True)

    for name in USER_PROFILE_DIMENSION_FILES:
        p = root / name
        if not p.is_file():
            p.write_text(_default_for_file(name), encoding="utf-8")

    # Drop retired monolith if present (no longer read or shown).
    legacy = root / "USER.md"
    if legacy.is_file():
        try:
            legacy.unlink()
        except OSError:
            pass


def read_user_profile_dimensions(
    *,
    max_chars_per_dim: int | None = None,
    entity: EntityRef | None = None,
) -> dict[str, str]:
    ent = (entity or EntityRef("user", "user")).normalized()
    ensure_user_profile_files(ent)
    cap = max_chars_per_dim
    if cap is None:
        cap = max(80, TIER0_USER_PROFILE_CHARS // max(1, len(USER_PROFILE_DIMENSIONS)))
    out: dict[str, str] = {}
    for dim in USER_PROFILE_DIMENSIONS:
        p = profile_path(ent, dim.filename)
        try:
            raw = p.read_text(encoding="utf-8") if p.is_file() else ""
        except OSError:
            raw = ""
        filled = _strip_placeholder_body(raw, filename=dim.filename)
        out[dim.filename] = cap_text_chars(filled, int(cap)) if filled else ""
    return out


def read_user_profile_combined(*, max_chars: int | None = None) -> str:
    """Aggregate for legacy API / CLI."""
    dims = read_user_profile_dimensions()
    parts: list[str] = []
    for dim in USER_PROFILE_DIMENSIONS:
        text = dims.get(dim.filename) or ""
        if text.strip():
            parts.append(f"## {dim.title_zh}\n{text.strip()}")
    combined = "\n\n".join(parts).strip()
    cap = int(max_chars if max_chars is not None else TIER0_USER_PROFILE_CHARS * 2)
    return cap_text_chars(combined, cap)


def missing_profile_dimensions() -> list[UserProfileDimension]:
    dims = read_user_profile_dimensions(max_chars_per_dim=8000)
    return [d for d in USER_PROFILE_DIMENSIONS if not (dims.get(d.filename) or "").strip()]


def build_user_profile_injection_block(
    *,
    prompt_language: str | None = None,
    scope: ProfileInjectionScope = "full",
    entity: EntityRef | None = None,
) -> str:
    from evoflow.agents.lead_agent.prompt_language import resolve_prompt_language

    lang = resolve_prompt_language(prompt_language)
    ent = (entity or EntityRef("user", "user")).normalized()
    ensure_user_profile_files(ent)
    dims = read_user_profile_dimensions(entity=ent)
    active = profile_dimensions_for_scope(scope)
    missing = [d for d in active if not (dims.get(d.filename) or "").strip()]

    root_tag = "user_profile" if scope == "full" else "user_identity"
    lines: list[str] = [f"<{root_tag}>"]
    if scope == "identity":
        if lang == "en":
            lines.append("(Employee context — inject user identity only; preferences/persona omitted. Use assets(search) on user memory if task-specific prefs matter.)")
        else:
            lines.append("（员工上下文 — 仅注入用户身份信息；偏好/行为画像不注入。若任务需要具体偏好，可用 assets(search) 查用户 memory/facts。）")
    for dim in active:
        text = (dims.get(dim.filename) or "").strip()
        lines.append(f"<{dim.tag}>")
        if text:
            lines.append(text)
        else:
            ask = dim.ask_en if lang == "en" else dim.ask_zh
            if lang == "en":
                lines.append(f"(EMPTY — REQUIRED: in this conversation you MUST ask the user this when they have not already answered it, then save with `write` to profile file: {ask})")
            else:
                lines.append(f"（空 — 强制：本对话中若用户尚未补充该项，你必须主动向用户询问，得到回答后立刻用 `write`/`replace` 写入 profile 文件：{ask}）")
        lines.append(f"</{dim.tag}>")

    if missing:
        if lang == "en":
            gaps = "; ".join(d.ask_en for d in missing[:3])
            # Profile gaps are agent behavior directives, not user data; render under
            # <agent_behavior> so the prompt parser does not mis-classify them as
            # profile content and so the user-facing profile block stays clean.
            lines.append("<agent_behavior>")
            if scope == "identity":
                lines.append(
                    "MANDATORY: User identity is incomplete. You MUST proactively ask "
                    "(brief, friendly — not a long form) for missing fields in this conversation "
                    "if the user has not already provided them — e.g. " + gaps + ". After they answer, you MUST use "
                    "`write`/`replace` on the profile file and confirm briefly. "
                    "Do not only chat without writing."
                )
            else:
                lines.append(
                    "MANDATORY profile gap policy (non-negotiable):\n"
                    "1) If any dimension below is empty and the user has NOT already supplied that info "
                    "in this conversation, you MUST actively ask 1–2 short questions this turn or the "
                    "next natural turn — do not wait for them to volunteer. Example prompts: " + gaps + ".\n"
                    "2) As soon as they answer, you MUST persist with "
                    "`write`/`replace` on the profile file "
                    "and confirm in one short line.\n"
                    "3) Never finish the turn with only verbal acknowledgment and no profile write "
                    "when new stable facts were shared.\n"
                    "Tone: warm and brief; never grill like a questionnaire."
                )
                lines.append("They can also edit under Asset Center → Profile (#/assets → 画像).")
            lines.append("</agent_behavior>")
        else:
            gaps = "；".join(d.ask_zh for d in missing[:3])
            lines.append("<agent_behavior>")
            if scope == "identity":
                lines.append(
                    "【强制】用户身份信息不完整。若本对话中用户尚未提供缺口信息，"
                    "你必须主动、简短友好地询问（不要长问卷），例如：" + gaps + "。用户回答后，必须立刻调用 "
                    "`write`/`replace` 写入 profile 文件，并简短确认已更新。"
                    "禁止只聊不写。"
                )
            else:
                lines.append(
                    "【强制·用户画像缺口策略】不可省略：\n"
                    "1）下列维度若仍为空，且用户在本对话中尚未补充对应信息，"
                    "你必须在本回合或紧接着的自然回合主动提问（每轮最多 1～2 句），"
                    "不要等用户主动提起。可参考：" + gaps + "。\n"
                    "2）用户一旦回答，必须马上用 "
                    "`write`/`replace` 写入 profile 文件"
                    "，并用一句话确认已更新。\n"
                    "3）用户已透露稳定信息时，禁止只口头应承而不写 profile。\n"
                    "语气：友善、简短；不要像填表审问。"
                )
                lines.append("用户也可直接在 UI 智能体 Tab 维护 basic-info / preferences / persona。")
            lines.append("</agent_behavior>")
    elif scope == "full":
        if lang == "en":
            lines.append("<profile_upkeep>")
            lines.append(
                "MANDATORY upkeep: When the user shares new stable facts, preferences, or habits — "
                "or corrects old ones — you MUST update the matching dimension via "
                "`write`/`replace` on the profile file. "
                "Default append; use replace only after confirmation if it contradicts existing text. "
                "Do not only acknowledge verbally."
            )
            lines.append("</profile_upkeep>")
        else:
            lines.append("<profile_upkeep>")
            lines.append(
                "【强制维护】用户透露新的稳定信息（称呼、偏好、习惯）或更正旧画像时，"
                "必须用 `write`/`replace` 主动更新 profile 文件；禁止只口头记下。"
            )
            lines.append("</profile_upkeep>")
    elif scope == "identity":
        if lang == "en":
            lines.append("<profile_upkeep>")
            lines.append("When the user shares name, role, language, or timezone, use `write`/`replace` to update the profile file. Leave preferences/persona to dialogue agents.")
            lines.append("</profile_upkeep>")
        else:
            lines.append("<profile_upkeep>")
            lines.append("用户透露称呼、职业、语言、时区等身份信息时，用 `write`/`replace` 更新 profile 文件；偏好与行为画像由对话 Agent 维护，员工任务不必写入。")
            lines.append("</profile_upkeep>")
    lines.append(f"</{root_tag}>")
    return "\n".join(lines)
