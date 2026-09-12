"""Error codes and standardized error responses for Task API.

This module provides:
1. Business error code constants
2. Standardized error response structure
3. Helper functions to create consistent error responses
"""

from enum import StrEnum
from typing import Any

from fastapi import HTTPException
from pydantic import BaseModel


class ErrorCode(StrEnum):
    """Business error codes for task operations."""

    # Task errors (TASK_xxx)
    TASK_NOT_FOUND = "TASK_NOT_FOUND"
    TASK_ALREADY_RUNNING = "TASK_ALREADY_RUNNING"
    TASK_NOT_EXECUTABLE = "TASK_NOT_EXECUTABLE"
    TASK_CANCEL_FAILED = "TASK_CANCEL_FAILED"

    # Subtask errors (SUBTASK_xxx)
    SUBTASK_NOT_FOUND = "SUBTASK_NOT_FOUND"
    SUBTASK_NOT_RETRYABLE = "SUBTASK_NOT_RETRYABLE"

    # Validation errors (VALIDATION_xxx)
    INVALID_STATUS = "INVALID_STATUS"
    INVALID_ACTION = "INVALID_ACTION"
    MISSING_REQUIRED_FIELD = "MISSING_REQUIRED_FIELD"
    INVALID_PARAMETERS = "INVALID_PARAMETERS"

    # Execution errors (EXECUTION_xxx)
    EXECUTION_FAILED = "EXECUTION_FAILED"
    EXECUTION_NOT_AUTHORIZED = "EXECUTION_NOT_AUTHORIZED"

    # System errors (SYSTEM_xxx)
    INTERNAL_ERROR = "INTERNAL_ERROR"
    DATABASE_ERROR = "DATABASE_ERROR"
    SAVE_FAILED = "SAVE_FAILED"


# HTTP status code mapping for error codes
ERROR_CODE_STATUS_MAP: dict[ErrorCode, int] = {
    ErrorCode.TASK_NOT_FOUND: 404,
    ErrorCode.TASK_ALREADY_RUNNING: 409,
    ErrorCode.TASK_NOT_EXECUTABLE: 400,
    ErrorCode.TASK_CANCEL_FAILED: 422,
    ErrorCode.SUBTASK_NOT_FOUND: 404,
    ErrorCode.SUBTASK_NOT_RETRYABLE: 400,
    ErrorCode.INVALID_STATUS: 400,
    ErrorCode.INVALID_ACTION: 400,
    ErrorCode.MISSING_REQUIRED_FIELD: 400,
    ErrorCode.INVALID_PARAMETERS: 400,
    ErrorCode.EXECUTION_FAILED: 422,
    ErrorCode.EXECUTION_NOT_AUTHORIZED: 403,
    ErrorCode.INTERNAL_ERROR: 500,
    ErrorCode.DATABASE_ERROR: 500,
    ErrorCode.SAVE_FAILED: 500,
}


# Human-readable error messages
ERROR_MESSAGES: dict[ErrorCode, str] = {
    ErrorCode.TASK_NOT_FOUND: "任务不存在",
    ErrorCode.TASK_ALREADY_RUNNING: "任务已在运行中",
    ErrorCode.TASK_NOT_EXECUTABLE: "任务当前状态不允许执行此操作",
    ErrorCode.TASK_CANCEL_FAILED: "任务取消失败",
    ErrorCode.SUBTASK_NOT_FOUND: "子任务不存在",
    ErrorCode.SUBTASK_NOT_RETRYABLE: "子任务状态不允许重试",
    ErrorCode.INVALID_STATUS: "无效的状态值",
    ErrorCode.INVALID_ACTION: "无效的操作类型",
    ErrorCode.MISSING_REQUIRED_FIELD: "缺少必填字段",
    ErrorCode.INVALID_PARAMETERS: "请求参数不合法",
    ErrorCode.EXECUTION_FAILED: "执行失败",
    ErrorCode.EXECUTION_NOT_AUTHORIZED: "未获得执行授权",
    ErrorCode.INTERNAL_ERROR: "内部服务器错误",
    ErrorCode.DATABASE_ERROR: "数据库操作失败",
    ErrorCode.SAVE_FAILED: "保存失败",
}


class ErrorDetail(BaseModel):
    """Error detail item for validation errors."""

    field: str | None = None
    message: str
    code: str | None = None


class ErrorResponse(BaseModel):
    """Standardized error response structure.

    All API error responses follow this format for consistency.
    """

    success: bool = False
    error_code: str
    message: str
    details: list[ErrorDetail] | None = None
    request_id: str | None = None


def get_error_status_code(error_code: ErrorCode) -> int:
    """Get HTTP status code for an error code."""
    return ERROR_CODE_STATUS_MAP.get(error_code, 500)


def get_error_message(error_code: ErrorCode, custom_message: str | None = None) -> str:
    """Get error message, using custom message if provided."""
    if custom_message:
        return custom_message
    return ERROR_MESSAGES.get(error_code, "未知错误")


def create_error_response(
    error_code: ErrorCode,
    message: str | None = None,
    details: list[ErrorDetail] | None = None,
    request_id: str | None = None,
) -> dict[str, Any]:
    """Create a standardized error response dictionary.

    Args:
        error_code: The business error code
        message: Custom error message (optional)
        details: List of error details for validation errors (optional)
        request_id: Request tracking ID (optional)

    Returns:
        Error response dictionary matching ErrorResponse schema
    """
    return {
        "success": False,
        "error_code": error_code.value,
        "message": get_error_message(error_code, message),
        "details": [d.model_dump() for d in details] if details else None,
        "request_id": request_id,
    }


def raise_task_error(
    error_code: ErrorCode,
    message: str | None = None,
    details: list[ErrorDetail] | None = None,
) -> None:
    """Raise an HTTPException with standardized error format.

    This is a convenience function to raise errors with the standard format.

    Args:
        error_code: The business error code
        message: Custom error message (optional)
        details: List of error details for validation errors (optional)

    Raises:
        HTTPException: With standardized error response
    """
    status_code = get_error_status_code(error_code)
    error_response = create_error_response(error_code, message, details)
    raise HTTPException(status_code=status_code, detail=error_response)


# Common error scenarios helpers
async def raise_task_not_found(task_id: str) -> None:
    """Raise task not found error."""
    raise_task_error(ErrorCode.TASK_NOT_FOUND, f"任务 '{task_id}' 不存在")


def raise_subtask_not_found(subtask_id: str, task_id: str | None = None) -> None:
    """Raise subtask not found error."""
    message = f"子任务 '{subtask_id}' 不存在"
    if task_id:
        message = f"子任务 '{subtask_id}' 在任务 '{task_id}' 中不存在"
    raise_task_error(ErrorCode.SUBTASK_NOT_FOUND, message)


def raise_invalid_status_transition(current_status: str, target_status: str) -> None:
    """Raise invalid status transition error."""
    raise_task_error(ErrorCode.TASK_NOT_EXECUTABLE, f"无法从状态 '{current_status}' 转换到 '{target_status}'")


def raise_invalid_action(action: str, allowed_actions: list[str]) -> None:
    """Raise invalid action error."""
    raise_task_error(ErrorCode.INVALID_ACTION, f"无效的操作 '{action}'，允许的操作: {', '.join(allowed_actions)}")
