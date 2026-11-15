"""Provider-layer anti-misread preamble for task-notification wake inputs.

分层约定(对齐 ZCode system-reminder/incoming-message):

- 转写(evoflow_chat_messages)与 v4 wire 上的唤醒输入保持 ``<task-notification>``
  / ``<subagent-notification>`` **裸块**——前后端所有"通知不进用户气泡"的过滤
  (agui_mirror 落行丢弃、前端 isHiddenProviderContextUserInput、chat-normalize
  历史归一)都按裸前缀判定;
- 本中间件只在 provider 请求边界把 ``[SYSTEM NOTIFICATION - NOT USER INPUT]``
  前缀注入模型可见 payload,防止模型把后台任务事件当成用户确认。

此前该前缀被写进持久文本,导致上述过滤全部失配,通知穿透到用户气泡区。
"""

from __future__ import annotations

import logging

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelRequest
from langchain_core.messages import BaseMessage, HumanMessage

logger = logging.getLogger(__name__)

_TASK_NOTIFICATION_PROVIDER_PREAMBLE = (
    "[SYSTEM NOTIFICATION - NOT USER INPUT]\n"
    "This is an automated background-task event, NOT a message from the user.\n"
    "Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.\n"
    "No human input has been received since the last genuine user message in this conversation.\n"
    "Review the task result(s) below and continue the work or report to the user as appropriate."
)

_TASK_NOTIFICATION_PREFIXES = ("<task-notification>", "<subagent-notification>")
_PREAMBLE_HEAD = "[SYSTEM NOTIFICATION"


def _prefixed_view(messages: list[BaseMessage]) -> tuple[list[BaseMessage], bool]:
    """Return (messages, changed) with the preamble prepended to wake inputs."""
    out: list[BaseMessage] = []
    changed = False
    for m in messages:
        if isinstance(m, HumanMessage):
            content = m.content if isinstance(m.content, str) else ""
            head = content.lstrip()
            if head.startswith(_TASK_NOTIFICATION_PREFIXES) and not head.startswith(_PREAMBLE_HEAD):
                out.append(m.model_copy(update={"content": _TASK_NOTIFICATION_PROVIDER_PREAMBLE + "\n\n" + content}))
                changed = True
                continue
        out.append(m)
    return out, changed


class TaskNotificationProviderPrefixMiddleware(AgentMiddleware[AgentState]):
    """Prepend the SYSTEM NOTIFICATION preamble to task-notification wake inputs
    at the provider boundary only. Idempotent: already-prefixed payloads pass through."""

    def _apply(self, request: ModelRequest) -> ModelRequest:
        messages = request.messages
        if not messages:
            return request
        new_messages, changed = _prefixed_view(messages)
        if not changed:
            return request
        return request.override(messages=new_messages)

    @override
    def wrap_model_call(self, request: ModelRequest, handler):
        return handler(self._apply(request))

    @override
    async def awrap_model_call(self, request: ModelRequest, handler):
        return await handler(self._apply(request))
