# 基于 A2A 协议的多智能体群聊会议设计

> **状态**：设计稿 v3（基于 Google A2A 标准协议）
> **版本**：v3.0 - 2026-07-23
> **协议参考**：A2A (Agent-to-Agent) Protocol v0.3 (Google, 2025)
> **废弃方案**：v1 (meeting_speak + SubagentExecutor)、v2 (dispatch_task 直接编排)

---

## 0. 一句话

每个智能体员工暴露 **A2A 标准 Agent Card** 和 **JSON-RPC Task 接口**，会议编排器作为 A2A Client 依次向参会员工发送 Task（`tasks/send`），通过 SSE（`tasks/subscribe`）接收流式回复，所有 Task 的消息聚合到群聊时间线展示。内部 Agent 的 A2A 适配层复用现有 `dispatch_task` + `ProactiveEngine`，对外暴露标准 A2A 语义。

---

## 1. A2A 协议核心概念映射

### 1.1 A2A 协议实体 → EvoFlow 映射

| A2A 概念 | A2A 定义 | EvoFlow 对应 |
|----------|---------|--------------|
| **Agent Card** | `/.well-known/agent.json`，描述 agent 能力、技能、端点 | `ProactiveRole` config → 生成 Agent Card JSON |
| **Agent Server** | 暴露 JSON-RPC 端点的 HTTP 服务 | FastAPI router `/api/a2a/{agent_code}/*`，内部调 dispatch_task |
| **Agent Client** | 发起 Task 的调用方 | 会议编排器（Meeting Orchestrator） |
| **Task** | agent 间协作的工作单元，有完整生命周期 | `dispatch_task` 的 round_id → A2A Task |
| **Task State** | submitted→working→input-required→completed | dispatch 前→think 中→审批中→think 完成 |
| **Message** | Task 内的对话消息，含 role + parts | `proactive:{code}` 会话的 chat_message |
| **Artifact** | Task 产出物 | 员工产出的文件/报告 |
| **SSE Streaming** | `tasks/subscribe` 推送 Task 实时更新 | LangGraph stream → A2A SSE 事件 |
| **Push Notification** | 长时 Task 完成后 webhook 通知 | 现有 WS notify + 飞书推送 |

### 1.2 Agent Card 结构

每个员工暴露一个 Agent Card，遵循 A2A 标准：

```json
{
  "name": "项目·架构师",
  "description": "负责需求澄清、方案设计、设计文档",
  "url": "http://localhost:8001/api/a2a/project-architect",
  "version": "1.0.0",
  "capabilities": {
    "streaming": true,
    "pushNotifications": true,
    "stateTransitionHistory": true
  },
  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/plain", "application/json"],
  "skills": [
    {
      "id": "architecture-design",
      "name": "方案设计",
      "description": "从需求拆解到架构方案输出",
      "tags": ["architecture", "design", "analysis"],
      "examples": ["设计登录页重构方案", "拆分微服务架构"]
    },
    {
      "id": "requirement-clarification",
      "name": "需求澄清",
      "description": "分析需求边界和约束",
      "tags": ["requirement", "analysis"],
      "examples": ["澄清登录页重构的验收标准"]
    }
  ]
}
```

**Agent Card 数据源**：从 `ProactiveRole` 生成

```
ProactiveRole → Agent Card 映射：
  role_name        → name
  config.responsibilities → description (拼接)
  config.skills    → skills (按 skill 名查询技能元数据)
  config.workspace_path    → (内部用，不暴露)
  config.tool_groups → (决定 capabilities)
  agent_code       → url path segment
```

### 1.3 Task 生命周期映射

```
A2A Task State Machine          EvoFlow Dispatch Flow
─────────────────────           ──────────────────────
submitted ─────────────────────► dispatch_task() 被调用
  │                              ├─ 创建 board Task
  │                              └─ 生成 round_id
  ▼
working ──────────────────────► engine.think() 开始
  │                              ├─ _run_langgraph_agent() 启动
  │                              ├─ SSE 流式推送 task updates
  │                              │
  │  (如果需要审批)                  │  (如果 autonomy_level 需要)
  ▼                              ▼
input-required ───────────────► approval pending
  │                              ├─ 审批卡片推送到桌面/飞书
  │  (用户审批后)                   │  (用户审批后)
  ▼                              ▼
working ──────────────────────► 审批通过，继续执行
  │
  ▼
completed ────────────────────► think() 返回 ThinkResult
  │                              ├─ 消息落库 proactive:{code}
  │                              └─ round_inits 收集完成
  ▼
(artifact 返回)                   员工发言内容 + 工具产物
```

---

## 2. 架构设计

### 2.1 整体架构

