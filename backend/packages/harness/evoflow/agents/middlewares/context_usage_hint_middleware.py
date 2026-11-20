"""上下文占用自省：每轮把「你自己用了多少」告诉模型，让它自己判断何时压缩。

【self-evolution-bot · 2026-11-20 · 第94轮 · 模型:deepseek-v4.1-flash-1017】
改了什么：新增本 middleware。
为什么（用户 2026-11-20 第三次追问点破的）：`sessions.compact` 已经支持 agent 自带摘要，
但「什么时候该压」这个判断此前无输入 —— 占用率只经 `emit_context_usage()` 发给前端 UI，
**模型自己看不到**（只写日志）。要它「自我判断」，先把判据送到它眼前。

设计取舍：
- **不常驻**：只在占用 ≥ `_HINT_FROM_PCT`（默认 35%）时注入，低占用时零开销、零噪声。
  压缩后占用掉回阈值下即不再注入。
- **一行、可重复**：正文含具体数字（used/window/pct/消息数），与上一条相同则不重复注入
  （对齐 `collab_phase_middleware` 的去重做法，避免 state 里堆同样文本）。
- **name=`context_usage_hint`**，且已在隐藏注入白名单里（`_SYNTHETIC_USER_NAMES` /
  `message_analysis_utils`），不会被当成真实用户轮、不进 user_requests_store。
"""

from __future__ import annotations

import logging
from typing import Any

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import SystemMessage
from langgraph.runtime import Runtime

logger = logging.getLogger(__name__)

_HINT_NAME = "context_usage_hint"
# 低于这个占用不注入：常态对话不该被一行提示占着，压缩的收益也在低占用时不成立。
_HINT_FROM_PCT = 35.0
# 已注入过的提示，占用变化小于这个幅度就不再重复注入（防每轮堆一条）。
_HINT_REFRESH_PCT = 5.0
# 【self-evolution-bot · 2026-11-20 · 第94轮 · 模型:deepseek-v4.1-flash-1017】
# 高于这个占用时**每轮都重新注入**，不再受 5 点去重约束。
# 为什么：这一段是「再不动手就要被自动压缩接管」的区间，漏一次提示的代价
# （下一轮缓存全量重算 + 摘要由压缩模型代写）远大于重复注入几十 token 的代价。
_HINT_FORCE_PCT = 85.0


def _resolve_self_compact(runtime: Runtime) -> tuple[bool, str]:
    """本岗位**能不能**自己调 `sessions.compact`（挂载闸 + scope 闸都得过）。

    【self-evolution-bot · 2026-11-20 · 第96轮 · 模型:deepseek-v4.1-flash-1017】
    改了什么：新增本判据，提示文案按它分两套。
    为什么（本轮实测点破）：`platform` 工具对员工是 **opt-in**（`tools[]` 勾选或
    `kb_injection.mount_platform_tools`），现网 57 个岗位里只有约 10 个挂了它
    （`tech-director` / `release-engineer` 都没挂）。而这段提示此前**无条件**写
    「调用 platform(action="sessions.compact"…)」—— 对剩下那批岗位等于把模型指向
    一个自己工具箱里不存在的工具，照着做只会拿到「未知工具」，白烧一轮。
    返回 (可否自助压缩, 否定原因)；原因只进日志，不投给模型。
    """
    ctx = getattr(runtime, "context", None)
    if not hasattr(ctx, "get"):
        ctx = {}
    code = (
        str(
            ctx.get("agent_id")
            or ctx.get("agent_name")
            or ctx.get("proactive_agent_code")
            or ""
        ).strip()
        or None
    )
    # 身份unknown（main / 小V 这类没有 agent 码的）保持老行为：它们本来就恒挂 platform，
    # 判不出来就按「可用」处理，避免把主链路的能力提示误降级。
    if not code:
        return True, ""
    try:
        from evoflow.config.agents_config import get_agent_kb_injection_config, load_agent_config
        from evoflow.tools.tool_catalog import should_mount_platform_tool

        cfg = load_agent_config(code)
        tools = list(cfg.tools) if (cfg is not None and cfg.tools is not None) else None
        kb = get_agent_kb_injection_config(code)
        if not should_mount_platform_tool(
            code,
            mount_platform_tools=bool(kb.mount_platform_tools),
            tools_whitelist=tools,
        ):
            return False, "platform_not_mounted"
        from evoflow.config.platform_scope import action_allowed, resolve_agent_platform_scope

        ok, reason = action_allowed(
            resolve_agent_platform_scope(code), "sessions.compact", "write"
        )
        if not ok:
            return False, str(reason or "scope_denied")
        return True, ""
    except Exception:  # pragma: no cover - 判据失败不该拦住提示
        logger.debug("self-compact capability probe failed", exc_info=True)
        return True, ""


