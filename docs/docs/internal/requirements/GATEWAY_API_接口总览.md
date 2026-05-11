# EvoFlow Gateway API 接口总览

> 来源：`backend/app/gateway/app.py` 及 `backend/app/gateway/routers/*.py`  
> 目的：给桌面端（evopanel/Tauri）提供统一的 Web 协议基准，避免接口语义分叉。

## 目录

- Models
- MCP
- Memory
- Skills
- Artifacts
- Uploads
- Threads
- Agents
- Suggestions
- Channels
- Health


## 1) Models

路由文件：`backend/app/gateway/routers/models.py`  
前缀：`/api/models`

### GET `/api/models`

- **功能**：列出全部可用模型
- **入参**：无
- **出参**：`ModelsListResponse`
  - `models: ModelResponse[]`
    - `name: string`
    - `provider: string`
    - `display_name?: string`
    - `description?: string`
    - `input_types?: string[]`
    - `capabilities?: object`

### GET `/api/models/{model_name}`

- **功能**：获取单个模型详情
- **路径参数**：
  - `model_name: string`
- **出参**：`ModelResponse`（结构同上）


## 2) MCP

路由文件：`backend/app/gateway/routers/mcp.py`  
前缀：`/api/mcp`

### GET `/api/mcp/config`

- **功能**：读取 MCP 配置
- **出参**：`McpConfigResponse`
  - `mcp_servers: Record<string, McpServerConfigResponse>`

### PUT `/api/mcp/config`

- **功能**：更新 MCP 配置
- **入参**：`McpConfigResponse`
  - `mcp_servers: Record<string, McpServerConfigResponse>`
- **出参**：`McpConfigResponse`


## 3) Memory

路由文件：`backend/app/gateway/routers/memory.py`  
前缀：`/api/memory*`

### GET `/api/memory`

- **功能**：获取当前全局记忆数据
- **入参**：无
- **出参**：`MemoryResponse`
  - 常见字段：`user_profile`、`facts[]`、`history[]`（以实际模型为准）

### POST `/api/memory/reload`

- **功能**：重载记忆（刷新缓存）
- **入参**：无
- **出参**：`MemoryResponse`

### DELETE `/api/memory`

- **功能**：清空全部记忆
- **入参**：无
- **出参**：`MemoryResponse`

### DELETE `/api/memory/facts/{fact_id}`

- **功能**：删除指定 fact
- **路径参数**：
  - `fact_id: string`
- **出参**：`MemoryResponse`

### GET `/api/memory/config`

- **功能**：读取记忆配置
- **出参**：`MemoryConfigResponse`
  - 示例字段：`enabled`、`max_history_messages`、`max_injection_tokens`

### GET `/api/memory/status`

- **功能**：一次返回配置 + 数据
- **出参**：`MemoryStatusResponse`
  - `config: MemoryConfigResponse`
  - `data: MemoryResponse`


## 4) Skills

路由文件：`backend/app/gateway/routers/skills.py`  
前缀：`/api/skills*`

### GET `/api/skills`

- **功能**：列出全部技能（public/custom）
- **入参**：无
- **出参**：`SkillsListResponse`
  - `skills: SkillListItem[]`
    - `name: string`
    - `description: string`
    - `source: "public" | "custom"`
    - `enabled: boolean`

### GET `/api/skills/{skill_name}`

- **功能**：技能详情
- **路径参数**：
  - `skill_name: string`
- **出参**：`SkillResponse`

### PUT `/api/skills/{skill_name}`

- **功能**：更新技能（常用于启用/禁用）
- **路径参数**：
  - `skill_name: string`
- **入参**：`SkillUpdateRequest`
  - 常用字段：`enabled?: boolean`
- **出参**：`SkillResponse`

### POST `/api/skills/install`

- **功能**：从 `.skill` 包安装技能
- **入参**：`SkillInstallRequest`
  - `thread_id: string`
  - `filename: string`
- **出参**：`SkillInstallResponse`
  - `success: boolean`
  - `installed_name: string`
  - `message: string`


## 5) Artifacts

路由文件：`backend/app/gateway/routers/artifacts.py`  
前缀：`/api/threads/{thread_id}/artifacts`

### GET `/api/threads/{thread_id}/artifacts/{path:path}`

- **功能**：读取线程产物文件
- **路径参数**：
  - `thread_id: string`
  - `path: string`
- **出参**：文件内容（文本或二进制；根据文件类型 inline 或下载）


## 6) Uploads

路由文件：`backend/app/gateway/routers/uploads.py`  
前缀：`/api/threads/{thread_id}/uploads`

### POST `/api/threads/{thread_id}/uploads`

- **功能**：上传文件到线程目录
- **路径参数**：
  - `thread_id: string`