```
┌──────────────────────────────────────────────────────────────┐
│                        前端 EvoPanel                           │
│                    MeetingView (群聊视图)                      │
│              聚合多 Task SSE → 群聊气泡时间线                    │
└──────────┬───────────────────────────────────┬───────────────┘
           │ A2A SSE 订阅                        │ REST API
           ▼                                     ▼
┌─────────────────────┐         ┌───────────────────────────────┐
│  Meeting             │         │  A2A Agent Card Registry      │
│  Orchestrator        │         │  GET /.well-known/agent.json   │
│  (A2A Client)        │         │  GET /api/a2a/agents           │
│                      │         └───────────────────────────────┘
│  ┌─────────────────┐│
│  │ tasks/send      ││  JSON-RPC     ┌──────────────────────────┐
│  │ tasks/get       ││──────────────►│  A2A Agent Server        │
│  │ tasks/cancel    ││               │  (FastAPI Router)        │
│  │ tasks/subscribe ││◄─────SSE──────│                          │
│  └─────────────────┘│               │  /api/a2a/{agent_code}    │
└─────────────────────┘│               │  ├─ Agent Card           │
                       │               │  ├─ JSON-RPC endpoint     │
           ┌───────────┼───────────────┤  ├─ SSE stream           │
           │           │               │  └─ Push notification     │
           │           │               └──────────┬───────────────┘
           │           │                          │ 内部调用
           │           │                          ▼
           │           │               ┌──────────────────────────┐
           │           │               │  A2A Adapter Layer        │
           │           │               │  (翻译 A2A ↔ dispatch)    │
           │           │               └──────────┬───────────────┘
           │           │                          │
           │           │               ┌──────────▼───────────────┐
           │           │               │  ProactiveRunner          │
           │           │               │  dispatch_task()          │
           │           │               │  ProactiveEngine.think()  │
           │           │               │  _run_langgraph_agent()   │
           │           │               └──────────┬───────────────┘
           │           │                          │
           │           │               ┌──────────▼───────────────┐
           │           │               │  LangGraph Agent (员工)    │
           │           │               │  proactive:{agent_code}   │
           │           │               │  独立工具/技能/模型         │
           │           │               └──────────────────────────┘
           │           │
           │    ┌──────▼──────┐
           └───►│  外部 Agent  │  (未来: Coze/Dify/AutoGen agent
                │  (A2A 兼容)  │   只要实现 A2A 协议就能参会)
                └─────────────┘
```

### 2.2 三层分离

| 层 | 职责 | 新增/复用 |
|----|------|----------|
| **A2A 协议层** | Agent Card 暴露 + JSON-RPC 端点 + SSE 流式 + Task 状态机 | **新增** |
| **A2A 适配层** | 把 A2A `tasks/send` 翻译成 `dispatch_task`；把 LangGraph stream 翻译成 A2A SSE 事件 | **新增** |
| **底层运行层** | dispatch_task + ProactiveEngine + LangGraph agent loop | **完全复用，不改** |

---

## 3. 后端设计

### 3.1 A2A Agent Server Router

新增 FastAPI router，为每个员工暴露 A2A 标准端点：

```python
# backend/app/gateway/routers/a2a.py

from fastapi import APIRouter, Request, Response
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel, Field
from typing import Any
import json, uuid, asyncio

router = APIRouter(tags=["a2a"])

# ── Agent Card (A2A 标准发现机制) ──────────────────────────

@router.get("/.well-known/agent.json")
async def well_known_agent_card() -> dict:
    """A2A 标准: 返回全部已上岗员工的 Agent Card 列表。

    外部 A2A Client 访问 /.well-known/agent.json 即可发现可用 agent。
    """
    roles = ProactiveRepository.list_roles(status="active")
    cards = [_role_to_agent_card(r) for r in roles]
    return {"agents": cards}


@router.get("/api/a2a/agents")
async def list_agent_cards() -> dict:
    """列出所有 agent 的 Agent Card（桌面端用）。"""
    roles = ProactiveRepository.list_roles(status="active")
    return {"agents": [_role_to_agent_card(r) for r in roles]}


@router.get("/api/a2a/{agent_code}/.well-known/agent.json")
async def agent_card(agent_code: str) -> dict:
    """单个员工的 Agent Card。"""
    role = ProactiveRepository.get_role(agent_code)
    if not role:
        return JSONResponse(status_code=404, content={"error": "agent not found"})
    return _role_to_agent_card(role)


def _role_to_agent_card(role: ProactiveRole) -> dict:
    """ProactiveRole → A2A Agent Card。"""
    skills = []
    for skill_name in role.config.skills:
        skill_meta = _lookup_skill_metadata(skill_name)
        skills.append({
            "id": skill_name,
            "name": skill_meta.get("label", skill_name),
            "description": skill_meta.get("description", ""),
            "tags": skill_meta.get("tags", []),
            "examples": skill_meta.get("examples", []),
        })

    responsibilities = "；".join(role.config.responsibilities) or role.role_name

    return {
        "name": role.role_name,
        "description": responsibilities,
        "url": f"/api/a2a/{role.agent_code}",
        "agent_code": role.agent_code,
        "version": "1.0.0",
        "capabilities": {
            "streaming": True,
            "pushNotifications": True,
            "stateTransitionHistory": True,
        },
        "defaultInputModes": ["text/plain"],
        "defaultOutputModes": ["text/plain", "application/json"],
        "skills": skills,
        # EvoFlow 扩展字段（非标准）
        "department": role.department,
        "workspace": role.config.workspace_path,
        "model": role.config.model_name or "",
        "tools": role.config.tool_groups,
    }
```

### 3.2 A2A JSON-RPC 端点

每个员工暴露 A2A 标准的 JSON-RPC 2.0 端点：