def _parse_pct(content: Any) -> float | None:
    """从既有提示正文里取回占用百分比，用于判「够不够值得再注入一次」。"""
    text = content if isinstance(content, str) else str(content or "")
    marker = "（"
    idx = text.find(marker)
    if idx < 0:
        return None
    seg = text[idx + len(marker) : text.find("%", idx)]
    try:
        return float(seg.strip())
    except (TypeError, ValueError):
        return None


def _build_hint_text(
    *,
    used: int,
    window: int,
    pct: float,
    msg_count: int,
    can_self_compact: bool = True,
) -> str:
    """按占用率分档给出**显式判据**。

    【self-evolution-bot · 2026-11-20 · 第94轮 · 模型:deepseek-v4.1-flash-1017】
    改了什么：原来只有一句「如果这轮收尾了可以考虑压缩」，没有量化判据，也没有
    说明「不自己写会怎样」——模型很容易一路推到 90% 交给自动压缩。
    为什么（用户点破）：「要不然可能很长很长都不会触发」。模型不是不想压，是**没有
    阈值可对照**。这里补三档 + 一条真实后果（≥90% 系统会用压缩模型代写，质量不如你）。

    【第96轮 · 模型:deepseek-v4.1-flash-1017】补 `can_self_compact`：
    本岗位没挂 `platform` 工具 / scope 不放开 write 时，**不能**写「去调 platform」，
    那是指向不存在的工具。改为告诉它「你压不了，系统会在 90% 接管」+ 它当场能做的一件事
    （收尾时把要留的东西落盘），别让它去试一个调不到的动作。
    """
    if pct >= 85:
        tier = (
            "**该压了**：已过 85%。请在本轮结束时立刻压缩——"
            "再往上会触发系统自动压缩，那时由**另一个压缩模型**代写摘要，"
            "它看不到你手上的细节，质量一定不如你自己写。"
        )
    elif pct >= 60:
        tier = (
            "**建议压**：已过 60%。若手上这一段落已收尾（结论已出、门禁已过、无未完成动作），"
            "就趁这一轮压缩，别等 90% 被自动压缩接管。"
        )
    else:
        tier = (
            "**可以压但不急**：35%~60% 属可选区间。只在「一个完整任务段刚收尾、"
            "接下来要开新话题」时压；正在做的事没做完就先别动它。"
        )
    if not can_self_compact:
        return (
            f"<context_usage>\n"
            f"当前对话上下文占用 {used}/{window} tokens（{pct:.1f}%），消息 {msg_count} 条。\n"
            f"{tier}\n"
            f"但**你这一岗没有压缩入口**（工具箱未挂 `platform`，或平台能力清单不含 write），"
            f"调不到 `sessions.compact`——别去试，试了只会拿到「未知工具」。\n"
            f"系统会在 90% 自动压缩：那时由压缩模型代写摘要，且只保留「摘要 + 最近几条」。\n"
            f"所以你当场能做的只有一件事：**把后面还要用的东西写进文件/任务产出**"
            f"（改到哪、下一步、用户定过的约束、还没答的问题），别只留在上下文里。\n"
            f"</context_usage>"
        )
    return (
        f"<context_usage>\n"
        f"当前对话上下文占用 {used}/{window} tokens（{pct:.1f}%），消息 {msg_count} 条。\n"
        f"{tier}\n"
        f"压缩就是把历史折叠成**你亲手写的摘要**，之后你只带着摘要+最近几条继续干活：\n"
        f'platform(action="sessions.compact", args_json={{"summary": "<你的结构化摘要>"}}, confirm=true)\n'
        f"摘要按这些章节写：目标 / 进展（已完成·进行中·受阻）/ 关键决策 / 已解决问题 / "
        f"待处理请求 / 相关文件 / 剩余工作 / 关键上下文。\n"
        f"写的时候专挑「下一轮我还会用到、但读不到」的东西：改过的文件路径、跑过的门禁结果、"
        f"用户明确要求的约束、还没答完的问题。别复述已经完成的细节。\n"
        f"注意：压缩会让下一轮走新上下文（缓存重算），只在**任务段收尾**时做一次，不要连续压。\n"
        f"</context_usage>"
    )


