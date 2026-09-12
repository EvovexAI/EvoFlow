import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.channels.models.goal import GoalChannelType, GoalConfig, GoalHistoryItem, GoalSession, GoalStatus
from app.channels.services.goal_service import GoalService
from app.gateway.goal_feishu_completion import push_markdown_to_default_feishu_chat
from evoflow.authz.http_guard import require_org_admin, require_session_visible

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/goal", tags=["goal"])


# 依赖注入托管服务实例
def get_goal_service() -> GoalService:
    """获取托管服务实例（与 automation_runner 同源：从环境变量读 LangGraph URL）。"""
    import os

    from langgraph_sdk import get_client

    from app.channels.manager import DEFAULT_LANGGRAPH_URL

    langgraph_url = (os.getenv("EVOFLOW_LANGGRAPH_URL", DEFAULT_LANGGRAPH_URL) or "").rstrip("/") or DEFAULT_LANGGRAPH_URL
    langgraph_api_key = os.getenv("EVOFLOW_LANGGRAPH_API_KEY") or None
    lg_client = get_client(url=langgraph_url, api_key=langgraph_api_key)
    return GoalService.get_instance(lg_client)



def _require_goal_session_visible(http_request: Request, goal_service: GoalService, session_id: str) -> None:
    """Gate by associated chat session_key (anti-IDOR)."""
    sid = str(session_id or "").strip()
    if not sid:
        raise HTTPException(status_code=404, detail="目标任务不存在")
    session = None
    try:
        session = goal_service.get_session(sid, None)
    except Exception:
        session = None
    if session is None:
        # Still 404 consistently; avoid leaking existence via auth differences when missing.
        raise HTTPException(status_code=404, detail="目标任务不存在")
    sk = str(getattr(session, "associated_session_key", None) or "").strip()
    if sk:
        require_session_visible(http_request, sk)


# 请求模型
class StartGoalRequest(BaseModel):
    """启动托管请求"""

    associated_session_key: str = Field(..., description="关联的Agent会话Key")
    config: GoalConfig = Field(..., description="目标配置")
    channel_type: GoalChannelType = Field(GoalChannelType.WEB, description="启动渠道")
    channel_chat_id: str | None = Field(None, description="渠道会话ID")
    user_id: str | None = Field(None, description="用户标识")
    use_frontend_chat: bool = Field(
        True,
        description="Web 默认 True：首条由 EvoPanel chatSend 发出（与普通发消息同 SSE）；False 为后端直写+Goal 图 main_agent",
    )


class AfterChatTurnRequest(BaseModel):
    """Web chatSend 首轮结束后通知 Goal 继续"""

    assistant_text: str = Field("", description="助手可见回复（可选，服务端也会读 transcript）")
    user_id: str | None = Field(None, description="用户标识")


class SubmitFeedbackRequest(BaseModel):
    """提交反馈请求"""

    feedback: str = Field(..., description="反馈内容")
    user_id: str | None = Field(None, description="用户标识")