```python
# ── JSON-RPC 2.0: A2A 标准方法 ─────────────────────────────

class JSONRPCRequest(BaseModel):
    jsonrpc: str = "2.0"
    method: str
    params: dict[str, Any] = Field(default_factory=dict)
    id: str | int | None = None


@router.post("/api/a2a/{agent_code}")
async def a2a_jsonrpc(agent_code: str, req: JSONRPCRequest) -> Any:
    """A2A JSON-RPC 2.0 端点。

    支持的标准方法：
    - tasks/send      发送消息/创建任务
    - tasks/get       查询任务状态
    - tasks/cancel    取消任务
    - tasks/subscribe 订阅 SSE 流
    """
    role = ProactiveRepository.get_role(agent_code)
    if not role:
        return _rpc_error(req.id, -32001, "agent not found")

    if req.method == "tasks/send":
        return await _handle_tasks_send(agent_code, req)
    elif req.method == "tasks/get":
        return await _handle_tasks_get(agent_code, req)
    elif req.method == "tasks/cancel":
        return await _handle_tasks_cancel(agent_code, req)
    elif req.method == "tasks/subscribe":
        # 返回 SSE endpoint URL
        return _rpc_result(req.id, {
            "subscribeUrl": f"/api/a2a/{agent_code}/tasks/{req.params.get('taskId')}/stream"
        })
    else:
        return _rpc_error(req.id, -32601, f"method not found: {req.method}")
```

### 3.3 tasks/send → dispatch_task 适配

```python
async def _handle_tasks_send(agent_code: str, req: JSONRPCRequest) -> dict:
    """A2A tasks/send → 内部 dispatch_task。

    请求格式 (A2A 标准):
    {
        "jsonrpc": "2.0",
        "method": "tasks/send",
        "params": {
            "sessionId": "meeting_xxx",       // A2A session
            "message": {
                "role": "user",
                "parts": [
                    {"type": "text", "text": "讨论登录页重构方案"}
                ]
            },
            "metadata": {
                "context_summary": "前序发言: 架构师说...",  // 会议上下文
                "source": "meeting_orchestrator"
            }
        },
        "id": "req-1"
    }
    """
    params = req.params
    session_id = params.get("sessionId", "")
    message = params.get("message", {})
    metadata = params.get("metadata", {})

    # 从 message.parts 提取文本
    goal_text = ""
    parts = message.get("parts", [])
    for part in parts:
        if part.get("type") == "text":
            goal_text += part.get("text", "")

    # 注入会议上下文（前序发言摘要）
    context_summary = metadata.get("context_summary", "")
    if context_summary:
        goal_text = f"{goal_text}\n\n--- 会议上下文 ---\n{context_summary}"

    # ── 适配层：调 dispatch_task（完全复用！）──────────────
    runner = get_proactive_runner()
    result = await runner.dispatch_task(
        agent_code=agent_code,
        goal=goal_text,
        source="a2a_meeting",
        from_agent=metadata.get("from_agent", "meeting_orchestrator"),
    )

    if result.get("busy"):
        # 员工正忙，返回 input-required 或排队
        return _rpc_result(req.id, {
            "task": {
                "id": result.get("round_id", ""),
                "sessionId": session_id,
                "status": {
                    "state": "input-required",
                    "timestamp": utc_now_iso_z(),
                    "message": {"role": "agent", "parts": [
                        {"type": "text", "text": "员工正在执行其他任务，请稍后重试"}
                    ]}
                }
            }
        })

    # 返回 A2A Task 对象
    round_id = result.get("round_id", "")
    task = {
        "id": round_id,                       # A2A Task ID = round_id
        "sessionId": session_id,              # A2A Session = meeting session
        "status": {
            "state": "working",               # dispatch 已启动 think
            "timestamp": utc_now_iso_z(),
        },
        "messages": [
            {
                "role": "user",
                "parts": [{"type": "text", "text": goal_text}],
                "taskId": round_id,
                "messageId": f"msg_{uuid4().hex[:12]}",
            }
        ],
        # EvoFlow 扩展
        "agent_code": agent_code,
        "role_name": role.role_name,
        "subscribeUrl": f"/api/a2a/{agent_code}/tasks/{round_id}/stream",
    }

    return _rpc_result(req.id, {"task": task})
```

### 3.4 SSE 流式端点

```python
@router.get("/api/a2a/{agent_code}/tasks/{task_id}/stream")
async def a2a_task_stream(agent_code: str, task_id: str):
    """A2A SSE: 订阅 Task 的实时更新。

    把 LangGraph stream 事件翻译成 A2A SSE 事件：
    - task:working    agent 正在工作（think 中）
    - task:message    新消息片段（流式 delta）
    - task:artifact   产出物
    - task:completed  完成
    - task:failed     失败
    """
    session_key = f"proactive:{agent_code}"

    async def event_generator():
        last_seq = 0

        while True:
            # 拉取 proactive:{code} 会话的新消息
            messages = msg_repo.list_messages(
                session_key=session_key,
                after_seq=last_seq,
                round_id_filter=task_id,  # 只拉本次 round 的消息
            )

            for msg in messages:
                if msg["seq"] <= last_seq:
                    continue

                # 翻译成 A2A SSE 事件
                if msg["role"] == "assistant":
                    text = _extract_text(msg)
                    if text:
                        yield {
                            "event": "task:message",
                            "data": json.dumps({
                                "taskId": task_id,
                                "agentCode": agent_code,
                                "message": {
                                    "role": "agent",
                                    "parts": [{"type": "text", "text": text}],
                                }
                            }, ensure_ascii=False)
                        }

                # 工具调用作为 artifact 或 progress
                if msg.get("tool_name"):
                    yield {
                        "event": "task:artifact",
                        "data": json.dumps({
                            "taskId": task_id,
                            "artifact": {
                                "name": msg["tool_name"],
                                "parts": [{"type": "text", "text": msg.get("tool_body", "")[:500]}]
                            }
                        }, ensure_ascii=False)
                    }

                last_seq = max(last_seq, msg["seq"])

            # 检查 Task 是否完成
            task_status = _check_task_status(agent_code, task_id)
            if task_status == "completed":
                yield {
                    "event": "task:completed",
                    "data": json.dumps({
                        "taskId": task_id,
                        "agentCode": agent_code,
                        "status": {"state": "completed", "timestamp": utc_now_iso_z()}
                    }, ensure_ascii=False)
                }
                break
            elif task_status == "failed":
                yield {
                    "event": "task:failed",
                    "data": json.dumps({
                        "taskId": task_id,
                        "error": "task execution failed"
                    }, ensure_ascii=False)
                }
                break

            await asyncio.sleep(1.0)  # 轮询间隔

    return EventSourceResponse(event_generator())
```

