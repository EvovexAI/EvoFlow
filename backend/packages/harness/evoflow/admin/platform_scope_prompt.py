"""``<capability_profile>`` 系统提示词段 —— 让模型调用平台工具**前**就知道能力边界.

与 ``docs/design/agent-employee-capability-manifest.md`` §4 对齐：

- 正向能力（按域分组 + confirm 标注）+ **显式负向清单**（不可用域）+ 越界替代路径；
- ``mode="all"`` 输出短版（避免 180 行膨胀）；``mode="none"`` 输出禁用声明；
- 超长降级梯子：动作明细 → 域级计数 → 仅头行。

装配点：``agents/lead_agent/prompt.py`` 在系统提示词尾部追加（员工会话与通用
模板共用）；指纹接入 ``DynamicSystemPromptOnScenarioMiddleware``（scope 变更即重渲染）。
"""

from __future__ import annotations

import logging
from typing import Any

from evoflow.config.platform_scope import PlatformScope, allowed_action_names

logger = logging.getLogger(__name__)

# 段落字符预算（中文按字符计）；超限逐级降级。
_CAPABILITY_SECTION_MAX_CHARS = 1200

_ZH = {
    "header_all": "平台能力（platform 工具）：全部 {dom_count} 个域可用，风险上限 {risk}。",
    "header_custom": "平台能力（platform 工具）：已授权 {dom_count} 个域、共 {action_count} 个动作，风险上限 {risk}。",
    "confirm_note": "写操作先预览（pending_confirm），用户确认后带 confirm=true 再执行。",
    "ceiling_note": "高于上限（{risk}）的动作已被岗位配置禁用，不要尝试。",
    "negative": "明确不可用（不要尝试，也不要引导用户在面板里找）：{domains}。",
    "fallback": "用户请求超出上述范围时：直接说明「我没有该平台权限」，建议用户在岗位设置中追加能力域，或转交主 Agent。",
    "none_block": "平台动作（platform 工具）当前对本岗位禁用：任何 domain.* 调用都会被拒绝（capability_denied）。不要尝试调用；用户需要平台能力时，请说明并由用户在岗位设置中调整。",
    "degraded_counts": "…（动作明细过长，已降级为域级计数；详单可调用 action=catalog）",
}

_EN = {
    "header_all": "Platform capability (platform tool): all {dom_count} domains available, risk ceiling {risk}.",
    "header_custom": "Platform capability (platform tool): {dom_count} domains / {action_count} actions authorized, risk ceiling {risk}.",
    "confirm_note": "Writes preview first (pending_confirm); re-call with confirm=true after the user agrees.",
    "ceiling_note": "Actions above the {risk} ceiling are disabled for this role; do not attempt them.",
    "negative": "Explicitly unavailable (do not attempt, do not send users looking for them): {domains}.",
    "fallback": "If a request exceeds this scope: say you lack that platform permission, suggest adjusting the role's capability scope, or hand off to the lead agent.",
    "none_block": "Platform actions (platform tool) are disabled for this role: every domain.* call is rejected (capability_denied). Do not attempt; tell the user to adjust the role capability settings if needed.",
    "degraded_counts": "… (action lists degraded to per-domain counts; call action=catalog for details)",
}


def _risk_ceiling_zh(risk: str) -> str:
    return {"read": "只读", "write": "可写", "destructive": "含破坏性"}.get(risk, risk)


def _risk_ceiling_en(risk: str) -> str:
    return {"read": "read-only", "write": "write", "destructive": "destructive"}.get(risk, risk)