# 响应模型
class GoalSessionResponse(BaseModel):
    """托管会话响应"""

    id: str = Field(..., description="托管会话ID")
    user_id: str | None = Field(None, description="用户标识")
    channel_type: GoalChannelType = Field(..., description="启动渠道")
    status: GoalStatus = Field(..., description="运行状态")
    current_step: int = Field(..., description="当前执行步数")
    max_steps: int = Field(..., description="最大执行步数")
    last_run_at: float = Field(..., description="最后运行时间戳")
    last_error: str | None = Field(None, description="最后错误信息")
    created_at: float = Field(..., description="创建时间戳")
    ended_at: float | None = Field(None, description="结束时间戳")
    pending_feedback: bool = Field(False, description="是否等待人工反馈")
    feedback_prompt: str | None = Field(None, description="当前等待反馈的提示语")
    associated_session_key: str = Field("", description="关联的 Agent 会话 Key")
    goal_status: str = Field("active", description="Goal 生命周期：active | paused | completed | cleared")
    continuation_suppressed: bool = Field(False, description="是否禁止自动 continuation")
    goal_revision: int = Field(1, description="目标版本号")
    awaiting_frontend_chat: bool = Field(False, description="等待前端 chatSend 发出首条目标")
    goal_summary: str = Field("", description="目标完成总结")
    completion_outcome: str = Field("", description="完成标识")

    @classmethod
    def from_session(cls, session: GoalSession) -> "GoalSessionResponse":
        return cls(
            id=session.id,
            user_id=session.user_id,
            channel_type=session.channel_type,
            status=session.status,
            current_step=session.current_step,
            max_steps=session.config.max_steps,
            last_run_at=session.last_run_at,
            last_error=session.last_error,
            created_at=session.created_at,
            ended_at=session.ended_at,
            pending_feedback=session.pending_feedback,
            feedback_prompt=getattr(session, "feedback_prompt", None),
            associated_session_key=session.associated_session_key,
            goal_status=str(session.goal_status or "active"),
            continuation_suppressed=bool(session.continuation_suppressed),
            goal_revision=int(session.goal_revision or 1),
            awaiting_frontend_chat=bool(getattr(session, "awaiting_frontend_chat", False)),
            goal_summary=str(getattr(session, "goal_summary", "") or ""),
            completion_outcome=str(getattr(session, "completion_outcome", "") or ""),
        )


class GoalHistoryResponse(BaseModel):
    """托管历史响应"""

    history: list[GoalHistoryItem] = Field(..., description="历史记录列表")


class GoalFeishuCompletionRequest(BaseModel):
    """EvoPanel / 客户端：托管结束后汇报到飞书（使用网关当前默认 chat_id）。"""

    title: str = Field(default="目标结束汇报", max_length=200, description="卡片标题前缀")
    markdown: str = Field(..., min_length=1, max_length=49_000, description="Markdown 正文")


class GoalFeishuCompletionResponse(BaseModel):
    success: bool
    message: str = ""


class BaseGoalResponse(BaseModel):
    """基础托管响应"""

    success: bool = Field(True, description="是否成功")
    message: str = Field("", description="消息")
    data: Any | None = Field(None, description="数据")


@router.post(
    "/start",
    response_model=GoalSessionResponse,
    summary="Start Hosted Task",
    description="Start a new hosted automatic task execution session.",
)
async def start_goal(
    http_request: Request,
    request: StartGoalRequest,
    goal_service: GoalService = Depends(get_goal_service),
) -> GoalSessionResponse:
    """启动托管任务"""
    require_session_visible(http_request, request.associated_session_key)
    try:
        # 如果channel_chat_id未提供，用会话Key作为默认值
        channel_chat_id = request.channel_chat_id or request.associated_session_key

        session = await goal_service.start_goal(
            user_id=request.user_id,
            channel_type=request.channel_type,
            channel_chat_id=channel_chat_id,
            associated_session_key=request.associated_session_key,
            config=request.config,
            use_frontend_chat=bool(request.use_frontend_chat),
        )
        return GoalSessionResponse.from_session(session)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"启动托管失败：{e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"启动目标失败：{str(e)}")


@router.post(
    "/notify-feishu-completion",
    response_model=GoalFeishuCompletionResponse,
    summary="Report hosted run to Feishu",
    description="Push a markdown summary to the default Feishu chat (same resolution as automation).",
)
async def notify_goal_feishu_completion(http_request: Request, body: GoalFeishuCompletionRequest) -> GoalFeishuCompletionResponse:
    require_org_admin(http_request)
    ok, msg = await push_markdown_to_default_feishu_chat(title=body.title, markdown_body=body.markdown)
    return GoalFeishuCompletionResponse(success=ok, message=msg)