### 3.5 tasks/get 和 tasks/cancel

```python
async def _handle_tasks_get(agent_code: str, req: JSONRPCRequest) -> dict:
    """A2A tasks/get: 查询 Task 状态和消息。"""
    task_id = req.params.get("taskId", "")
    session_key = f"proactive:{agent_code}"

    messages = msg_repo.list_messages(
        session_key=session_key,
        round_id_filter=task_id,
    )

    status = _check_task_status(agent_code, task_id)

    # 转成 A2A Message 格式
    a2a_messages = []
    for msg in messages:
        a2a_messages.append({
            "role": "agent" if msg["role"] == "assistant" else "user",
            "parts": [{"type": "text", "text": _extract_text(msg)}],
            "taskId": task_id,
            "messageId": f"msg_{msg['seq']}",
        })

    return _rpc_result(req.id, {
        "task": {
            "id": task_id,
            "sessionId": f"proactive:{agent_code}",
            "status": {"state": status, "timestamp": utc_now_iso_z()},
            "messages": a2a_messages,
        }
    })


async def _handle_tasks_cancel(agent_code: str, req: JSONRPCRequest) -> dict:
    """A2A tasks/cancel: 取消 Task。"""
    task_id = req.params.get("taskId", "")

    # 复用现有 cancellation 机制
    from evoflow.proactive.runner import get_proactive_runner
    runner = get_proactive_runner()
    # 标记 round 为 cancelled（复用现有 board Task cancel）
    await runner.cancel_dispatch(agent_code, task_id)

    return _rpc_result(req.id, {
        "task": {
            "id": task_id,
            "status": {"state": "canceled", "timestamp": utc_now_iso_z()},
        }
    })
```

### 3.6 Meeting Orchestrator（A2A Client）

```python
# backend/app/gateway/routers/meetings.py

class MeetingOrchestrator:
    """会议编排器：作为 A2A Client，依次向参会员工发送 Task。

    不直接调 dispatch_task，而是通过 A2A JSON-RPC 协议调用每个员工的端点。
    这样内部员工和外部 agent 走同一条路径。
    """

    async def start_discussion(
        self,
        meeting_id: str,
        topic: str,
        participants: list[str],  # agent_code 列表
        speaker_order: list[str] | None = None,
    ) -> dict:
        order = speaker_order or participants
        context_summary = ""
        results = []

        for agent_code in order:
            # ── 通过 A2A 协议发送 Task ──────────────────
            task = await self._send_task(
                agent_code=agent_code,
                session_id=meeting_id,
                message_text=topic,
                context_summary=context_summary,
            )

            task_id = task["id"]
            subscribe_url = task["subscribeUrl"]

            # ── 等待 Task 完成 ──────────────────────────
            result = await self._wait_for_task(agent_code, task_id)

            # ── 收集发言，更新 context_summary ──────────
            employee_reply = result.get("final_text", "")
            role = ProactiveRepository.get_role(agent_code)
            role_name = role.role_name if role else agent_code

            context_summary += f"\n【{role_name}】：{employee_reply[:500]}"

            results.append({
                "agent_code": agent_code,
                "role_name": role_name,
                "task_id": task_id,
                "reply": employee_reply,
            })

        return {
            "meeting_id": meeting_id,
            "topic": topic,
            "speakers": results,
        }

    async def _send_task(
        self,
        agent_code: str,
        session_id: str,
        message_text: str,
        context_summary: str = "",
    ) -> dict:
        """通过 A2A JSON-RPC tasks/send 发送任务。

        内部 agent: 走 HTTP localhost (同进程 FastAPI)
        外部 agent: 走配置的远程 URL
        """
        base_url = self._resolve_agent_url(agent_code)

        rpc_request = {
            "jsonrpc": "2.0",
            "method": "tasks/send",
            "params": {
                "sessionId": session_id,
                "message": {
                    "role": "user",
                    "parts": [{"type": "text", "text": message_text}],
                },
                "metadata": {
                    "context_summary": context_summary,
                    "source": "meeting_orchestrator",
                    "from_agent": "meeting_orchestrator",
                }
            },
            "id": str(uuid4().hex[:12]),
        }

        async with httpx.AsyncClient(timeout=300) as client:
            resp = await client.post(f"{base_url}/api/a2a/{agent_code}", json=rpc_request)
            rpc_response = resp.json()

        result = rpc_response.get("result", {})
        return result.get("task", {})

    async def _wait_for_task(self, agent_code: str, task_id: str) -> dict:
        """等待 Task 完成，通过 A2A tasks/get 轮询或 SSE 订阅。"""
        base_url = self._resolve_agent_url(agent_code)
        stream_url = f"{base_url}/api/a2a/{agent_code}/tasks/{task_id}/stream"

        final_text = ""
        async with httpx.AsyncClient(timeout=300) as client:
            async with client.stream("GET", stream_url) as resp:
                async for line in resp.aiter_lines():
                    if line.startswith("data: "):
                        data = json.loads(line[6:])
                        event_type = data.get("event", "")

                        if event_type == "task:message":
                            parts = data.get("message", {}).get("parts", [])
                            for part in parts:
                                if part.get("type") == "text":
                                    final_text = part["text"]  # 最新文本

                        elif event_type == "task:completed":
                            break
                        elif event_type == "task:failed":
                            break

        return {"final_text": final_text, "task_id": task_id}

    def _resolve_agent_url(self, agent_code: str) -> str:
        """解析 agent 的 A2A 端点 URL。

        内部 agent: http://localhost:{gateway_port}
        外部 agent: 从 Agent Card registry 查询注册的远程 URL
        """
        # 先查内部
        role = ProactiveRepository.get_role(agent_code)
        if role:
            return f"http://127.0.0.1:{_gateway_port()}"
        # 查外部 A2A agent registry
        return _external_agent_registry().get_url(agent_code)
```

