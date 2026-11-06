"""员工平台动作能力清单（platform scope）.

数据来源：``AgentConfig.platform_scope``（持久化在 ``evoflow_agents.extra_json``，
见 ``persistence/row_mappers.py`` —— 非列字段走 extra_json 往返，无需迁移）。

语义（与 ``docs/design/agent-employee-capability-manifest.md`` 对齐）：

- ``None``（字段缺省 / 存量岗位）：**不设限** —— 与历史行为完全一致（platform
  挂载即全量，仅受动作自身 risk + confirm 闸门约束）。不要给存量岗位默认套
  max_risk 上限，否则 destructive 动作会突然被拒。
- ``mode="all"``：显式选择全量，但受 ``max_risk`` 上限约束（UI 明确保存后生效）。
- ``mode="none"``：platform 即便挂载，任何动作都拒绝（"先挂载观察、暂不放权"）。
- ``mode="custom"``：``domains`` ∪ ``actions``（裸名放行、``-`` 前缀在域放行内扣除），
  再受 ``max_risk`` 上限过滤。

强制点（三层同源）：

- ``admin/platform_actions.dispatch_platform_action``：``capability_denied`` 闸门（越界自纠兜底）
- catalog：按调用员工过滤（探索面即能力面）
- 系统提示词 ``<capability_profile>``：调用前告知（``admin/platform_scope_prompt.py``）
"""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Any, Iterable, Literal

from pydantic import BaseModel, Field, model_validator

if TYPE_CHECKING:  # pragma: no cover - typing only
    from evoflow.config.agents_config import AgentConfig

logger = logging.getLogger(__name__)

# 风险等级序：上限 risk 严格高于动作 risk 时拒绝。
RISK_ORDER: dict[str, int] = {"read": 0, "write": 1, "destructive": 2}


class PlatformScope(BaseModel):
    """员工可用的平台动作范围（创建/编辑岗位时配置；``None`` = 存量不设限）。"""

    mode: Literal["all", "none", "custom"] = "all"
    domains: list[str] = Field(default_factory=list)
    # 裸名（"media.generate_video"）= 放行；"-domain.op" = 在域放行内扣除。
    actions: list[str] = Field(default_factory=list)
    # 风险上限：高于上限的动作一律拒绝（destructive 上限=全部放行）。
    max_risk: Literal["read", "write", "destructive"] = "write"

    @model_validator(mode="after")
    def _normalize(self) -> "PlatformScope":
        self.mode = (str(self.mode) or "all").strip().lower()  # type: ignore[assignment]
        self.domains = sorted({str(d).strip().lower() for d in (self.domains or []) if str(d).strip()})
        norm_actions: list[str] = []
        for raw in self.actions or []:
            name = str(raw).strip().lower()
            if name:
                norm_actions.append(name)
        self.actions = sorted(set(norm_actions))
        if self.max_risk not in RISK_ORDER:  # type: ignore[unreachable]
            self.max_risk = "write"  # type: ignore[unreachable]
        return self

    def model_dump_canonical(self) -> dict[str, Any]:
        """稳定序列化（fingerprint / extra_json 存储）。"""
        return {
            "mode": self.mode,
            "domains": list(self.domains),
            "actions": list(self.actions),
            "max_risk": self.max_risk,
        }


def parse_action_grants(actions: Iterable[str] | None) -> tuple[set[str], set[str]]:
    """拆 ``actions`` 条目 → (显式放行集, 显式扣除集)；``-x`` 条目归扣除集。"""
    allow: set[str] = set()
    deny: set[str] = set()
    for raw in actions or []:
        name = str(raw or "").strip().lower()
        if not name:
            continue
        if name.startswith("-"):
            neg = name.lstrip("-").strip()
            if neg:
                deny.add(neg)
            # "-" / "--" 之类空扣除项忽略
        else:
            allow.add(name)
    return allow, deny


def action_allowed(scope: PlatformScope | None, action: str, risk: str) -> tuple[bool, str | None]:
    """纯判定：是否允许员工 ``scope`` 调用平台动作 ``action``（risk 等级 ``risk``）。

    Returns:
        (allowed, deny_reason)。reason ∈ {``risk_exceeds_ceiling``, ``scope_none``,
        ``action_denied``, ``not_in_scope``}；allowed=True 时 reason 为 None。
        ``scope is None`` = 存量不设限，恒放行（confirm 闸门另行兜底）。
    """
    if scope is None:
        return True, None
    name = str(action or "").strip().lower()
    risk_n = str(risk or "read").strip().lower()
    if RISK_ORDER.get(risk_n, 0) > RISK_ORDER.get(scope.max_risk, 1):
        return False, "risk_exceeds_ceiling"
    if scope.mode == "none":
        return False, "scope_none"
    if scope.mode == "custom":
        allow, deny = parse_action_grants(scope.actions)
        if name in deny:
            return False, "action_denied"
        if name in allow:
            return True, None
        domain = name.split(".", 1)[0]
        if domain and domain in {d.lower() for d in scope.domains}:
            return True, None
        return False, "not_in_scope"
    # mode == "all"：仅受 max_risk 上限（已在上方判定）。
    return True, None


def allowed_action_names(scope: PlatformScope | None, registry_values: Iterable[Any]) -> list[str]:
    """按 scope 过滤注册表动作名（元素只需有 ``.name`` / ``.risk`` 属性）。

    ``scope is None`` 或 mode="all"（无上限差异）时返回 ``[]`` 表示"不过滤"——
    调用方以空列表为哨兵跳过过滤，避免 180 项全量拷贝。
    """
    if scope is None or scope.mode == "all":
        return []
    return [
        getattr(entry, "name", "")
        for entry in registry_values
        if action_allowed(scope, getattr(entry, "name", ""), getattr(entry, "risk", "read"))[0]
    ]


def resolve_agent_platform_scope(agent_code: str | None) -> PlatformScope | None:
    """解析员工 platform scope；查不到 / 未配置返回 ``None``（不设限）。

    走 ``load_agent_config`` 的 10s TTL 缓存；员工代码为空（main / 小V / 人工
    principal / HTTP admin 面）时恒为 ``None``。
    """
    code = str(agent_code or "").strip().lower()
    # 与 platform_tool._bind_runtime_identity 的特权清理集对齐：
    # main / 编排 / 自动 / 人工身份不套员工 scope（它们另有 mount 策略）。
    if not code or code in {"main", "lead_agent", "auto", "user"}:
        return None
    try:
        from evoflow.config.agents_config import load_agent_config

        cfg: AgentConfig | None = load_agent_config(code)
    except FileNotFoundError:
        return None
    except Exception:
        logger.debug("resolve platform scope failed agent=%s", code, exc_info=True)
        return None
    if cfg is None:
        return None
    return getattr(cfg, "platform_scope", None)


def platform_scope_fingerprint(agent_code: str | None) -> str:
    """scope 变更指纹（空串 = 未配置）。供动态系统提示词 / graph cache 失效用。"""
    scope = resolve_agent_platform_scope(agent_code)
    if scope is None:
        return ""
    try:
        return json.dumps(scope.model_dump_canonical(), sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    except Exception:
        return ""