def build_capability_profile_text(
    scope: PlatformScope,
    *,
    platform_mounted: bool = True,
    prompt_language: str = "zh",
    max_chars: int = _CAPABILITY_SECTION_MAX_CHARS,
) -> str:
    """构建 ``<capability_profile>`` 段文本（不含换行包裹的标签外壳）。

    ``scope`` 为 None 时由调用方短路（返回空串、整段省略 —— 存量行为不变）。
    """
    if scope is None:
        return ""
    lang = "en" if str(prompt_language or "").strip().lower().startswith("en") else "zh"
    t = _EN if lang == "en" else _ZH
    ceiling = _risk_ceiling_en(scope.max_risk) if lang == "en" else _risk_ceiling_zh(scope.max_risk)

    if scope.mode == "none":
        return t["none_block"]

    if scope.mode == "all":
        dom_count = _registry_domain_count()
        body = t["header_all"].format(dom_count=dom_count, risk=ceiling)
        body += "\n" + t["confirm_note"]
        return body

    # mode == "custom"
    from evoflow.admin.platform_actions import PLATFORM_DOMAINS, get_registry

    allowed = set(allowed_action_names(scope, get_registry().values()))
    by_domain: dict[str, list[str]] = {}
    confirm_by_name: dict[str, bool] = {}
    for entry in get_registry().values():
        if entry.name in allowed:
            by_domain.setdefault(entry.domain, []).append(entry.name)
            confirm_by_name[entry.name] = entry.risk in {"write", "destructive"}
    allowed_domains = sorted({str(d).strip().lower() for d in scope.domains} | set(by_domain.keys()))
    negative_domains = [d for d in PLATFORM_DOMAINS if d not in allowed_domains]
    action_count = sum(len(v) for v in by_domain.values())

    header = t["header_custom"].format(dom_count=len(allowed_domains), action_count=action_count, risk=ceiling)
    lines = [header]
    for dom in allowed_domains:
        names = sorted(by_domain.get(dom, []))
        if names:
            rendered = "、".join(
                f"{n}(confirm=true)" if confirm_by_name.get(n) else n for n in names
            )
            lines.append(f"- {dom}.*（{len(names)}）：{rendered}")
        else:
            lines.append(f"- {dom}.*：0（暂无已授权动作）")
    if negative_domains:
        lines.append(t["negative"].format(domains="、".join(f"{d}.*" for d in negative_domains)))
    lines.append(t["confirm_note"] if scope.max_risk in {"write", "destructive"} else t["ceiling_note"].format(risk=ceiling))
    lines.append(t["fallback"])
    text = "\n".join(lines)
    if len(text) <= max_chars:
        return text

    # 降级一级：域级计数（丢动作明细，保留负向清单与替代路径）。
    lines2 = [header]
    for dom in allowed_domains:
        lines2.append(f"- {dom}.*（{len(by_domain.get(dom, []))}）")
    if negative_domains:
        lines2.append(t["negative"].format(domains="、".join(f"{d}.*" for d in negative_domains)))
    lines2.append(t["confirm_note"] if scope.max_risk in {"write", "destructive"} else t["ceiling_note"].format(risk=ceiling))
    lines2.append(t["fallback"])
    text = "\n".join(lines2) + "\n" + t["degraded_counts"]
    if len(text) <= max_chars:
        return text

    # 降级二级：仅头行 + 负向域。
    text = header + "\n" + t["negative"].format(domains="、".join(f"{d}.*" for d in negative_domains))
    return text[:max_chars]


def _registry_domain_count() -> int:
    try:
        from evoflow.admin.platform_actions import PLATFORM_DOMAINS

        return len(PLATFORM_DOMAINS)
    except Exception:  # pragma: no cover - registry import should never fail here
        return 0


def build_capability_profile_section(
    agent_code: str | None,
    *,
    loaded_tool_names: list[str] | None = None,
    prompt_language: str = "zh",
) -> str:
    """prompt.py 装配入口：解析员工 scope → 段文本（含 ``<capability_profile>`` 外壳）。

    短路条件（任一成立返回空串，存量行为零变化）：

    - ``platform`` 工具未挂载（scope 配了也调不到，列了反而误导）；
    - 员工未配置 scope（None = 存量不设限，靠静态工具描述 + catalog 自探索）。
    """
    from evoflow.config.platform_scope import resolve_agent_platform_scope

    tools = {str(x).strip().lower() for x in (loaded_tool_names or [])}
    if "platform" not in tools:
        return ""
    scope = resolve_agent_platform_scope(agent_code)
    if scope is None:
        return ""
    try:
        text = build_capability_profile_text(scope, platform_mounted=True, prompt_language=prompt_language)
    except Exception:
        logger.debug("capability profile build failed agent=%s", agent_code, exc_info=True)
        return ""
    text = str(text or "").strip()
    if not text:
        return ""
    return f"<capability_profile>\n{text}\n</capability_profile>"