### 3.7 Meeting API

```python
# backend/app/gateway/routers/meetings.py

router = APIRouter(prefix="/api/meetings", tags=["meetings"])

class CreateMeetingRequest(BaseModel):
    title: str = ""
    participants: list[str] = []
    session_key: str = ""


@router.post("")
async def create_meeting(req: CreateMeetingRequest) -> dict:
    """创建会议。"""
    meeting_id = f"mt_{uuid4().hex[:12]}"
    participants_meta = []
    for code in req.participants:
        role = ProactiveRepository.get_role(code)
        if role:
            card = _role_to_agent_card(role)
            participants_meta.append({
                "agent_code": code,
                "role_name": role.role_name,
                "agent_card": card,
            })
    # 落库 evoflow_meetings
    ...
    return {"meeting_id": meeting_id, "participants": participants_meta}


@router.post("/{meeting_id}/discuss")
async def start_discussion(meeting_id: str, req: DiscussRequest) -> dict:
    """发起一轮讨论。"""
    meeting = get_meeting(meeting_id)
    orchestrator = MeetingOrchestrator()
    result = await orchestrator.start_discussion(
        meeting_id=meeting_id,
        topic=req.topic,
        participants=[p["agent_code"] for p in meeting["participants"]],
    )
    return result


@router.post("/{meeting_id}/mention")
async def meeting_mention(meeting_id: str, req: MentionRequest) -> dict:
    """用户 @某人，直接向该员工发送 A2A Task。"""
    meeting = get_meeting(meeting_id)
    parsed = parse_employee_mention(req.text, meeting["participants"])
    if not parsed:
        return await start_discussion(meeting_id, DiscussRequest(topic=req.text))

    orchestrator = MeetingOrchestrator()
    task = await orchestrator._send_task(
        agent_code=parsed.agent_code,
        session_id=meeting_id,
        message_text=parsed.task_text,
    )
    return {"agent_code": parsed.agent_code, "task": task}
```

---

## 4. 数据模型

### 4.1 A2A Task 存储

```sql
-- A2A Task 记录
CREATE TABLE evoflow_a2a_tasks (
    task_id         TEXT PRIMARY KEY,       -- A2A Task ID = dispatch round_id
    agent_code      TEXT NOT NULL,          -- 目标 agent
    meeting_id      TEXT DEFAULT '',       -- 所属会议（空=非会议直接调用）
    session_id      TEXT NOT NULL,          -- A2A session
    state           TEXT DEFAULT 'submitted', -- submitted|working|input-required|completed|canceled|failed
    goal            TEXT DEFAULT '',        -- 发送给 agent 的目标
    context_summary TEXT DEFAULT '',        -- 会议上下文（前序发言）
    result_text     TEXT DEFAULT '',        -- 最终回复文本
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    completed_at    TEXT DEFAULT NULL
);

-- A2A Task 消息（映射 proactive:{code} chat_message）
-- 不新建表，直接从 evoflow_chat_messages 按 round_id 过滤读取
```

### 4.2 外部 Agent 注册

```sql
-- 外部 A2A Agent 注册表（未来接入外部 agent 用）
CREATE TABLE evoflow_a2a_external_agents (
    agent_code      TEXT PRIMARY KEY,
    agent_name      TEXT NOT NULL,
    base_url        TEXT NOT NULL,          -- A2A JSON-RPC 端点
    agent_card_url  TEXT NOT NULL,          -- /.well-known/agent.json URL
    auth_token      TEXT DEFAULT '',
    status          TEXT DEFAULT 'registered', -- registered|verified|disabled
    created_at      TEXT NOT NULL
);
```

---

## 5. 前端设计

### 5.1 A2A SSE 订阅

前端通过 A2A SSE 端点订阅每个员工的 Task 流式更新：