@router.post(
    "/{session_id}/stop",
    response_model=BaseGoalResponse,
    summary="Stop current Run (Goal stays active)",
    description="run.cancel：中断当前生成，Goal 仍 active，不自动 continuation。",
)
async def stop_goal(
    http_request: Request,
    session_id: str,
    user_id: str | None = None,
    goal_service: GoalService = Depends(get_goal_service),
) -> BaseGoalResponse:
    """停止当前 Run"""
    _require_goal_session_visible(http_request, goal_service, session_id)
    try:
        success = await goal_service.stop_goal(session_id, user_id)
        if not success:
            raise HTTPException(status_code=404, detail="目标任务不存在")
        return BaseGoalResponse(success=True, message="已停止当前运行，Goal 仍保留")
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except Exception as e:
        logger.error(f"停止托管失败：{e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"停止目标失败：{str(e)}")


@router.post(
    "/{session_id}/pause",
    response_model=BaseGoalResponse,
    summary="Pause Goal",
)
async def pause_hosted_goal(
    http_request: Request,
    session_id: str,
    user_id: str | None = None,
    goal_service: GoalService = Depends(get_goal_service),
) -> BaseGoalResponse:
    _require_goal_session_visible(http_request, goal_service, session_id)
    try:
        success = await goal_service.pause_goal(session_id, user_id)
        if not success:
            raise HTTPException(status_code=404, detail="目标任务不存在")
        return BaseGoalResponse(success=True, message="Goal 已暂停")
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))


@router.post(
    "/{session_id}/resume",
    response_model=BaseGoalResponse,
    summary="Resume Goal",
)
async def resume_hosted_goal(
    http_request: Request,
    session_id: str,
    user_id: str | None = None,
    goal_service: GoalService = Depends(get_goal_service),
) -> BaseGoalResponse:
    _require_goal_session_visible(http_request, goal_service, session_id)
    try:
        success = await goal_service.resume_goal(session_id, user_id)
        if not success:
            raise HTTPException(status_code=404, detail="目标任务不存在或不可恢复")
        return BaseGoalResponse(success=True, message="Goal 已恢复")
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))


@router.post(
    "/{session_id}/end",
    response_model=BaseGoalResponse,
    summary="End Goal",
)
async def end_hosted_goal(
    http_request: Request,
    session_id: str,
    user_id: str | None = None,
    goal_service: GoalService = Depends(get_goal_service),
) -> BaseGoalResponse:
    _require_goal_session_visible(http_request, goal_service, session_id)
    try:
        success = await goal_service.end_goal(session_id, user_id)
        if not success:
            raise HTTPException(status_code=404, detail="目标任务不存在")
        return BaseGoalResponse(success=True, message="Goal 已结束")
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))


@router.post(
    "/{session_id}/after-chat-turn",
    response_model=BaseGoalResponse,
    summary="After first Web chatSend turn (kick Goal Controller)",
)
async def after_hosted_chat_turn(
    http_request: Request,
    session_id: str,
    request: AfterChatTurnRequest,
    goal_service: GoalService = Depends(get_goal_service),
) -> BaseGoalResponse:
    _require_goal_session_visible(http_request, goal_service, session_id)
    try:
        ok = await goal_service.after_frontend_chat_turn(
            session_id,
            assistant_text=request.assistant_text,
            user_id=request.user_id,
        )
        if not ok:
            raise HTTPException(status_code=404, detail="目标任务不存在")
        return BaseGoalResponse(success=True, message="Goal Controller 已启动")
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))


class GoalSettingsResponse(BaseModel):
    """Goal 面板配置（SQLite 权威源）"""

    session_key: str = Field(..., alias="sessionKey")
    goal_session_id: str = Field("", alias="goalSessionId")
    config: dict[str, Any] = Field(default_factory=dict)
    goal_status: str = Field("cleared", alias="goalStatus")
    goal_revision: int = Field(1, alias="goalRevision")
    continuation_suppressed: bool = Field(False, alias="continuationSuppressed")
    runtime: dict[str, Any] = Field(default_factory=dict)

    model_config = {"populate_by_name": True}


class SaveGoalSettingsRequest(BaseModel):
    """保存 Goal 表单草稿（不启动 run）"""

    config: GoalConfig = Field(..., description="Goal 配置")
    user_id: str | None = Field(None, description="用户标识")


@router.get(
    "/settings-by-key/{session_key}",
    response_model=GoalSettingsResponse | None,
    summary="Get Goal settings by session key",
)
async def get_hosted_settings_by_key(
    http_request: Request,
    session_key: str,
    goal_service: GoalService = Depends(get_goal_service),
) -> GoalSettingsResponse | None:
    require_session_visible(http_request, session_key)
    data = goal_service.load_settings_by_key(session_key)
    if not data:
        return None
    return GoalSettingsResponse.model_validate(data)


