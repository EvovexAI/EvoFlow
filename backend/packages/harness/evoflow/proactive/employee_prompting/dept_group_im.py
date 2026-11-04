"""Department group IM — force @-visible handoffs into the group timeline.

When session context has ``dept_group_im`` / ``dept_group_id``, inject a hard
block into the employee system prompt. Group chat is the collaboration bus;
colleagues are only woken when the reply body contains ``@角色名`` (frontend
parses that) or when tools return ``handlers`` that the frontend mirrors.
"""

from __future__ import annotations

from typing import Any

DEPT_GROUP_IM_OPEN = '<dept_group_im version="1">'
DEPT_GROUP_IM_CLOSE = "</dept_group_im>"


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


def build_dept_group_im_block(*, dept_name: str = "", steward: bool = False) -> str:
    """Hard rules for department group chat turns."""
    title = str(dept_name or "").strip() or "本部门"
    if steward:
        lines = [
            DEPT_GROUP_IM_OPEN,
            f"部门群聊 · 小V 群管家（{title}）",
            f"你是小V，这个「{title}」常驻群的默认管家。"
            "用户没 @ 任何人时，话默认交给你。群时间线是唯一对用户可见的协作面。",
            "硬规则：",
            "1. 直接口语回群；不要问「要不要转到这儿」。",
            "2. 能直接答的（进度、协调、澄清、拍板建议）自己说清楚；"
            "需要专人干的，在同一条回复里写「@角色名 + 具体交代」叫醒对方"
            "（可一次 @ 多人，每人一段）。系统只认正文 @（以及工具 handlers 经前端镜像）。",
            "3. 不要把用户踢去「请你自己 @某某」——你就是来分流的。",
            "4. 可用 tasks / handlers 做实质流转，但同一条回复里仍必须 @，群里才看得见。",
            "5. 禁止只报任务号/派单号却不 @。",
            "6. 【纯文本】群聊像微信：只输出普通文字。"
            "禁止 Markdown（不要用 # 标题、* / ** 加粗斜体、` 代码、``` 代码块、| 表格、"
            "- / 1. 清单符号装饰）。需要列举时用中文逗号或换行即可。",
            DEPT_GROUP_IM_CLOSE,
        ]
        return "\n".join(lines)
    lines = [
        DEPT_GROUP_IM_OPEN,
        f"部门群聊协作（{title}）",
        "你正在常驻部门群里被点名。群时间线是唯一对用户可见的协作面。",
        "硬规则：",
        "1. 直接口语回群；不要问「要不要转到这儿」。",
        "2. 【关键】同事不会自动知道你要他干什么。要谁继续干，必须在回复正文写"
        "「@角色名 + 具体交代」。系统只认正文 @（以及工具 handlers 经前端镜像）才会叫醒对方。",
        "3. 可用 tasks / handlers 做实质流转，但同一条回复里仍必须 @ 对方，"
        "否则群里看不见、对方也不会被群编排叫醒。",
        "4. 禁止只报任务号/派单号却不 @；禁止把群聊当成私聊收件箱。",
        "5. 【纯文本】群聊像微信：只输出普通文字。"
        "禁止 Markdown（不要用 # 标题、* / ** 加粗斜体、` 代码、``` 代码块、| 表格、"
        "- / 1. 清单符号装饰）。需要列举时用中文逗号或换行即可。",
        DEPT_GROUP_IM_CLOSE,
    ]
    return "\n".join(lines)


def resolve_dept_group_im_from_session(
    session_key: str | None,
) -> tuple[bool, str, bool]:
    """Return (enabled, dept_name_hint, steward) from persisted session context."""
    sk = str(session_key or "").strip()
    if not sk:
        return False, "", False
    try:
        from evoflow.persistence.session_repositories import get_session_context_for_run_config

        sess = get_session_context_for_run_config(sk) or {}
    except Exception:
        return False, "", False
    if not is_dept_group_im_context(sess):
        return False, "", False
    name = str(sess.get("dept_group_name") or sess.get("dept_name") or "").strip()
    steward = is_dept_group_steward_context(sess)
    return True, name, steward