```typescript
// evopanel/src/lib/a2a-client.ts

export class A2AClient {
  /** 通过 A2A SSE 订阅 Task 实时更新 */
  subscribeToTask(
    agentCode: string,
    taskId: string,
    onMessage: (text: string) => void,
    onArtifact: (name: string, content: string) => void,
    onComplete: (finalText: string) => void,
    onError: (error: string) => void,
  ): () => void {
    const url = `/api/a2a/${agentCode}/tasks/${taskId}/stream`
    const eventSource = new EventSource(url)

    eventSource.addEventListener('task:message', (e) => {
      const data = JSON.parse(e.data)
      const parts = data.message?.parts || []
      for (const part of parts) {
        if (part.type === 'text') onMessage(part.text)
      }
    })

    eventSource.addEventListener('task:artifact', (e) => {
      const data = JSON.parse(e.data)
      const artifact = data.artifact
      onArtifact(artifact.name, artifact.parts?.[0]?.text || '')
    })

    eventSource.addEventListener('task:completed', (e) => {
      const data = JSON.parse(e.data)
      onComplete(data.finalText || '')
      eventSource.close()
    })

    eventSource.addEventListener('task:failed', (e) => {
      onError('task failed')
      eventSource.close()
    })

    eventSource.onerror = () => {
      onError('connection error')
      eventSource.close()
    }

    return () => eventSource.close()
  }

  /** 发送 A2A Task */
  async sendTask(agentCode: string, sessionId: string, text: string, contextSummary = '') {
    const rpcRequest = {
      jsonrpc: '2.0',
      method: 'tasks/send',
      params: {
        sessionId,
        message: { role: 'user', parts: [{ type: 'text', text }] },
        metadata: { context_summary: contextSummary, source: 'meeting_ui' },
      },
      id: crypto.randomUUID(),
    }
    const resp = await fetch(`/api/a2a/${agentCode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rpcRequest),
    })
    const rpcResp = await resp.json()
    return rpcResp.result?.task
  }
}
```

### 5.2 MeetingView 群聊视图

```typescript
// evopanel/src/react/components/MeetingView.tsx

interface MeetingMessage {
  speakerAgentCode: string | null
  speakerRoleName: string | null
  text: string
  timestamp: number
  taskId?: string        // A2A Task ID
  artifacts?: { name: string; content: string }[]
  streaming?: boolean
}

export function MeetingView({ meetingId }: { meetingId: string }) {
  const [messages, setMessages] = useState<MeetingMessage[]>([])
  const [activeStreams, setActiveStreams] = useState<Map<string, () => void>>(new Map())
  const a2aClient = useRef(new A2AClient())

  // 发起讨论
  const handleDiscuss = async (topic: string) => {
    // 调 POST /api/meetings/{id}/discuss，后端返回 speakers + task_ids
    const result = await api.meetingDiscuss(meetingId, { topic })

    for (const speaker of result.speakers) {
      // 为每个员工的 Task 订阅 A2A SSE
      const unsubscribe = a2aClient.current.subscribeToTask(
        speaker.agent_code,
        speaker.task_id,
        // onMessage: 流式 delta
        (delta) => {
          setMessages(prev => updateStreamingMessage(prev, speaker, delta))
        },
        // onArtifact
        (name, content) => {
          setMessages(prev => addArtifact(prev, speaker, name, content))
        },
        // onComplete
        (finalText) => {
          setMessages(prev => finalizeMessage(prev, speaker, finalText))
        },
        // onError
        (error) => {
          setMessages(prev => addErrorMessage(prev, speaker, error))
        },
      )
      activeStreams.set(speaker.agent_code, unsubscribe)
    }
  }

  // @点名
  const handleMention = async (agentCode: string, text: string) => {
    const task = await a2aClient.current.sendTask(
      agentCode, meetingId, text
    )
    // 订阅该 Task 的 SSE
    const unsubscribe = a2aClient.current.subscribeToTask(
      agentCode, task.id,
      (delta) => setMessages(prev => updateStreamingMessage(prev, { agent_code: agentCode }, delta)),
      (name, content) => setMessages(prev => addArtifact(prev, { agent_code: agentCode }, name, content)),
      (finalText) => setMessages(prev => finalizeMessage(prev, { agent_code: agentCode }, finalText)),
      (error) => setMessages(prev => addErrorMessage(prev, { agent_code: agentCode }, error)),
    )
  }

  return (
    <div className="meeting-view">
      <MeetingHeader participants={participants} />
      <div className="meeting-messages">
        {messages.map((msg, i) => (
          <MeetingMessageBubble key={i} message={msg} />
        ))}
      </div>
      <MeetingComposer
        participants={participants}
        onSend={handleDiscuss}
        onMention={handleMention}
      />
    </div>
  )
}
```

### 5.3 群聊视图效果

```
┌──────────────────────────────────────────────────────┐
│  📋 会议：登录页重构方案讨论              [×]         │
│  参会人：🏗️架构师 🧪测试 🔍审查                        │
│  协议：A2A v0.3                                       │
│──────────────────────────────────────────────────────│
│                                                      │
│  👤 我  14:02                                         │
│  开个会讨论下登录页重构方案                            │
│                                                      │
│  🎯 小V · 主持人  14:02                               │
│  好的，我依次邀请架构师、测试、审查发言                  │
│                                                      │
│  🏗️ 架构师  14:03  [A2A Task: dispatch:2026-...]      │
│  建议拆成 3 个组件：LoginForm、                        │
│  SocialAuth、PasswordReset。                          │
│  表单校验放 hooks 层...                               │
│  📎 工具调用 (2) ▾                                    │
│                                                      │
│  🧪 测试  14:04  [A2A Task: dispatch:2026-...]        │
│  重点关注：1) 密码框异常态                             │
│  2) 社交登录超时 3) 无障碍标签                         │
│                                                      │
│  🔍 审查  14:05  [A2A Task: dispatch:2026-...]        │
│  代码风格建议统一 error handling...                   │
│                                                      │
│  🎯 小V · 主持人  14:05                               │
│  综合三位的意见：架构上拆 3 组件，                      │
│  测试覆盖异常态，审查关注类型安全。                      │
│                                                      │
│──────────────────────────────────────────────────────│
│  💬 输入消息...              @员工名 点名              │
└──────────────────────────────────────────────────────┘
```

---

## 6. 交互流程

### 6.1 主持人模式序列图

```
sequenceDiagram
    participant U as 用户
    participant FE as 前端 MeetingView
    participant MO as Meeting Orchestrator
    participant A2A as A2A Agent Server (架构师)
    participant ADP as A2A Adapter
    participant RUN as dispatch_task
    participant LG as LangGraph

    U->>FE: "开个会讨论登录页重构"
    FE->>MO: POST /api/meetings/{id}/discuss

    loop 依次调用每个参会人
        MO->>A2A: JSON-RPC tasks/send {goal + context_summary}
        A2A->>ADP: 适配层翻译
        ADP->>RUN: dispatch_task(agent_code, goal, source="a2a_meeting")
        RUN->>LG: engine.think() → _run_langgraph_agent()
        LG-->>RUN: agent loop 运行中

        A2A-->>MO: {task: {id: round_id, subscribeUrl}}

        MO->>A2A: SSE GET .../tasks/{round_id}/stream
        A2A->>ADP: 轮询 proactive:{code} 新消息
        ADP-->>A2A: 翻译成 A2A SSE 事件
        A2A-->>MO: SSE task:message {delta}
        MO-->>FE: SSE 转发

        LG-->>RUN: think 完成
        RUN-->>ADP: round 结果
        ADP-->>A2A: task:completed
        A2A-->>MO: SSE task:completed

        MO->>MO: 更新 context_summary
    end

    MO-->>FE: {speakers: [{agent_code, reply}]}
    FE->>FE: 渲染群聊气泡
