"""社媒运营专家包 — 营销增长子智能体。"""

from evoflow.subagents.config import SubagentConfig

_CREW_DISALLOWED = [
    "subagent",
    "task",
    "scenario",
    "plan",
    "supervisor",
    "ask_clarification",
    # tool_search kept allowed so deferred whitelist tools (web_search/find/todo) can be loaded
    "propose_goal",
]

# Lead/preset use needs write + light web research (soul writes outputs/, skills fetch trends).
# Not just read/terminal — that was a subagent-minimal leftover and made the role look broken.
_MARKETING_TOOLS = [
    "read",
    "rg",
    "find",
    "write",
    "replace",
    "delete",
    "terminal",
    "todo",
    "web_search",
    "fetch_url",
]

MARKETING_SOCIAL_MEDIA_OPERATION_CONFIG = SubagentConfig(
    name="marketing-social-media-operation",
    description="""社媒运营：策略规划→多平台文案。
适合：社媒运营、内容营销、涨粉策略、多平台文案；不适合：纯工程开发或与营销无关的任务。""",
    system_prompt="""你是社媒运营专家子智能体，串联仓内已提供的技能完成社交媒体运营工作流。

<已安装技能（以本仓库 skills/public 实际存在为准）>
1. social-media-operator（自媒体运营全能助手）— 运营策略与涨粉规划
2. content-writer（Content Writer）— 多平台自媒体文案生成
</已安装技能>

<工作流>
步骤 1：运营策略与涨粉规划
使用 social-media-operator 完成策略、内容日历与涨粉规划，输出写入 outputs/。

步骤 2：多平台文案生成与优化
使用 content-writer 生成各平台文案，并在同一步完成标题/标签/互动钩子优化，输出写入 outputs/。
</工作流>

<最终交付物>
1. 运营策略方案
2. 多平台内容集
</最终交付物>

<准则>
- 只使用本仓库已安装技能；不要假设已移除的技能仍存在
- 中文输出，除非用户要求其他语言
- 不向用户提问，信息不足时做最小合理假设并说明
- 结束回复中列出所有文件路径与摘要
</准则>""",
    tools=list(_MARKETING_TOOLS),
    disallowed_tools=list(_CREW_DISALLOWED),
    max_turns=500,
    timeout_seconds=1800,
)

# Skill wishlist for the marketing agent
MARKETING_AGENT_SKILL_WISHLIST: tuple[str, ...] = (
    "social-media-operator",
    "content-writer",
)
