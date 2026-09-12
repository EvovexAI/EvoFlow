"""EvoFlow 目标 Agent：由模型生成一套可编辑参数，用户在客户端确认后再启动。"""

from __future__ import annotations

from langchain.tools import tool

propose_goal_ui_metadata = {
    "group": "builtin",
    "label": "目标方案",
    "icon": "🎯",
}


@tool("propose_goal", parse_docstring=True)
def propose_goal_tool(
    goal: str,
    feishu_push_on_complete: bool | None = None,
    step_delay_ms: int = 1500,
    retry_limit: int = 2,
    use_evolution_skill: bool = False,
) -> str:
    """向 EvoFlow 提交一套「目标 Agent」运行参数，供用户在对话区确认后写入目标面板。

    调用后 EvoFlow 会在输入框上方展示摘要卡片；用户可「仅填入」或「填入并开始目标」。
    不要在正文中重复粘贴完整 JSON；简要说明意图即可。

    Args:
        goal: 目标任务描述（给调度模型看的自然语言说明，1–4000 字为宜）。
        feishu_push_on_complete: 是否在目标自动结束时推送飞书；None 表示交给客户端按网关是否已配置默认会话决定。
        step_delay_ms: 每轮调度间隔毫秒，默认 1500，不宜低于 200。
        retry_limit: 连续失败后重试次数上限，默认 2。
        use_evolution_skill: 是否在目标系统提示中启用「持续进化」相关策略。

    Returns:
        简短中文说明 + 参数摘要，便于模型在正文中收束。
    """
    g = (goal or "").strip()
    if not g:
        return "错误：goal 不能为空。请根据用户意图填写目标任务描述后再调用 propose_goal。"
    if len(g) > 4000:
        g = g[:4000] + "…"

    sdm = max(200, min(120_000, int(step_delay_ms) if step_delay_ms is not None else 1500))
    rl = max(0, min(20, int(retry_limit) if retry_limit is not None else 2))

    feishu_note = "由客户端按飞书默认可用性决定" if feishu_push_on_complete is None else ("开启" if feishu_push_on_complete else "关闭")

    lines = [
        "已在 EvoFlow 生成目标方案卡片，请用户在对话区确认后可写入目标面板并启动。",
        "",
        "**参数摘要**",
        f"- 任务目标：{g[:240]}{'…' if len(g) > 240 else ''}",
        f"- 飞书结束推送：{feishu_note}",
        f"- 轮间隔：{sdm} ms，失败重试上限：{rl}",
        f"- 持续进化技能：{'是' if use_evolution_skill else '否'}",
    ]
    return "\n".join(lines)