```

### 6.2 @点名流程

```
sequenceDiagram
    participant U as 用户
    participant FE as 前端 A2AClient
    participant A2A as A2A Agent Server
    participant ADP as A2A Adapter
    participant RUN as dispatch_task

    U->>FE: "@测试 密码框异常态怎么处理"
    FE->>A2A: JSON-RPC tasks/send {goal="密码框异常态...", session=meeting_id}
    A2A->>ADP: 适配层翻译
    ADP->>RUN: dispatch_task("project-qa", goal, source="a2a_meeting")
    A2A-->>FE: {task: {id: round_id, subscribeUrl}}

    FE->>A2A: SSE 订阅 tasks/{round_id}/stream
    A2A->>ADP: 轮询 proactive:project-qa 新消息
    ADP-->>A2A: 翻译成 A2A SSE 事件
    A2A-->>FE: SSE task:message {delta}  (逐字流式)
    FE->>FE: 渲染测试气泡（流式）

    RUN-->>ADP: think 完成
    ADP-->>A2A: task:completed
    A2A-->>FE: SSE task:completed
    FE->>FE: 标记气泡完成
```

---

## 7. A2A 协议合规性

### 7.1 标准方法实现

| A2A 方法 | 端点 | 状态 | 内部映射 |
|----------|------|------|----------|
| Agent Card 发现 | `GET /.well-known/agent.json` | ✅ | ProactiveRole → Agent Card |
| `tasks/send` | `POST /api/a2a/{code}` JSON-RPC | ✅ | → dispatch_task |
| `tasks/get` | `POST /api/a2a/{code}` JSON-RPC | ✅ | → list_messages(round_id) |
| `tasks/cancel` | `POST /api/a2a/{code}` JSON-RPC | ✅ | → cancel_dispatch |
| `tasks/subscribe` | `POST /api/a2a/{code}` JSON-RPC → SSE | ✅ | → SSE stream |
| Push Notification | `POST /tasks/pushNotification/set` | 🔜 Phase 2 | → WS notify |

### 7.2 Task 状态映射

| A2A State | 触发条件 | EvoFlow 内部状态 |
|-----------|---------|-------------------|
| `submitted` | `tasks/send` 收到，dispatch_task 尚未开始 | round_id 已生成 |
| `working` | dispatch_task 已启动，engine.think 运行中 | LangGraph run active |
| `input-required` | 审批待决（autonomy_level 需要审批） | approval pending |
| `completed` | think() 返回 ThinkResult | round 完成，消息已落库 |
| `canceled` | `tasks/cancel` 调用 | board Task cancelled |
| `failed` | think 超时/递归限制/异常 | round error |

### 7.3 Message Part 类型

| A2A Part Type | 用途 | EvoFlow 来源 |
|---------------|------|-------------|
| `text` | 文本发言 | chat_message.content_text |
| `data` | 结构化数据 | tool_call 结果 JSON |
| `file` | 文件附件 | 员工产出文件路径 |
| `artifact` | 产出物引用 | proactive initiative outcome |

---

## 8. 外部 Agent 扩展（未来）

当外部 A2A 兼容 agent 需要加入会议时：

```
┌──────────────┐    A2A JSON-RPC     ┌──────────────────┐
│ EvoFlow 员工  │◄──────────────────►│ 外部 Agent        │
│ (内部 A2A)    │                    │ (Coze/Dify/...)   │
│              │◄──────SSE──────────│                  │
└──────────────┘                    └──────────────────┘
       ▲
       │ A2A
       ▼
