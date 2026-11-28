"""Department group IM — force @-visible handoffs into the group timeline.

When session context has ``dept_group_im`` / ``dept_group_id``, inject a hard
block into the employee system prompt. Group chat is the collaboration bus;
colleagues are only woken when the reply body contains ``@角色名`` (frontend
parses that) or when tools return ``handlers`` that the frontend mirrors.

Background ``employees.dispatch`` / wake wakes private duty sessions — those
replies never land on the group timeline. Steward rules therefore require
``@角色名`` for any “speak / welcome / reply in-group” ask; dispatch alone
is not a substitute.

Static facts (dept name, steward role, roster, hard rules) live here in the
system prompt. Per-turn group timeline snippets stay on the user message —
they change every send and must not fight the cached system prompt.
"""

from __future__ import annotations

import re
from typing import Any

DEPT_GROUP_IM_OPEN = "<dept_group_im>"
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
            f"你是小V，当前在「{title}」群里以管家身份接话"
            "（你只出现在自己所属部门的群，不会进每个部门群）。"
            "通常无人 @ 时由部门负责人先接；本轮话交给你时，先接住再判断要不要 @ 专人。"
            "群时间线是唯一对用户可见的协作面。",
            f"你清楚：当前是群聊、对象是「{title}」、群里有谁、事情推进到哪"
            "（看本轮用户消息里的 <dept_group_recent>，若有；"
            "真正要执行的用户话在 <dept_group_instruction>）。"
            "像聪明的微信群管家：先接住、再判断——该自己答就答，只有真要专人干活才 @。",
        ]
        if roster_line:
            lines.append(f"本群可点名：{roster_line}")
        else:
            lines.append("本群可点名：（花名册暂空，仍可先回用户再想办法）")
        lines.extend(
            [
                "何时 @（自主判断，宁缺毋滥）：",
                "· 用户要某人出面说话/表态/写欢迎词/在群里接话，或你答不了、必须专人接手时："
                "在同一条回复写「@角色名 + 具体交代」（可一次 @ 多人，每人一段）。"
                "系统只认正文 @（以及工具 handlers 经前端镜像）——只有这样群时间线才会叫醒对方、"
                "对方的回复才会出现在本群。",
                "· 打招呼、问好、寒暄、你能直接说清的进度/协调/澄清：自己回完即可，不要 @。",
                "· 已经 @ 过的人不要再重复点名催一轮；不要让用户自己去 @。",
                "硬规则：",
                "1. 直接口语回群；不要问「要不要转到这儿」。",
                "2. 【同群说话走群聊会话】"
                "对本群花名册里的人交代活/追问：优先正文「@岗位名 + 具体交代」。"
                "若用 employees.chat_send，系统会钉到对方「本部门群聊 sticky」"
                "（proactive:…:chat:dept-…），回复会回群时间线；"
                "禁止落到对方 1:1 私聊或另开无关 chat。"
                "禁止对这些人用 employees.dispatch / employees.wake 开私有值班轮次代替群聊。"
                "工具层会对同群成员的 dispatch/wake 拒绝。",
                "3. 改配置、跑工作流、建台账等不针对同群某人开口的后台活仍可用 platform / tasks；"
                "但若同时还要同群某人开工，同一条回复里仍应 @（或 chat_send 进群 sticky），"
                "不要只报任务号/queued 回执就当群内对话完成。",
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
        "本轮用户消息用标签分层：<dept_group_recent> 是群近期（背景），"
        "<dept_group_instruction> 才是本条要你回应的话；"
        "<dept_group_hint> 是行为约束，对用户不可见。"
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
        "在正文写「@角色名 + 具体交代」。系统只认正文 @（以及工具 handlers 经前端镜像）。"
        "同群派活优先正文 @；若用 employees.chat_send，必须走本部门群聊 sticky，"
        "不要再 dispatch/wake 开私有值班轮。",
        "硬规则：",
        "1. 直接口语回群；不要问「要不要转到这儿」；禁止把群聊当私聊收件箱。",
        "2. 真有派活才 @；没有派活就不要为了「礼貌」或「完整流程」硬 @。",
        "3. 【同群说话走群聊会话】"
        "对本群同事交代活/追问：优先正文 @；"
        "employees.chat_send 可以，但系统会钉到对方群聊 sticky（回复回群），"
        "禁止落到 1:1 私聊。"
        "禁止再用 employees.dispatch / wake 私发值班轮代替群聊"
        "（工具会拒绝对同群成员的 dispatch/wake）。"
        "用 tasks / handlers 做实质流转时，同一条回复里仍要 @；"
        "禁止只报任务号/派单号/queued 回执却不 @。",
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


def _target_is_dept_group_mate(
    *,
    dept_name: str,
    roster: list[str],
    target_agent_code: str,
    target_role_name: str = "",
) -> tuple[bool, str]:
    """Return (is_mate, display_name)."""
    code = str(target_agent_code or "").strip()
    role_name = str(target_role_name or "").strip()
    if not code:
        return False, ""
    roster_cf = {str(r).strip().casefold() for r in roster if str(r).strip()}
    on_roster = bool(
        (role_name and role_name.casefold() in roster_cf)
        or (code.casefold() in roster_cf)
    )
    if not on_roster:
        try:
            from evoflow.persistence.db import get_db

            row = get_db().execute(
                "SELECT department, role_name FROM evoflow_proactive_roles WHERE agent_code = ?",
                (code,),
            ).fetchone()
            target_dept = str((row["department"] if row else "") or "").strip()
            hint = str(dept_name or "").strip()
            if target_dept and hint and target_dept == hint:
                on_roster = True
                if not role_name:
                    role_name = str((row["role_name"] if row else "") or code).strip()
        except Exception:
            on_roster = False
    return on_roster, (role_name or code)


def resolve_dept_group_chat_route(
    *,
    caller_session_key: str,
    target_agent_code: str,
    target_role_name: str = "",
) -> dict[str, Any] | None:
    """群聊回合里对同群成员 chat_send：应钉到的群 sticky 路由。

    返回 None = 不是群聊语境 / 不是同群成员 → 走普通 1:1 选会话。
    """
    sk = str(caller_session_key or "").strip()
    code = str(target_agent_code or "").strip()
    if not sk or not code:
        return None
    enabled, dept_name, _steward, roster = resolve_dept_group_im_from_session(sk)
    if not enabled:
        return None
    # 从调用方会话再取 dept_id（花名册解析只带了 name）
    dept_id = ""
    try:
        from evoflow.persistence.session_repositories import get_session_context_for_run_config

        sess = get_session_context_for_run_config(sk) or {}
        dept_id = str(sess.get("dept_group_id") or "").strip()
    except Exception:
        dept_id = ""
    if not dept_id:
        return None
    is_mate, who = _target_is_dept_group_mate(
        dept_name=dept_name,
        roster=roster,
        target_agent_code=code,
        target_role_name=target_role_name,
    )
    if not is_mate:
        return None
    sticky = f"proactive:{code}:chat:dept-{dept_id}"
    timeline = f"dept:{dept_id}:chat"
    return {
        "sticky_session_key": sticky,
        "timeline_session_key": timeline,
        "dept_id": dept_id,
        "dept_name": dept_name,
        "roster": list(roster),
        "target_role_name": who,
        "target_agent_code": code,
    }


def ensure_dept_group_sticky_context(route: dict[str, Any]) -> None:
    """给目标群 sticky 打上 dept_group_*，保证回复能镜像回群时间线。"""
    if not isinstance(route, dict):
        return
    sticky = str(route.get("sticky_session_key") or "").strip()
    dept_id = str(route.get("dept_id") or "").strip()
    if not sticky or not dept_id:
        return
    code = str(route.get("target_agent_code") or "").strip()
    who = str(route.get("target_role_name") or code).strip()
    dept_name = str(route.get("dept_name") or "").strip()
    timeline = str(route.get("timeline_session_key") or f"dept:{dept_id}:chat").strip()
    roster = route.get("roster") if isinstance(route.get("roster"), list) else []
    try:
        from evoflow.persistence.session_repositories import upsert_session_row

        upsert_session_row(
            sticky,
            title=f"{dept_name or '部门'} · {who}" if who else None,
            context={
                "source": "proactive",
                "proactive_agent_code": code,
                "agent_id": code,
                "agent_name": who,
                "employee_talk_mode": "chat",
                "workspace_kind": "chat",
                "dept_group_id": dept_id,
                "dept_group_name": dept_name,
                "dept_group_im": True,
                "dept_group_timeline_session": timeline,
                "dept_group_steward": False,
                "dept_group_roster": roster,
            },
            updated_at_ms=0,
        )
    except Exception:
        # best-effort：钉会话失败时仍让 chat_send 用 sticky key，镜像可能稍晚由前端补上下文
        return


def reject_dept_group_private_ping(
    *,
    caller_session_key: str,
    target_agent_code: str,
    target_role_name: str = "",
) -> str | None:
    """群聊回合里对同群成员 dispatch/wake 私发值班轮时返回拒因，否则 None。

    chat_send 不走这里——应改钉到群 sticky（见 ``resolve_dept_group_chat_route``）。
    """
    sk = str(caller_session_key or "").strip()
    code = str(target_agent_code or "").strip()
    if not sk or not code:
        return None
    enabled, dept_name, _steward, roster = resolve_dept_group_im_from_session(sk)
    if not enabled:
        return None
    is_mate, who = _target_is_dept_group_mate(
        dept_name=dept_name,
        roster=roster,
        target_agent_code=code,
        target_role_name=target_role_name,
    )
    if not is_mate:
        return None
    return (
        f"部门群聊内给「{who}」派活请正文 @岗位名，"
        "或用 employees.chat_send（会进群聊会话）；"
        "不要用 employees.dispatch / wake 开私有值班轮"
        "（私有岗本群看不见对方回复）。"
    )


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