class ContextUsageHintMiddleware(AgentMiddleware[AgentState]):
    """把上下文占用送到模型眼前，让它自己决定是否 `sessions.compact`。"""

    state_schema = AgentState

    def before_model(
        self,
        state: AgentState,
        runtime: Runtime,  # noqa: ARG002
    ) -> dict[str, Any] | None:
        try:
            return self._maybe_hint(state, runtime)
        except Exception:  # pragma: no cover - 提示注入永不该阻断主流程
            logger.debug("context usage hint failed", exc_info=True)
            return None

    async def abefore_model(
        self,
        state: AgentState,
        runtime: Runtime,  # noqa: ARG002
    ) -> dict[str, Any] | None:
        try:
            return self._maybe_hint(state, runtime)
        except Exception:  # pragma: no cover
            logger.debug("context usage hint failed", exc_info=True)
            return None

    def _maybe_hint(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        from evoflow.agents.context_compaction_core import compaction_token_snapshot
        from evoflow.agents.middlewares.context_compaction_middleware import (
            _model_name_from_runtime,
            _session_key_from_runtime,
            _thread_id_from_runtime,
        )
        from evoflow.utils.model_context_length import resolve_model_context_length

        raw = state.get("messages") if isinstance(state, dict) else getattr(state, "messages", None)
        messages = list(raw or [])
        if not messages:
            return None

        model_name = _model_name_from_runtime(runtime)
        window = resolve_model_context_length(model_name)
        snap = compaction_token_snapshot(messages, context_length=window)
        used = int(snap["gate_tokens"])
        pct = float(snap["pct_of_context"])
        if pct < _HINT_FROM_PCT:
            return None

        # 【第96轮】先判本岗位有没有压缩入口，再决定写哪套文案。
        can_self_compact = _resolve_self_compact(runtime)[0]
        text = _build_hint_text(
            used=used,
            window=int(window),
            pct=pct,
            msg_count=int(snap["message_count"]),
            # 【第96轮】本岗位没有压缩入口时不写「去调 platform」——见 _resolve_self_compact。
            can_self_compact=can_self_compact,
        )
        # 去重：只有**占用实质变化**才重新注入，避免每轮因消息数/message_count
        # 微变就堆一条新提示进 state（那是纯噪声，也吃 token）。
        # 判据用「百分比跨过 5 个点」而不是逐字比文本——第一版逐字比我踩过：
        # message_count 每轮都变，导致文本永远不同、去重永远失效。
        # 【self-evolution-bot · 2026-11-20 · 第94轮 · 模型:deepseek-v4.1-flash-1017】
        # 改了什么：≥`_HINT_FORCE_PCT`(85%) 时跳过 5 点去重，每轮都注入。
        # 为什么：一轮里可能连续跑十几个工具、占用从 40% 冲到 90%，中间只经过一次
        #   before_model；若上一次提示是 40% 写的、这次 88%，差值 48 点本来也会重注，
        #   但若上次恰好在 84%、这次 88%（差 4 点），5 点闸会把**最该压的那一刻**吞掉。
        #   高占用区去重的收益（省几十 token）远小于漏一次压缩的代价（下轮全量重算）。
        for m in reversed(messages):
            if isinstance(m, SystemMessage) and getattr(m, "name", None) == _HINT_NAME:
                prev_pct = _parse_pct(getattr(m, "content", None))
                if (
                    prev_pct is not None
                    and abs(prev_pct - pct) < _HINT_REFRESH_PCT
                    and pct < _HINT_FORCE_PCT
                ):
                    return None
                break

        logger.info(
            "[context-usage-hint] inject session=%s pct=%.1f used=%d window=%d",
            str(_session_key_from_runtime(runtime) or "")[:24],
            pct,
            used,
            int(window),
        )
        _ = _thread_id_from_runtime(runtime)
        return {"messages": [SystemMessage(name=_HINT_NAME, content=text)]}
