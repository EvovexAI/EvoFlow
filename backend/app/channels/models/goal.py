import time
import uuid
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field


class GoalStatus(StrEnum):
    """托管运行状态"""

    IDLE = "idle"
    RUNNING = "running"
    WAITING = "waiting"
    PAUSED = "paused"
    ERROR = "error"


class GoalChannelType(StrEnum):
    """托管启动渠道类型"""

    WEB = "web"
    FEISHU = "feishu"
    SLACK = "slack"
    TELEGRAM = "telegram"


class GoalHistoryRole(StrEnum):
    """托管历史角色"""

    SYSTEM = "system"
    ASSISTANT = "assistant"
    TARGET = "target"
    USER = "user"


class GoalConfig(BaseModel):
    """托管配置模型，和前端配置完全对齐"""

    prompt: str = Field(..., description="托管目标任务描述")
    max_steps: int = Field(1000, ge=1, le=1000, description="内部安全上限，用户不可配置")
    step_delay_ms: int = Field(1200, ge=200, description="每步执行间隔毫秒")
    retry_limit: int = Field(2, ge=0, description="最大错误重试次数")
    auto_stop_minutes: int = Field(0, ge=0, le=10080, description="内部保留字段，默认 0 不启用")
    initiative: int = Field(70, ge=0, le=100, description="主动性百分比")
    emotional_intelligence: bool = Field(True, description="是否启用情绪智能")
    feishu_push_on_complete: bool = Field(
        True,
        description="目标自然结束时是否推送结果摘要（需同时选择 push_channel + push_target_id，或沿用飞书默认会话）",
    )
    push_channel: str = Field("", description="结果推送渠道：feishu / weixin / slack / telegram")
    push_target_id: str = Field("", description="渠道会话 ID（chat_id / 微信 user_id 等）")


class GoalSession(BaseModel):
    """托管会话模型"""

    id: str = Field(default_factory=lambda: f"goal-{uuid.uuid4().hex[:16]}", description="托管会话唯一ID")
    user_id: str | None = Field(None, description="用户标识")
    channel_type: GoalChannelType = Field(..., description="启动渠道")
    channel_chat_id: str = Field(..., description="渠道会话ID（飞书chat_id等）")
    channel_thread_id: str | None = Field(None, description="渠道线程ID")
    associated_session_key: str = Field(..., description="关联的Agent会话Key")
    config: GoalConfig = Field(..., description="托管配置")
    status: GoalStatus = Field(GoalStatus.IDLE, description="运行状态")
    current_step: int = Field(0, description="当前执行步数")
    goal_revision: int = Field(1, ge=1, description="目标版本；用户纠正后递增并作废旧 continuation")
    goal_status: str = Field("active", description="Goal 生命周期：active | paused | completed | cleared")
    continuation_suppressed: bool = Field(
        False,
        description="用户停止当前 run 后为 true，禁止 Goal Controller 自动续跑",
    )
    error_count: int = Field(0, description="连续错误计数")
    last_run_at: float = Field(default_factory=time.time, description="最后运行时间戳")
    last_error: str | None = Field(None, description="最后错误信息")
    created_at: float = Field(default_factory=time.time, description="创建时间戳")
    ended_at: float | None = Field(None, description="结束时间戳")
    pending_feedback: bool = Field(False, description="是否等待人工反馈")
    feedback_prompt: str | None = Field(None, description="等待反馈的提示信息")
    feedback_timeout_at: float | None = Field(None, description="反馈超时时间戳")
    awaiting_frontend_chat: bool = Field(
        False,
        description="Web 目标模式：首条 user 由前端 chatSend 发出，避免重复跑 lead_agent",
    )
    goal_summary: str = Field("", description="目标完成时的总结正文（Markdown 纯文本）")
    completion_outcome: str = Field("", description="完成标识/一句话结果")


class GoalHistoryItem(BaseModel):
    """托管历史记录项"""

    session_id: str = Field(..., description="托管会话ID")
    step: int = Field(..., description="对应执行步数")
    role: GoalHistoryRole = Field(..., description="角色")
    content: str = Field(..., description="内容")
    duration_ms: int | None = Field(None, description="耗时毫秒")
    timestamp: float = Field(default_factory=time.time, description="时间戳")
    metadata: dict[str, Any] = Field(default_factory=dict, description="扩展元数据")
