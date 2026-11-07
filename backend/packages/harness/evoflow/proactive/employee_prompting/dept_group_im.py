"""Department group IM — force @-visible handoffs into the group timeline.

When session context has ``dept_group_im`` / ``dept_group_id``, inject a hard
block into the employee system prompt. Group chat is the collaboration bus;
colleagues are only woken when the reply body contains ``@角色名`` (frontend
parses that) or when tools return ``handlers`` that the frontend mirrors.

Static facts (dept name, steward role, roster, hard rules) live here in the
system prompt. Per-turn group timeline snippets stay on the user message —
they change every send and must not fight the cached system prompt.
"""

from __future__ import annotations

import re
from typing import Any

DEPT_GROUP_IM_OPEN = '<dept_group_im version="2">'
DEPT_GROUP_IM_CLOSE = "</dept_group_im>"

_RE_DEPT_GROUP_IM = re.compile(
    r"<dept_group_im\b[^>]*>.*?</dept_group_im>\s*",
    re.DOTALL | re.IGNORECASE,
)


def is_dept_group_im_context(ctx: dict[str, Any] | None) -> bool:
    if not isinstance(ctx, dict):
        return False
    if ctx.get("dept_group_im") in (True, 1, "1", "true", "True"):
        return True
    if str(ctx.get("dept_group_id") or "").strip():
        return True
    return False


def is_dept_group_steward_context(ctx: dict[str, Any] | None) -> bool:
    """User did not @ anyone; 小V is the default group steward for this turn."""
    if not isinstance(ctx, dict):
        return False
    return ctx.get("dept_group_steward") in (True, 1, "1", "true", "True")


def normalize_dept_group_roster(raw: Any) -> list[str]:
    """Role-name lines for 「本群可点名」; accepts str list or {role_name,agent_code} dicts."""
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in raw[:40]:
        name = ""
        if isinstance(item, str):
            name = item.strip()
        elif isinstance(item, dict):
            name = str(item.get("role_name") or item.get("agent_code") or "").strip()
        if not name or name in seen:
            continue
        seen.add(name)
        out.append(name)
    return out