@router.put(
    "/settings-by-key/{session_key}",
    response_model=GoalSettingsResponse,
    summary="Save Goal settings draft",
)
async def save_hosted_settings_by_key(
    http_request: Request,
    session_key: str,
    request: SaveGoalSettingsRequest,
    goal_service: GoalService = Depends(get_goal_service),
) -> GoalSettingsResponse:
    require_session_visible(http_request, session_key)
    try:
        data = await goal_service.save_settings_by_key(
            session_key,
            request.config,
            user_id=request.user_id,
        )
        return GoalSettingsResponse.model_validate(data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("save hosted settings failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"保存目标配置失败：{e}")


@router.get(
    "/by-key/{session_key}",
    response_model=GoalSessionResponse | None,
    summary="Get Hosted Task by Session Key",
    description="Find an active hosted task by its associated session key (for frontend polling).",
)
async def get_hosted_by_key(
    http_request: Request,
    session_key: str,
    goal_service: GoalService = Depends(get_goal_service),
) -> GoalSessionResponse | None:
    """按 session_key 查找活跃目标模式会话；无则返回 null（不报 404，避免前端 console 噪音）"""
    require_session_visible(http_request, session_key)
    try:
        session = goal_service.resolve_goal_session_for_poll(session_key)
        if not session:
            return None
        return GoalSessionResponse.from_session(session)
    except Exception as e:
        logger.error(f"按key查询托管失败：{e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"查询失败：{str(e)}")


@router.get(
    "/{session_id}/status",
    response_model=GoalSessionResponse,
    summary="Get Goal Task Status",
    description="Get current status of a goal mode session.",
)
async def get_hosted_status(
    http_request: Request,
    session_id: str,
    user_id: str | None = None,
    goal_service: GoalService = Depends(get_goal_service),
) -> GoalSessionResponse:
    """获取目标模式任务状态"""
    _require_goal_session_visible(http_request, goal_service, session_id)
    try:
        session = goal_service.get_session(session_id, user_id)
        if not session:
            raise HTTPException(status_code=404, detail="目标模式任务不存在")
        return GoalSessionResponse.from_session(session)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except Exception as e:
        logger.error(f"获取目标模式状态失败：{e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"获取目标模式状态失败：{str(e)}")


@router.get(
    "/{session_id}/history",
    response_model=GoalHistoryResponse,
    summary="Get Hosted Task History",
    description="Get execution history of a hosted task session.",
)
async def get_hosted_history(
    http_request: Request,
    session_id: str,
    user_id: str | None = None,
    limit: int = 20,
    goal_service: GoalService = Depends(get_goal_service),
) -> GoalHistoryResponse:
    """获取托管任务历史"""
    _require_goal_session_visible(http_request, goal_service, session_id)
    try:
        history = goal_service.get_session_history(session_id, user_id, limit)
        return GoalHistoryResponse(history=history)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except Exception as e:
        logger.error(f"获取托管历史失败：{e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"获取目标历史失败：{str(e)}")


@router.post(
    "/{session_id}/feedback",
    response_model=BaseGoalResponse,
    summary="Submit Feedback to Hosted Task",
    description="Submit human feedback to a paused hosted task and resume execution.",
)
async def submit_feedback(
    http_request: Request,
    session_id: str,
    request: SubmitFeedbackRequest,
    goal_service: GoalService = Depends(get_goal_service),
) -> BaseGoalResponse:
    """提交人工反馈并继续执行"""
    _require_goal_session_visible(http_request, goal_service, session_id)
    try:
        success = await goal_service.submit_feedback(session_id, request.feedback, request.user_id)
        if not success:
            raise HTTPException(status_code=404, detail="目标任务不存在或不处于等待反馈状态")
        return BaseGoalResponse(success=True, message="反馈已提交，任务将继续执行")
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except Exception as e:
        logger.error(f"提交反馈失败：{e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"提交反馈失败：{str(e)}")
