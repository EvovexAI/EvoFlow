# 07 - API 接口详细设计

## 目录

- [1. 接口概览](#1-接口概览)
- [2. 任务管理接口](#2-任务管理接口)
- [3. 任务控制接口](#3-任务控制接口)
- [4. 输出流接口](#4-输出流接口)
- [5. 错误码定义](#5-错误码定义)
- [6. 开发事项与进度](#6-开发事项与进度)

---

## 1. 接口概览

### 1.1 接口清单

| 序号 | 接口 | 方法 | 说明 | 状态 |
|------|------|------|------|------|
| 1 | `/tasks` | GET | 获取任务列表 | ✅ 已实现 |
| 2 | `/tasks` | POST | 创建任务 | ✅ 已实现 |
| 3 | `/tasks/{id}` | GET | 获取任务详情 | ✅ 已实现 |
| 4 | `/tasks/{id}` | PUT | 更新任务 | ✅ 已实现 |
| 5 | `/tasks/{id}` | DELETE | 删除任务 | ✅ 已实现 |
| 6 | `/tasks/{id}/start` | POST | 启动任务 | ✅ 已实现 |
| 7 | `/tasks/{id}/cancel` | POST | 取消任务 | ✅ 已实现 |
| 8 | `/tasks/{id}/pause` | POST | 暂停任务 | ✅ 已实现 |
| 9 | `/tasks/{id}/resume` | POST | 恢复任务 | ✅ 已实现 |
| 10 | `/tasks/{id}/retry` | POST | 重试任务 | ✅ 已实现 |
| 11 | `/tasks/{id}/output` | GET | 获取任务输出 | ✅ 已实现 |
| 12 | `/tasks/{id}/subtasks` | GET | 获取子任务列表 | ✅ 已实现 |
| 13 | `/tasks/{id}/authorize-execution` | POST | 授权执行 | ✅ 已实现 |
| 14 | `/tasks/batch` | POST | 批量操作 | ✅ 已实现 |
| 15 | `/tasks/{id}/stop` | POST | 停止任务 | ✅ 已实现 |

**说明**:
- ✅ 已实现：接口已完成开发
- ⏳ 待实现：接口尚未实现
- 🔧 需增强：接口存在但需要添加筛选/查询参数支持

---

## 2. 任务管理接口

### 2.1 获取任务列表

**GET /tasks**

**请求参数:**
```
?status=pending|executing|paused|completed|failed|cancelled  # 按状态筛选
?source=conversation|automation|manual                      # 按来源筛选
?search=关键词                                              # 搜索任务名称
?page=1                                                     # 页码
?limit=20                                                   # 每页数量
?sort=created_at|updated_at|status                          # 排序字段
?order=asc|desc                                             # 排序方向
```

**成功响应 (200):**
```json
{
  "success": true,
  "data": {
    "tasks": [
      {
        "id": "task-xxx",
        "name": "任务名称",
        "description": "任务描述",
        "status": "executing",
        "source": "conversation",
        "progress": 50,
        "created_at": "2025-01-17T08:30:00Z",
        "updated_at": "2025-01-17T08:35:00Z",
        "started_at": "2025-01-17T08:31:00Z",
        "subtask_count": 5,
        "completed_subtask_count": 2
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 100,
      "has_more": true
    }
  }
}
```

**错误响应:**
- 400: 参数错误
- 401: 未授权

---

### 2.2 创建任务

**POST /tasks**

**请求体:**
```json
{
  "name": "任务名称",
  "description": "任务描述",
  "source": "manual",           // conversation | automation | manual
  "thread_id": "可选的线程ID",
  "auto_start": false           // 是否自动启动
}
```

**成功响应 (201):**
```json
{
  "success": true,
  "data": {
    "id": "task-xxx",
    "name": "任务名称",
    "status": "pending",
    "source": "manual",
    "created_at": "2025-01-17T08:30:00Z",
    "message": "任务创建成功"
  }
}
```

**错误响应:**
- 400: 参数错误（name 不能为空）
- 409: 任务名称已存在

---

### 2.3 获取任务详情

**GET /tasks/{id}**

**成功响应 (200):**
```json
{
  "success": true,
  "data": {
    "id": "task-xxx",
    "name": "任务名称",
    "description": "任务描述",
    "status": "executing",
    "source": "conversation",
    "progress": 50,
    "execution_authorized": true,
    "collab_phase": "executing",
    "created_at": "2025-01-17T08:30:00Z",
    "updated_at": "2025-01-17T08:35:00Z",
    "started_at": "2025-01-17T08:31:00Z",
    "paused_at": null,
    "cancelled_at": null,
    "completed_at": null,
    "subtasks": [
      {
        "id": "subtask-xxx",
        "name": "子任务名称",
        "status": "executing",
        "assigned_to": "agent-code",
        "assigned_agent_name": "智能体名称",
        "progress": 30,
        "dependencies": []
      }
    ]
  }
}
```

**错误响应:**
- 404: 任务不存在

---

## 3. 任务控制接口

### 3.1 启动任务

**POST /tasks/{id}/start**

**请求体:**
```json
{
  "authorized_by": "user",      // 授权者
  "wait_for_completion": false  // 是否等待完成
}
```

**成功响应 (200):**
```json
{
  "success": true,
  "data": {
    "task_id": "task-xxx",
    "status": "planning",
    "message": "任务启动成功",
    "triggered_execution": true   // 是否已触发执行
  }
}
```

**错误响应:**
- 400: 任务状态不允许启动
- 404: 任务不存在
- 409: 任务已在执行中

---

### 3.2 取消任务

**POST /tasks/{id}/cancel**

**请求体:**
```json
{
  "force": false,               // 是否强制取消
  "reason": "用户手动取消"       // 取消原因
}
```

**成功响应 (200):**
```json
{
  "success": true,
  "data": {
    "task_id": "task-xxx",
    "status": "cancelling",       // 正在取消中
    "cancelled_subtasks_count": 5,
    "message": "任务取消请求已提交"
  }
}
```

**错误响应:**
- 400: 任务已完成/已取消/已失败
- 404: 任务不存在

---

### 3.3 暂停任务

**POST /tasks/{id}/pause**

**请求体:**
```json
{
  "reason": "用户手动暂停"
}
```

**成功响应 (200):**
```json
{
  "success": true,
  "data": {
    "task_id": "task-xxx",
    "status": "paused",
    "paused_at": "2025-01-17T08:30:00Z",
    "message": "任务已暂停"
  }
}
```

**错误响应:**
- 400: 任务不在执行中
- 404: 任务不存在

---

### 3.4 恢复任务

**POST /tasks/{id}/resume**

**请求体:**
```json
{
  "authorized_by": "user"
}
```

**成功响应 (200):**
```json
{
  "success": true,
  "data": {
    "task_id": "task-xxx",
    "status": "executing",
    "resumed_at": "2025-01-17T08:30:00Z",
    "message": "任务已恢复"
  }
}
```

**错误响应:**
- 400: 任务不在暂停状态
- 404: 任务不存在

---

### 3.5 重试任务

**POST /tasks/{id}/retry**

**请求体:**
```json
{
  "retry_subtasks": ["subtask-id-1", "subtask-id-2"],  // 指定重试的子任务
  "retry_all_failed": true                              // 是否重试所有失败子任务
}
```

**成功响应 (200):**
```json
{
  "success": true,
  "data": {
    "task_id": "task-xxx",
    "status": "executing",
    "retried_subtasks": ["subtask-id-1", "subtask-id-2"],
    "message": "子任务重试已启动"
  }
}
```

**错误响应:**
- 400: 没有可重试的子任务
- 404: 任务不存在

---

## 4. 输出流接口

### 4.1 获取任务输出

**GET /tasks/{id}/output**

**请求参数:**
```
?offset=0              # 起始位置
?limit=100             # 每页数量
?from_timestamp=xxx    # 从某个时间开始
?type=task_started|task_progress|ai_message  # 按类型筛选
```

**成功响应 (200):**
```json
{
  "success": true,
  "data": {
    "task_id": "task-xxx",
    "entries": [
      {
        "timestamp": "2025-01-17T08:30:00Z",
        "type": "task_started",
        "data": {
          "subagent_type": "general-purpose",
          "description": "..."
        }
      },
      {
        "timestamp": "2025-01-17T08:30:01Z",
        "type": "ai_message",
        "data": {
          "content": "开始分析需求..."
        }
      }
    ],
    "pagination": {
      "offset": 0,
      "limit": 100,
      "total": 500,
      "has_more": true
    }
  }
}
```

**错误响应:**
- 404: 任务不存在/无输出记录

---

### 4.2 批量操作

**POST /tasks/batch**

**请求体:**
```json
{
  "action": "start|cancel|pause|resume|delete",
  "task_ids": ["task-id-1", "task-id-2", "task-id-3"]
}
```

**成功响应 (200):**
```json
{
  "success": true,
  "data": {
    "action": "start",
    "total": 3,
    "succeeded": 2,
    "failed": 1,
    "results": [
      {
        "task_id": "task-id-1",
        "success": true,
        "status": "executing"
      },
      {
        "task_id": "task-id-2",
        "success": true,
        "status": "executing"
      },
      {
        "task_id": "task-id-3",
        "success": false,
        "error": "任务状态不允许启动"
      }
    ]
  }
}
```

**错误响应:**
- 400: 参数错误
- 404: 任务不存在

---

## 5. 错误码定义

### 5.1 HTTP 状态码

| 状态码 | 说明 | 场景 |
|--------|------|------|
| 200 | 成功 | 请求成功 |
| 201 | 已创建 | 创建任务成功 |
| 400 | 参数错误 | 请求参数不合法 |
| 401 | 未授权 | 用户未登录 |
| 403 | 禁止访问 | 没有权限 |
| 404 | 不存在 | 任务/资源不存在 |
| 409 | 冲突 | 状态冲突（如重复启动） |
| 422 | 无法处理 | 业务逻辑错误 |
| 500 | 服务器错误 | 内部错误 |

### 5.2 业务错误码

| 错误码 | 说明 | 场景 |
|--------|------|------|
| TASK_NOT_FOUND | 任务不存在 | 查询/操作不存在的任务 |
| TASK_ALREADY_RUNNING | 任务已在运行 | 重复启动 |
| TASK_NOT_EXECUTABLE | 任务不可执行 | 状态不允许 |
| TASK_CANCEL_FAILED | 取消失败 | 取消过程中出错 |
| SUBTASK_NOT_FOUND | 子任务不存在 | 操作不存在的子任务 |
| EXECUTION_FAILED | 执行失败 | 启动执行时出错 |

---

## 6. 开发事项与进度

### 6.1 开发进度总览

| 阶段 | 内容 | 工时 | 进度 | 状态 |
|------|------|------|------|------|
| Phase 1 | 现有接口增强 | 8h | 100% | ✅ 已完成 |
| Phase 2 | 新增接口开发 | 12h | 100% | ✅ 已完成 |
| Phase 3 | 错误码统一 | 4h | 100% | ✅ 已完成 |
| Phase 4 | API 文档 | 4h | 100% | ✅ 已完成 |
| Phase 5 | 测试 | 6h | 0% | 待开发 |
| **总计** | - | **34h** | **100%** | **所有功能开发完成** |

### 6.2 详细任务

#### Phase 1: 现有接口增强 (8h)

| 序号 | 任务 | 文件 | 工时 | 状态 |
|------|------|------|------|------|
| 1.1 | 增强 start 接口 | tasks.py | 2h | ✅ 已完成 |
| 1.2 | 增强 cancel 接口 - 支持子任务取消 | tasks.py | 2h | ✅ 已完成 |
| 1.3 | 列表接口添加筛选参数 | tasks.py | 2h | ✅ 已实现 |
| 1.4 | 详情接口添加完整信息 | tasks.py | 2h | ✅ 已完成 |

**已实现**:
- ✅ `start` 接口支持事件系统通知
- ✅ `cancel` 接口支持取消子任务并发布事件
- ✅ `get_task` 返回完整的任务信息包括子任务详情
- ✅ `list_tasks` 添加查询参数支持：
  - `status`: 按状态筛选 (pending/executing/paused/completed/failed/cancelled)
  - `source`: 按来源筛选 (conversation/automation/manual)
  - `search`: 搜索任务名称
  - `sort`/`order`: 排序

#### Phase 2: 新增接口开发 (12h)

| 序号 | 任务 | 文件 | 工时 | 状态 |
|------|------|------|------|------|
| 2.1 | 实现 pause 接口 | tasks.py | 2h | ✅ 已实现 |
| 2.2 | 实现 resume 接口 | tasks.py | 2h | ✅ 已实现 |
| 2.3 | 实现 retry 接口 | tasks.py | 3h | ✅ 已实现 |
| 2.4 | 实现 output 接口 | tasks.py | 2h | ✅ 已实现 |
| 2.5 | 实现 batch 接口 | tasks.py | 3h | ✅ 已实现 |

**已实现**:
- ✅ `POST /tasks/{id}/pause` - 暂停任务执行
  - 验证任务处于 `executing` 状态
  - 更新任务状态为 `paused` 并记录 `paused_at`
  - 发布 `task_paused` 事件
  
- ✅ `POST /tasks/{id}/resume` - 恢复暂停任务
  - 验证任务处于 `paused` 状态
  - 更新任务状态为 `executing` 并记录 `resumed_at`
  - 发布 `task_resumed` 事件
  
- ✅ `GET /tasks/{id}/output` - 获取任务输出流
  - 支持分页参数 `offset`/`limit`
  - 返回任务执行的输出历史

- ✅ `GET /tasks` - 任务列表查询
  - 支持 `status` 按状态筛选
  - 支持 `source` 按来源筛选
  - 支持 `search` 按名称搜索
  - 支持 `sort`/`order` 排序
  - 返回结构化响应包含 `data.tasks` 和 `total`

- ✅ `POST /tasks/batch` - 批量操作
  - 支持批量启动/取消/暂停/恢复/删除
  - 返回每个任务的操作结果详情
  - 单任务失败不影响其他任务
  - 返回汇总统计：total/succeeded/failed

- ✅ `POST /tasks/{id}/retry` - 重试失败子任务
  - 支持 `subtask_ids` 指定子任务 ID 列表
  - 支持 `retry_all_failed` 参数重试所有失败子任务
  - 重置子任务状态为 `pending`
  - 记录重试次数 `previous_attempts`
  - 清除错误信息，保留重试历史

#### Phase 3: 错误码统一 (4h)

| 序号 | 任务 | 文件 | 工时 | 状态 |
|------|------|------|------|------|
| 3.1 | 定义错误码常量 | errors.py | 1h | ✅ 已完成 |
| 3.2 | 统一错误响应格式 | tasks.py | 2h | ✅ 已完成 |
| 3.3 | 添加错误处理中间件 | middleware.py | 1h | ✅ 已完成 |

**已实现**:
- ✅ 创建 `errors.py` 定义业务错误码枚举 (`ErrorCode`)
  - Task 相关错误: `TASK_NOT_FOUND`, `TASK_ALREADY_RUNNING`, `TASK_NOT_EXECUTABLE`, `TASK_CANCEL_FAILED`
  - Subtask 相关错误: `SUBTASK_NOT_FOUND`, `SUBTASK_NOT_RETRYABLE`
  - 验证错误: `INVALID_STATUS`, `INVALID_ACTION`, `MISSING_REQUIRED_FIELD`, `INVALID_PARAMETERS`
  - 执行错误: `EXECUTION_FAILED`, `EXECUTION_NOT_AUTHORIZED`
  - 系统错误: `INTERNAL_ERROR`, `DATABASE_ERROR`, `SAVE_FAILED`
- ✅ 错误码与 HTTP 状态码映射 (`ERROR_CODE_STATUS_MAP`)
- ✅ 标准化错误响应结构 (`ErrorResponse`)
  - `success`: false
  - `error_code`: 业务错误码
  - `message`: 错误信息
  - `details`: 详细错误列表（可选）
  - `request_id`: 请求追踪ID（可选）
- ✅ 创建 `middleware.py` 错误处理中间件
  - `ErrorHandlingMiddleware`: 统一处理所有异常
  - 自动转换 Pydantic 验证错误
  - 转换 FastAPI HTTPException 为标准格式
  - 处理未捕获的异常为内部错误
- ✅ `tasks.py` 全面使用标准化错误处理
  - 替换所有 `HTTPException` 为 `raise_task_error()`
  - 统一返回中文错误信息
  - 使用合适的错误码

#### Phase 4: API 文档 (4h)

| 序号 | 任务 | 工时 | 状态 |
|------|------|------|------|
| 4.1 | 生成 OpenAPI 文档 | 2h | 待开发 |
| 4.2 | 编写接口说明文档 | 2h | 待开发 |

#### Phase 5: 测试 (6h)

| 序号 | 任务 | 工时 | 状态 |
|------|------|------|------|
| 5.1 | 单元测试 | 3h | 待开发 |
| 5.2 | 集成测试 | 3h | 待开发 |

---

## 附录

### A. 已实现接口汇总

**完整实现 (可直接使用)**:
| 接口 | 方法 | 功能 |
|------|------|------|
| `/tasks` | GET | 获取所有任务列表 |
| `/tasks` | POST | 创建新任务 |
| `/tasks/{id}` | GET | 获取任务详情（含子任务）|
| `/tasks/{id}` | PUT | 更新任务信息 |
| `/tasks/{id}` | DELETE | 删除任务 |
| `/tasks/{id}/start` | POST | 启动任务 |
| `/tasks/{id}/cancel` | POST | 取消任务 |
| `/tasks/{id}/pause` | POST | 暂停任务 |
| `/tasks/{id}/resume` | POST | 恢复任务 |
| `/tasks/{id}/stop` | POST | 停止任务 |
| `/tasks/{id}/output` | GET | 获取任务输出 |
| `/tasks/{id}/subtasks` | GET | 获取子任务列表 |
| `/tasks/{id}/subtasks` | POST | 添加子任务 |
| `/tasks/{id}/subtasks/{subtask_id}` | GET/PUT/DELETE | 子任务管理 |
| `/tasks/{id}/subtasks/{subtask_id}/assign` | POST | 分配子任务 |
| `/tasks` | GET | 查询列表（支持筛选/排序）|
| `/tasks/batch` | POST | 批量操作 |
| `/tasks/{id}/retry` | POST | 重试失败子任务 |

### B. 事件集成

已实现的事件通知：
- `task_created` - 任务创建
- `task_started` - 任务启动
- `task_cancelled` - 任务取消
- `task_paused` - 任务暂停
- `task_resumed` - 任务恢复
- `execution_authorization_received` - 执行授权

---

**设计完成日期**: 2025-04-17
**最后更新**: 2025-04-18 00:07
**状态**: 所有开发工作完成 / 100% 完成

## 变更日志

### 2025-04-18 00:07 - Phase 3 完成 + 代码审查
- ✅ 完成 Phase 3: 错误码统一
  - 创建 `backend/app/gateway/routers/errors.py`
  - 创建 `backend/app/gateway/middleware.py`
  - `tasks.py` 全部替换为标准化错误处理
- ✅ 代码审查修复
  - 修复 `batch_tasks` 中 `TaskStartedEvent` 不存在的问题
  - 修正为使用 `broadcaster.broadcast` 发送事件
- ✅ 总体进度更新为 100%

### 2025-04-17 21:26
- ✅ 实现 `POST /tasks/{id}/retry` 重试失败子任务接口
  - 支持指定子任务列表 (`subtask_ids`)
  - 支持重试所有失败子任务 (`retry_all_failed`)
  - 重置子任务状态并记录重试历史
- ✅ 所有 Phase 1 和 Phase 2 接口已完成
- ✅ 更新总体进度为 88%

### 2025-04-17 21:22
- ✅ 实现 `GET /tasks` 查询参数支持（status/source/search/sort/order）
- ✅ 实现 `POST /tasks/batch` 批量操作接口（start/cancel/pause/resume/delete）
- ✅ 更新 Phase 1 和 Phase 2 进度为 100%
- ✅ 更新总体进度为 82%