def build_dept_group_im_block(
    *,
    dept_name: str = "",
    steward: bool = False,
    roster: list[str] | None = None,
) -> str:
    """Hard rules for department group chat turns (system prompt only)."""
    title = str(dept_name or "").strip() or "本部门"
    roster_names = [str(x).strip() for x in (roster or []) if str(x).strip()][:40]
    roster_line = "、".join(roster_names) if roster_names else ""
    if steward:
        lines = [
            DEPT_GROUP_IM_OPEN,
            f"部门群聊 · 小V 群管家（{title}）",
            f"你是小V，这个「{title}」常驻群的默认管家。"
            "用户没 @ 任何人时，话默认交给你。群时间线是唯一对用户可见的协作面。",
            f"你清楚：当前是群聊、对象是「{title}」、群里有谁、事情推进到哪"
            "（看本轮用户消息里的【群近期】，若有）。"
            "像聪明的微信群管家：先接住、再判断——该自己答就答，只有真要专人干活才 @。",
        ]
        if roster_line:
            lines.append(f"本群可点名：{roster_line}")
        else:
            lines.append("本群可点名：（花名册暂空，仍可先回用户再想办法）")
        lines.extend(
            [
                "何时 @（自主判断，宁缺毋滥）：",
                "· 用户要某人出面/干活/表态，或你答不了、必须专人接手时："
                "在同一条回复写「@角色名 + 具体交代」（可一次 @ 多人，每人一段）。"
                "系统只认正文 @（以及工具 handlers 经前端镜像）。",
                "· 打招呼、问好、寒暄、你能直接说清的进度/协调/澄清：自己回完即可，不要 @。",
                "· 已经 @ 过的人不要再重复点名催一轮；不要让用户自己去 @。",
                "硬规则：",
                "1. 直接口语回群；不要问「要不要转到这儿」。",
                "2. 可用 tasks / handlers 做实质流转时，同一条回复里仍要 @，群里才看得见。",
                "3. 禁止只报任务号/派单号却不 @。",
                "4. 【称呼】@ 与用户可见正文一律用岗位/角色名（花名册里的名字）。"
                "禁止在对用户可见的句子里写 agent_code / 内部编码"
                "（如 dev-backend、dev-fullstack）；工具入参可用编码，说话必须用人名。",
                "5. 【纯文本】群聊像微信：只输出普通文字。"
                "禁止 Markdown（不要用 # 标题、* / ** 加粗斜体、` 代码、``` 代码块、| 表格、"
                "- / 1. 清单符号装饰）。需要列举时用中文逗号或换行即可。",
                "6. 回合结束前必须交代结果：活已在手边完成的，正文给出结果；"
                "起了后台任务/工作流一时回不来的，正文报任务名并说明完成后系统会自动回执到群，"
                "不要无声结束回合。",
                DEPT_GROUP_IM_CLOSE,
            ]
        )
        return "\n".join(lines)
    lines = [
        DEPT_GROUP_IM_OPEN,
        f"部门群聊协作（{title}）",
        "你正在常驻部门群里被点名。群时间线是唯一对用户可见的协作面。"
        "像正常人在微信群里说话：先把该你说的说完；只有确实需要别人接着干新活，才 @。",
        "何时不要 @：",
        "· 打招呼、报到、寒暄、简单回应（「在的」「收到」「回一声」）——直接说，"
        "不要再 @ 同事或小V；也不要借机展开未点名的旧任务或主动给下级派活。",
        "· 别人（含小V）已经 @ 过的人，不要再替用户/管家重复点名催一轮。",
        "· 不要 @ 小V 致谢或回执；小V 看得到群时间线。",
        "· 记忆 / 站立摘要 / 群近期里的旧单不是本轮待办："
        "用户本条没点名同一件事，就不要续跑、不要安排别人去干。",
        "何时才 @：",
        "· 你需要另一个人做他职责内的新工作（改/查/修/交付/接手），"
        "且本轮用户/上级明确要你推进这件事，对方还没被交代过："
        "在正文写「@角色名 + 具体交代」。系统只认正文 @（以及工具 handlers 经前端镜像）。",
        "硬规则：",
        "1. 直接口语回群；不要问「要不要转到这儿」；禁止把群聊当私聊收件箱。",
        "2. 真有派活才 @；没有派活就不要为了「礼貌」或「完整流程」硬 @。",
        "3. 用 tasks / handlers 做实质流转时，同一条回复里仍要 @，群里才看得见；"
        "禁止只报任务号/派单号却不 @。",
        "4. 【称呼】@ 与用户可见正文一律用岗位/角色名。"
        "禁止对用户说 agent_code / 内部编码（如 dev-backend）；工具里可用编码，嘴上必须用人名。",
        "5. 【纯文本】群聊像微信：只输出普通文字。"
        "禁止 Markdown（不要用 # 标题、* / ** 加粗斜体、` 代码、``` 代码块、| 表格、"
        "- / 1. 清单符号装饰）。需要列举时用中文逗号或换行即可。",
        "6. 回合结束前必须交代结果：活已在手边完成的，正文给出结果；"
        "起了后台任务/工作流一时回不来的，正文报任务名并说明完成后系统会自动回执到群，"
        "不要无声结束回合。",
        DEPT_GROUP_IM_CLOSE,
    ]
    return "\n".join(lines)


def resolve_dept_group_im_from_session(
    session_key: str | None,
) -> tuple[bool, str, bool, list[str]]:
    """Return (enabled, dept_name_hint, steward, roster_names) from session context."""
    sk = str(session_key or "").strip()
    if not sk:
        return False, "", False, []
    try:
        from evoflow.persistence.session_repositories import get_session_context_for_run_config

        sess = get_session_context_for_run_config(sk) or {}
    except Exception:
        return False, "", False, []
    if not is_dept_group_im_context(sess):
        return False, "", False, []
    name = str(sess.get("dept_group_name") or sess.get("dept_name") or "").strip()
    steward = is_dept_group_steward_context(sess)
    roster = normalize_dept_group_roster(sess.get("dept_group_roster"))
    return True, name, steward, roster


def strip_dept_group_im_from_prompt(text: str) -> str:
    return _RE_DEPT_GROUP_IM.sub("", str(text or "")).rstrip()


def refresh_dept_group_im_in_prompt(text: str, session_key: str | None) -> str:
    """Replace ``<dept_group_im>`` from live session (survives system-prompt cache hits)."""
    base = strip_dept_group_im_from_prompt(text)
    enabled, name, steward, roster = resolve_dept_group_im_from_session(session_key)
    if not enabled:
        return base
    block = build_dept_group_im_block(
        dept_name=name, steward=steward, roster=roster
    ).strip()
    if not block:
        return base
    return f"{base.rstrip()}\n\n{block}\n"