┌──────────────┐
│ Meeting       │  Meeting Orchestrator 不区分内部/外部
│ Orchestrator  │  都通过 A2A 协议调用，统一路径
└──────────────┘
```

**注册外部 agent**：
1. 管理员在「智能体员工」页添加外部 agent，填入 A2A 端点 URL
2. EvoFlow 拉取其 `/.well-known/agent.json` 获取 Agent Card
3. 存入 `evoflow_a2a_external_agents` 表
4. 创建会议时可选外部 agent 作为参会人
5. Meeting Orchestrator 通过 `_resolve_agent_url` 路由到外部 URL

---

## 9. 实施阶段

### Phase 1：A2A Agent Server + 内部适配（MVP）

| 改动 | 文件 | 说明 |
|------|------|------|
| A2A Router | `routers/a2a.py` | Agent Card + JSON-RPC + SSE 端点 |
| A2A Adapter | `a2a/adapter.py` | tasks/send ↔ dispatch_task 翻译 |
| A2A SSE | `a2a/stream.py` | LangGraph stream → A2A SSE 事件翻译 |
| Meeting API | `routers/meetings.py` | 创建/讨论/@点名 |
| Meeting Orchestrator | `a2a/orchestrator.py` | A2A Client，串行调度 |
| Schema migration | `schema_migration_v90.py` | a2a_tasks + meetings 表 |
| A2A Client (前端) | `lib/a2a-client.ts` | SSE 订阅 + JSON-RPC |
| MeetingView | `components/MeetingView.tsx` | 群聊视图 |
| SessionMode | `session-mode.ts` | 新增 meeting 模式 |

**验收**：用户发起会议，3 个员工通过 A2A 协议被调度，SSE 流式气泡出现。

### Phase 2：实时性 + Push Notification

- WS 替代 SSE 轮询
- `tasks/pushNotification/set` 实现
- 并行发言（多个 Task 同时 send）
- Agent Card 主动刷新

### Phase 3：外部 Agent 接入

- 外部 agent 注册 UI
- Agent Card 拉取与缓存
- 跨网络 A2A 调用
- Auth token 鉴权

### Phase 4：高级能力

- Artifact 管理与展示
- 会议纪要导出（A2A Task artifacts 聚合）
- 会议 → Plan 转换
- 语音会议（TTS 逐条朗读）

---

## 10. 文件清单

### 新增文件

```
backend/app/gateway/routers/a2a.py                           # A2A Agent Server
backend/app/gateway/routers/meetings.py                        # Meeting API
backend/packages/harness/evoflow/a2a/__init__.py               # A2A 模块
backend/packages/harness/evoflow/a2a/adapter.py                # 适配层
backend/packages/harness/evoflow/a2a/orchestrator.py            # Meeting Orchestrator
backend/packages/harness/evoflow/a2a/stream.py                  # SSE 翻译
backend/packages/harness/evoflow/a2a/models.py                  # A2A 数据模型
backend/packages/harness/evoflow/a2a/agent_card.py              # Agent Card 生成
backend/packages/harness/evoflow/persistence/schema_migration_v90.py  # 建表
evopanel/src/lib/a2a-client.ts                                 # 前端 A2A Client
evopanel/src/react/components/MeetingView.tsx                  # 群聊视图
evopanel/src/react/components/MeetingMessageBubble.tsx         # 气泡组件
evopanel/src/react/components/MeetingComposer.tsx               # 输入区
```

### 修改文件

```
backend/app/gateway/app.py              # 注册 a2a + meetings router
evopanel/src/react/lib/session-mode.ts   # 新增 meeting 模式
evopanel/src/react/ChatApp.tsx           # meeting 模式入口
```

### 不改的文件（核心！）

```
backend/.../proactive/runner.py          # dispatch_task 完全不改
backend/.../proactive/engine.py          # think() 完全不改
backend/.../proactive/work_items.py      # create_role_work_item 完全不改
backend/.../proactive/router.py         # 现有 proactive API 完全不改
backend/.../tools/builtins/task_tool.py  # subagent 完全不碰
```

---

## 11. 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| A2A 协议还在演进 | 标准可能变 | 适配层隔离，核心不依赖协议细节 |
| 内部 SSE 轮询延迟 | 消息不是即时 | Phase 2 改 LangGraph stream 直推 |
| context_summary 超 token | 后面人上下文太长 | 截断 500 字/人 |
| 员工正忙 | dispatch 被拒 | A2A 返回 input-required，前端提示 |
| 外部 agent 不可达 | 会议卡住 | 超时 + 降级跳过 |
| JSON-RPC 错误处理 | 协议层异常 | 标准 error code (-32001 ~ -32601) |

---

## 12. 与 v1/v2 方案对比

| 维度 | v1 (废弃) | v2 (废弃) | v3 = A2A (本方案) |
|------|-----------|-----------|-------------------|
| 员工运行 | SubagentExecutor 包装 | dispatch_task 直接调 | A2A JSON-RPC → adapter → dispatch_task |
| 协议 | 无 | 无 | A2A 标准 ✅ |
| 外部 agent | 不支持 | 不支持 | 原生支持 ✅ |
| Agent 发现 | 无 | 无 | Agent Card ✅ |
| Task 生命周期 | 无 | 无 | 标准 6 状态 ✅ |
| 流式 | 主控 SSE | 轮询聚合 | A2A SSE ✅ |
| 可扩展性 | 低 | 中 | 高（标准协议） ✅ |
| 实现复杂度 | 中 | 低 | 中高 |
| 协议合规 | 无 | 无 | A2A v0.3 ✅ |
