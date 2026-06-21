# 00 - EvoFlow 任务执行系统设计分析文档

## 目录

- [1. 任务创建来源分析](#1-任务创建来源分析)
  - [1.1 来源一：用户对话中模型创建](#11-来源一用户对话中模型创建)
  - [1.2 来源二：定时任务](#12-来源二定时任务)
  - [1.3 来源三：用户手动创建](#13-来源三用户手动创建)
  - [1.4 核心差异对比](#14-核心差异对比)
- [2. 当前系统现状](#2-当前系统现状)
  - [2.1 任务状态模型](#21-任务状态模型)
  - [2.2 协作阶段模型](#22-协作阶段模型)
  - [2.3 当前任务执行流程](#23-当前任务执行流程)
- [3. 问题分析](#3-问题分析)
  - [3.1 当前启动按钮的问题](#31-当前启动按钮的问题)
  - [3.2 状态同步问题](#32-状态同步问题)
  - [3.3 进度查看问题](#33-进度查看问题)
- [4. 使用场景分析](#4-使用场景分析)
  - [4.1 场景一：对话页发起任务](#41-场景一对话页发起任务)
  - [4.2 场景二：RunManager 管理任务](#42-场景二runmanager-管理任务)
  - [4.3 场景三：查看历史任务](#43-场景三查看历史任务)
- [5. 核心问题定义](#5-核心问题定义)
- [6. 现有机制调研](#6-现有机制调研)
- [7. 设计方案建议](#7-设计方案建议)
- [8. 建议的实现顺序](#8-建议的实现顺序)
- [9. 关键设计洞察](#9-关键设计洞察)
- [10. 待决策问题](#10-待决策问题)
- [11. 相关代码文件清单](#11-相关代码文件清单)
- [12. 总结与行动建议](#12-总结与行动建议)


## 1. 任务创建来源分析

### 1.1 来源一：用户对话中模型创建（当前主要方式）
```
用户在 ChatApp 输入: "帮我写一个 Python 爬虫"
    ↓
Lead Agent 接收消息
    ↓
Lead Agent 调用 supervisor_tool(action="create_task_with_subtasks")
    ↓
Supervisor 自动分析并创建多个子任务
    ↓
例如:
    - 子任务1: 分析需求 (general-purpose)
    - 子任务2: 编写爬虫代码 (bash/code)
    - 子任务3: 测试运行 (bash)
    ↓
自动进入规划阶段 → 等待用户授权 → 开始执行
```

**特点:**
- 完全由 AI 自主决策子任务划分
- 可能创建很多子任务（复杂任务）
- Supervisor 作为"调度者"角色
- 用户只能通过对话交互，无直接控制

### 1.2 来源二：定时任务（Automation）
```
定时触发器（Cron）
    ↓
调用 agents API 创建任务
    ↓
同样走 supervisor 流程
    ↓
自动执行（可能不需要用户授权）
```

**特点:**
- 系统自动触发，无用户交互
- 需要预设任务模板
- 执行结果可能需要通知用户

### 1.3 来源三：用户干预控制（RunManager - 目标方式）
```
AI（对话/定时）创建了任务和子任务
    ↓
用户在 RunManager 查看任务状态
    ↓
用户操作:
    - 启动: 开始执行待处理的任务
    - 暂停: 暂停正在执行的任务
    - 恢复: 继续暂停的任务
    - 取消: 彻底终止任务
    - 重试: 重新执行失败的子任务
    ↓
用户作为"人工项目经理"干预 AI 的自动调度
```

**特点:**
- AI 负责任务创建和子任务拆分（来源一或二）
- 用户负责监督和控制执行过程
- 用户不直接创建任务，而是管理 AI 创建的任务
- 提供人工干预能力：暂停、恢复、取消、重试
- 实时查看进度和输出，但不替代 AI 的决策

### 1.4 核心差异对比

| 维度 | 对话创建 | 定时任务 | 用户干预 |
|------|----------|----------|----------|
| 触发者 | AI 模型 | 系统定时器 | 用户（控制已有任务） |
| 任务创建 | AI 自动创建 | 系统按模板创建 | 不创建，只控制 |
| 子任务数量 | AI 自动决策 | 模板预设 | 不干预拆分 |
| 启动方式 | AI 自动/对话授权 | 自动启动 | 用户点击启动 |
| 控制粒度 | 粗（对话级别） | 无 | 细（任务级别） |
| 查看进度 | TaskSidebar | 日志/通知 | RunManager |
| 干预能力 | 低（只能通过对话） | 无 | 高（暂停/恢复/取消/重试） |

## 2. 当前系统现状

### 2.1 任务状态模型
```python
class TaskStatus(str, Enum):
    PENDING = "pending"      # 待开始
    PLANNING = "planning"    # 规划中
    PLANNED = "planned"      # 已规划
    EXECUTING = "executing"  # 执行中
    PAUSED = "paused"        # 已暂停
    COMPLETED = "completed"  # 已完成
    FAILED = "failed"        # 失败
    CANCELLED = "cancelled"  # 已取消
```

### 2.2 协作阶段模型 (CollabPhase)
```python
class CollabPhase(str, Enum):
    IDLE = "idle"              # 空闲
    REQ_CONFIRM = "req_confirm" # 请求确认
    PLANNING = "planning"      # 规划中
    PLAN_READY = "plan_ready"  # 规划就绪
    AWAITING_EXEC = "awaiting_exec" # 等待执行
    EXECUTING = "executing"    # 执行中
    DONE = "done"              # 已完成
```

### 2.3 当前任务执行流程
```
用户创建任务
    ↓
POST /tasks/{id}/start → 状态: planning
    ↓
Supervisor 分析并创建子任务
    ↓
POST /tasks/{id}/authorize-execution → 状态: executing
    ↓
Supervisor 调用 start_execution 委派子任务
    ↓
task_tool 在后台执行子任务
    ↓
子任务完成 → 更新主任务进度
    ↓
所有子任务完成 → 主任务 completed
```

## 3. 问题分析

### 3.1 当前启动按钮的问题
- 只调用了 `start` 和 `authorize-execution`，但后者只是设置授权标志
- 真正开始执行需要 Supervisor 调用 `start_execution` tool
- 缺少触发 Supervisor 主动执行的机制

### 3.2 状态同步问题
- 任务状态存储在 `project_storage` (JSON 文件)
- 协作状态存储在 `collab_state.json`
- LangGraph 运行状态在内存中
- 三者缺乏实时同步机制

### 3.3 进度查看问题
- 子任务进度通过 `task_progress_snapshot` 保存
- 但实时输出流没有持久化
- 用户关闭页面后无法查看历史输出

## 4. 使用场景分析

### 4.1 场景一：对话页发起任务
```
用户在 ChatApp 输入: "帮我写一个 Python 爬虫"
    ↓
Lead Agent 创建任务
    ↓
用户看到任务卡片
    ↓
用户关闭页面 / 点击停止
    ↓
问题: 任务在后台继续运行还是停止？
    ↓
用户重新打开页面如何查看进度？
```

**关键问题:**
1. 关闭页面 = 只是断开 WebSocket，LangGraph 线程仍在运行
2. 点击停止 = 需要明确是"暂停"还是"取消"
3. 重新打开 = 需要从存储中恢复状态

### 4.2 场景二：RunManager 管理任务
```
用户在 RunManager 看到任务列表
    ↓
点击"启动" → 任务开始执行
    ↓
用户想暂停任务
    ↓
用户想恢复任务
    ↓
用户想取消任务（彻底停止）
```

**关键问题:**
1. 暂停 = 停止新子任务派发，正在运行的子任务怎么办？
2. 恢复 = 重新触发 Supervisor 还是继续子任务？
3. 取消 = 如何终止正在运行的 LangGraph 线程？

### 4.3 场景三：查看历史任务
```
用户查看已完成的任务
    ↓
想看当时的完整对话/输出
    ↓
想看子任务的执行详情
```

**关键问题:**
1. 输出流是否持久化？
2. 子任务执行记录保存在哪里？
3. 如何回放或展示历史执行过程？

## 5. 核心问题定义

### 5.1 什么是"真正启动"任务？
当前流程:
1. `start` → planning 状态
2. `authorize-execution` → 设置 execution_authorized=true

但 Supervisor 还没有开始执行！

**解决方案选项:**
- A. `authorize-execution` 后主动触发 Supervisor 运行
- B. Supervisor 轮询检查 execution_authorized
- C. 使用事件机制通知 Supervisor

### 5.2 如何"彻底取消"任务？
当前 `cancel` 接口只改状态，但:
- 正在运行的子任务线程仍在执行
- LangGraph 线程仍在运行
- 子任务的 background_task 仍在运行

**需要:**
1. 取消所有子任务的运行
2. 终止 LangGraph 线程
3. 清理 background tasks

### 5.3 如何"暂停/恢复"任务？
暂停:
- 停止新的子任务派发
- 正在运行的子任务？
  - 选项 A: 让它们完成
  - 选项 B: 也暂停它们

恢复:
- 重新触发 Supervisor 执行
- 继续未完成的子任务

## 6. 现有机制调研

### 6.1 子任务执行机制
```python
# task_tool.py
delegate_to_task_tool() → 创建 SubagentExecutor
    ↓
executor.submit() → 返回 background_task
    ↓
后台异步执行子任务
    ↓
通过 bridge 回调更新父任务状态
```

### 6.2 检查点机制 (Checkpointer)
- LangGraph 支持 checkpoint 状态保存
- 可以恢复线程状态
- 但不确定是否用于任务恢复

### 6.3 事件机制
```python
# events.py
emit_task_progress()    # 进度更新
emit_task_completed()   # 任务完成
```
- 通过 WebSocket 推送给前端
- 但页面关闭后无法接收

### 6.4 存储机制
```
{EVOFLOW_HOME}/data/app/evoflow.db
├── evoflow_collab_tasks / evoflow_collab_subtasks   # 任务与子任务
├── evoflow_task_details                             # 任务记忆（可选写入）
├── evoflow_thread_collab                            # 线程协作态
└── evoflow_chat_sessions / evoflow_chat_messages    # 会话与消息 token

{EVOFLOW_HOME}/data/observability/evoflow_observability.db
└── evoflow_obs_model_invocations / evoflow_obs_tool_invocations  # 可观测指标
```

## 7. 设计方案建议

### 7.1 启动任务（修复当前问题）
```
用户点击"启动"
    ↓
POST /tasks/{id}/start
    ↓
返回成功（planning）
    ↓
WebSocket 推送: task_started
    ↓
Supervisor 自动被触发（如何触发？）
    ↓
Supervisor 分析 → 创建子任务
    ↓
自动调用 authorize-execution
    ↓
Supervisor 调用 start_execution
    ↓
子任务开始执行
```

**关键:** 需要一种机制在 `start` 后自动触发 Supervisor

### 7.2 任务控制（暂停/恢复/取消）
```
暂停任务:
    POST /tasks/{id}/pause
    1. 设置状态: paused
    2. 设置 collab_phase: AWAITING_EXEC
    3. 通知 Supervisor 停止派发新子任务
    4. （可选）暂停正在运行的子任务

恢复任务:
    POST /tasks/{id}/resume
    1. 设置状态: executing
    2. 设置 collab_phase: EXECUTING
    3. 触发 Supervisor 继续执行

取消任务:
    POST /tasks/{id}/cancel（已存在，需增强）
    1. 设置状态: cancelled
    2. 设置 collab_phase: DONE
    3. 终止所有子任务的 background_task
    4. （可选）终止 LangGraph 线程
```

### 7.3 实时进度查看
```
方案 A: WebSocket 实时推送（当前）
    - 优点: 实时性好
    - 缺点: 页面关闭后丢失

方案 B: 轮询查询（RunManager 当前）
    - 优点: 简单
    - 缺点: 不实时，有延迟

方案 C: 流式输出持久化
    - 输出流写入文件
    - 前端可加载历史输出
    - 支持"实时+回放"模式
```

### 7.4 页面关闭/重新打开
```
用户关闭页面:
    - WebSocket 断开
    - 但任务在后台继续运行
    - 这是期望的行为（异步任务）

用户重新打开页面:
    - 加载任务列表（包含运行中的任务）
    - 点击任务查看详情
    - 加载 collab_state 恢复状态
    - 连接 WebSocket 接收实时更新
    - 加载历史输出（如已实现持久化）

用户点击"停止"按钮:
    - 明确区分: 暂停 / 取消
    - 暂停: 后台保留，可恢复
    - 取消: 彻底终止
```

## 8. 需要调研的问题

### 8.1 如何触发 Supervisor 执行？
- Supervisor 是 Lead Agent 的一部分？
- 还是独立的智能体？
- 如何主动向 Supervisor 发送消息？

### 8.2 如何终止 LangGraph 线程？
- LangGraph 是否有取消/终止 API？
- 如何优雅地停止正在运行的图？

### 8.3 子任务 background_task 如何取消？
- `asyncio.Task` 可以取消
- 但子任务可能运行在另一个线程/进程
- 需要调研 `SubagentExecutor` 的实现

### 8.4 输出流持久化如何实现？
- 写入文件？数据库？
- 如何分块加载大输出？
- 如何实时追加新输出？

## 9. 建议的实现顺序

### 9.1 阶段 1: 修复启动功能（当前最高优先级）
1. 调研 Supervisor 触发机制
2. 实现 `start` 后自动触发 Supervisor
3. 测试完整启动流程

### 9.2 阶段 2: 增强取消功能
1. 调研子任务终止机制
2. 实现彻底取消（终止子任务）
3. 测试取消功能

### 9.3 阶段 3: 暂停/恢复功能
1. 设计暂停/恢复语义
2. 实现 pause/resume 接口
3. 前端添加对应按钮

### 9.4 阶段 4: 输出持久化
1. 设计输出存储格式
2. 实现流式写入
3. 前端支持加载历史输出

### 9.5 阶段 5: 完善用户体验
1. 页面关闭/重连处理
2. 任务恢复机制
3. 更详细的进度展示

## 10. 关键设计洞察

### 10.1 Supervisor 不是"人类调度者"
**当前认知误区:**
- 以为 Supervisor 是一个持续运行的 AI 调度者
- 实际上它只是 Lead Agent 调用的工具集合

**真相:**
```
Supervisor = Tools (create_task, start_execution, monitor...)
调度者 = Lead Agent（通过 Prompt + 工具调用实现）
```

**问题:**
- Lead Agent 同时还要处理对话，负担过重
- 无法实现真正的"后台持续调度"
- 用户关闭页面后，调度逻辑消失

### 10.2 三种任务来源的本质差异

**对话任务** - AI 主导，用户被动
- AI: "我帮你拆成5个子任务"
- 用户: "好的"
- 适合: 复杂任务，用户不想管细节

**手动任务** - 用户主导，AI 辅助
- 用户: "我只要1个子任务，快执行"
- AI: "好的，执行中..."
- 适合: 简单任务，用户要控制

**定时任务** - 系统主导，无人值守
- 系统: "定时触发，自动执行"
- 适合: 周期性任务

### 10.3 "人类调度者"的真正含义

用户想要的不是技术层面的"常驻进程"，而是**体验层面的"有人管"**:

| 体验 | 技术实现 |
|------|----------|
| 能看到"调度中"状态 | UI 显示 collab_phase |
| 能随时查看进度 | 轮询 / WebSocket |
| 能暂停/恢复 | API 接口 + 状态管理 |
| 失败能重试 | 重试机制 |
| 能看谁在干什么 | 子任务列表 + 智能体名称 |

**结论:** 先做体验，后做架构。当前技术可以实现大部分体验，不需要大改架构。

## 11. 待决策问题

### 11.1 核心架构问题

1. **是否需要常驻的 Supervisor Agent？**
   - A: 需要（方案A），独立进程做调度
   - B: 不需要（当前），Lead Agent 兼任
   - C: 轻量级（方案C），代码调度器
   - **建议: C → 后期考虑 A**

2. **暂停时是否终止正在运行的子任务？**
   - A: 不终止，只停止新派发（简单）
   - B: 也暂停/终止（复杂，需要子任务支持）
   - **建议: A（先实现简单方案）**

3. **如何实现"简单任务"（1个子任务）的快速执行？**
   - A: 特殊流程，跳过复杂调度
   - B: 统一流程，但自动优化
   - **建议: A，在 Supervisor 中加快速路径**

### 11.2 功能优先级

| 优先级 | 功能 | 说明 |
|--------|------|------|
| P0 | 修复启动功能 | 当前点击启动无效 |
| P0 | 实现彻底取消 | 终止子任务线程 |
| P1 | 暂停/恢复 | 用户体验关键 |
| P1 | 输出持久化 | 页面关闭后可回看 |
| P2 | 单个子任务重试 | 失败处理 |
| P2 | 简单任务快速执行 | 1个子任务优化 |
| P3 | 常驻 Supervisor | 架构升级 |

### 11.3 其他问题

4. **输出流存储在哪里？**
   - A: 文件系统（简单，大容量）
   - B: 数据库（查询方便）
   - C: 混合（元数据存数据库，内容存文件）

5. **如何标识用户发起的任务 vs 系统自动任务？**
   - source 字段: "conversation" | "automation" | "manual"

6. **任务失败后的重试机制？**
   - 手动重试（先实现）
   - 自动重试（后期）

## 12. 相关代码文件清单

### 后端核心文件
- `backend/app/gateway/routers/tasks.py` - 任务 API
- `backend/packages/harness/evoflow/tools/builtins/task_tool.py` - 子任务执行
- `backend/packages/harness/evoflow/tools/builtins/supervisor/execution.py` - 执行委派
- `backend/packages/harness/evoflow/collab/thread_collab.py` - 协作状态
- `backend/packages/harness/evoflow/collab/storage.py` - 任务存储
- `backend/packages/harness/evoflow/collab/models.py` - 数据模型
- `backend/packages/harness/evoflow/subagents/executor.py` - 子任务执行器

### 前端核心文件
- `evopanel/src/react/components/RunManager.tsx` - 任务管理 UI
- `evopanel/src/react/components/TaskSidebar.tsx` - 任务详情侧边栏
- `evopanel/src/react/ChatApp.tsx` - 对话页面
- `evopanel/src/lib/api-client.js` - API 客户端

### 待调研文件
- `backend/packages/harness/evoflow/agents/lead_agent/agent.py` - Lead Agent 实现
- `backend/packages/harness/evoflow/tools/builtins/supervisor_tool.py` - Supervisor Tool
- `backend/packages/harness/evoflow/agents/middlewares/collab_phase_middleware.py` - 阶段中间件


## 13. 总结与行动建议

### 13.1 核心结论

1. **启动功能修复（当前最高优先级）**
   - 问题: 点击启动后任务状态变了，但实际没执行
   - 原因: Supervisor 只是工具，需要 Lead Agent 调用才能执行
   - 方案: 在 `authorize-execution` 后，需要触发 Supervisor 执行

2. **"人类调度者"体验（短期目标）**
   - 不需要大改架构
   - 通过 UI 状态展示 + API 控制实现
   - 关键是: 状态实时同步、操作即时反馈

3. **架构升级（长期目标）**
   - 常驻 Supervisor Agent（方案A）
   - 或轻量级调度器（方案C）
   - 等当前系统稳定后再考虑

### 13.2 立即行动项

**本周内:**
1. 修复启动功能（调研 + 实现）
   - 关键: 让 `authorize-execution` 后能真正触发 Supervisor 执行
2. 实现彻底取消（终止子任务）
   - 终止所有子任务的 background_task
3. 添加 source 字段区分任务来源
   - conversation | automation | manual

**下周:**
1. 实现暂停/恢复
   - 暂停: 停止新子任务派发
   - 恢复: 继续执行
2. 输出流持久化
   - 写入文件，支持历史回看
3. 优化 RunManager UI
   - 清晰展示任务来源
   - 根据状态显示可用操作

### 13.3 设计原则

1. **渐进式改进**: 先做体验，后做架构
2. **向后兼容**: 不影响现有对话任务流程
3. **用户优先**: 手动任务的体验要优于对话任务
4. **可观测性**: 所有状态变化都要可见、可追溯


**下一步:** 召开技术讨论会，确定启动功能修复方案。