- **表单参数**：
  - `files: UploadFile[]`
- **出参**：`UploadResponse`
  - `files: Array<{ filename, size, content_type, path }>`
  - `message: string`

### GET `/api/threads/{thread_id}/uploads/list`

- **功能**：列出已上传文件
- **路径参数**：
  - `thread_id: string`
- **出参**：`object`
  - 常见字段：`files[]`

### DELETE `/api/threads/{thread_id}/uploads/{filename}`

- **功能**：删除上传文件
- **路径参数**：
  - `thread_id: string`
  - `filename: string`
- **出参**：`object`
  - 常见字段：`success`、`message`


## 7) Threads

路由文件：`backend/app/gateway/routers/threads.py`  
前缀：`/api/threads`

### DELETE `/api/threads/{thread_id}`

- **功能**：删除 EvoFlow 管理的线程本地文件数据
- **路径参数**：
  - `thread_id: string`
- **出参**：`ThreadDeleteResponse`
  - `success: boolean`
  - `message: string`


## 8) Agents

路由文件：`backend/app/gateway/routers/agents.py`  
前缀：`/api/agents*` 与 `/api/user-profile*`

### GET `/api/agents`

- **功能**：列出所有自定义 Agent
- **入参**：无
- **出参**：`AgentsListResponse`
  - `agents: AgentResponse[]`
    - `name: string`
    - `description: string`
    - `model?: string`
    - `tool_groups?: string[]`
    - `soul?: string`（列表通常不含完整 soul）

### GET `/api/agents/check?name=...`

- **功能**：校验 Agent 名称合法性和可用性
- **查询参数**：
  - `name: string`
- **出参**：
  - `available: boolean`
  - `name: string`（归一化后）

### GET `/api/agents/{name}`

- **功能**：获取单个 Agent 详情（含 SOUL）
- **路径参数**：
  - `name: string`
- **出参**：`AgentResponse`

### POST `/api/agents`

- **功能**：创建 Agent
- **入参**：`AgentCreateRequest`
  - `name: string`（正则 `^[A-Za-z0-9-]+$`，内部转小写）
  - `description?: string`
  - `model?: string`
  - `tool_groups?: string[]`
  - `soul: string`
- **出参**：`AgentResponse`

### PUT `/api/agents/{name}`

- **功能**：更新 Agent
- **路径参数**：
  - `name: string`
- **入参**：`AgentUpdateRequest`
  - `description?: string | null`
  - `model?: string | null`
  - `tool_groups?: string[] | null`
  - `soul?: string | null`
- **出参**：`AgentResponse`

### DELETE `/api/agents/{name}`

- **功能**：删除 Agent 及其文件
- **路径参数**：
  - `name: string`
- **出参**：HTTP 204（无 body）

### GET `/api/user-profile`

- **功能**：读取全局 USER.md
- **出参**：`UserProfileResponse`
  - `content?: string | null`

### PUT `/api/user-profile`

- **功能**：写入全局 USER.md
- **入参**：`UserProfileUpdateRequest`
  - `content: string`
- **出参**：`UserProfileResponse`


## 9) Suggestions

路由文件：`backend/app/gateway/routers/suggestions.py`  
前缀：`/api/threads/{thread_id}/suggestions`

### POST `/api/threads/{thread_id}/suggestions`

- **功能**：根据会话上下文生成后续提问建议
- **路径参数**：
  - `thread_id: string`
- **入参**：`SuggestionsRequest`
  - 常见字段：`messages?: Array<{ role, content }>`
- **出参**：`SuggestionsResponse`
  - `suggestions: string[]`


## 10) Channels

路由文件：`backend/app/gateway/routers/channels.py`  
前缀：`/api/channels`

### GET `/api/channels`

- **功能**：获取全部 IM 渠道状态
- **入参**：无
- **出参**：`ChannelStatusResponse`
  - 典型包含各渠道运行状态与错误信息

### POST `/api/channels/{name}/restart`

- **功能**：重启指定渠道
- **路径参数**：
  - `name: string`
- **出参**：`ChannelRestartResponse`
  - `success: boolean`
  - `message: string`


## 11) Health

定义位置：`backend/app/gateway/app.py`

### GET `/health`

- **说明**：该接口无 `/api` 前缀
- **功能**：Gateway 健康检查
- **出参**：
  - `status: "healthy"`
  - `service: "evo-flow-gateway"`


## 备注

- 本文档以路由定义为准，具体字段细节以对应 `ResponseModel/RequestModel` 为最终标准。
- 桌面端建议统一封装到 `api.*`，并避免混用旧字段（如 `id/identityName/workspace`）和 Web 语义字段（`name/description/model/tool_groups/soul`）。
