# 智能体员工（Proactive AI）模块设计文档

## 1. 核心理念

### 1.1 从「被动响应」到「主动上岗」

传统 AI 模式：**人 → 发消息 → AI 响应 → 返回结果**
智能体员工模式：**AI 角色 → 自主思考 → 发起行动 → 人仅决策**

每个 AI 不再是被动等待指令的工具，而是一个**真实岗位的负责人**：
- 有明确的职责范围（Domain）
- 有需要优化的 KPI / 目标
- 定期「醒来」审视自己的领域，主动发现问题、提出改进
- 在授权范围内自主执行，超出范围时请求人类决策

### 1.2 人类角色：决策者，非执行者

人不再写 prompt、不发指令、不盯进度。人只做一件事：**决策**
- 飞书审批卡片 → 点「同意」/「拒绝」
- 桌面窗口通知 → 授权 / 驳回
- 对 AI 的行动结果进行事后评价（反馈循环）

---

## 2. 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                    EvoFlow Gateway                          │
│                                                             │
│  ┌──────────────┐    ┌──────────────────┐                   │
│  │ Proactive    │───>│  ProactiveEngine │  (LLM 思考引擎)   │
│  │ Runner       │    │  - 评估领域状态   │                   │
│  │ (心跳调度)   │    │  - 识别改进机会   │                   │
│  │              │    │  - 生成倡议       │                   │
│  │  30s tick    │    │  - 规划行动       │                   │
│  └──────┬───────┘    └────────┬─────────┘                   │
│         │                     │                             │
│         v                     v                             │
│  ┌──────────────┐    ┌──────────────────┐                   │
│  │ Initiative   │<──>│  DecisionGate    │  (人类决策门)      │
│  │ Tracker      │    │  - 飞书审批卡片   │                   │
│  │ (倡议追踪)   │    │  - 桌面通知授权   │                   │
│  │              │    │  - 超时升级       │                   │
│  └──────┬───────┘    └────────┬─────────┘                   │
│         │                     │                             │
│         v                     v                             │
│  ┌──────────────┐    ┌──────────────────┐                   │
│  │ Proactive    │    │  Execution Bridge │  (执行桥接)       │
│  │ Memory       │    │  - LangGraph run  │                   │
│  │ (角色记忆)   │    │  - Supervisor     │                   │
│  │              │    │  - Goal Service   │                   │
│  └──────────────┘    └──────────────────┘                   │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              API Router (/api/proactive)              │   │
│  │  角色 CRUD · 倡议查看 · 审批回调 · 记忆管理           │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. 核心组件设计

### 3.1 ProactiveRole（智能体员工角色定义）

每个 AI 角色对应一个真实岗位，包含：

| 字 | 说明 | 示例 |
|---|------|------|
| `agent_code` | 关联 evoflow_agents 表的 agent | `frontend_architect` |
| `role_name` | 角色名称 | "前端架构负责人" |
| `department` | 所属部门 | "技术部" |
| `responsibilities` | 职责描述 | ["前端架构演进", "代码质量", "性能优化"] |
| `domain_scope` | 管辖范围（文件/模块/项目） | ["evopanel/src/", "backend/packages/harness/"] |
| `kpis` | 需要持续优化的指标 | ["代码覆盖率", "构建耗时", "Lighthouse评分"] |
| `autonomy_level` | 自主权级 | `full_auto` / `approval_for_risky` / `approval_for_all` |
| `heartbeat_schedule` | 心跳周期 | `"FREQ=HOURLY;INTERVAL=2"` (每2小时) |
| `max_initiatives_per_cycle` | 每轮最多发起的倡议数 | 3 |
| `risk_threshold` | 风险阈值（超过则需审批） | `medium` |
| `approval_channels` | 审批渠道 | `["feishu", "desktop"]` |
| `status` | 运行状态 | `active` / `paused` / `archived` |
| `soul_md` | 角色灵魂描述（人设） | "你是一位严谨的前端架构师..." |

### 3.1.1 岗位交付文档目录

每个员工在绑定的 `workspace_path` 下有独立文档树（**路径用英文 `agent_code`，不用中文岗位名**，避免跨平台乱码与重名）：

```
<workspace>/
  docs/roles/
    code-agent/                    # agent_code=code-agent（例：前端工程师）
      20260721-18/                 # UTC 小时桶 YYYYMMDD-HH
        notes.md
        report.md
      20260721-19/
    xiaomi/
      20260721-18/
    …
```

规则（写进值班系统提示「交付文档目录」）：

- 方案 / 报告 / 纪要 / 分析类 Markdown → **只写** `docs/roles/<agent_code>/<YYYYMMDD-HH>/…`
- 小时戳为 **UTC、精确到小时**，避免同名覆盖、目录乱堆；同一小时内可多文件
- 业务源码仍按 `domain_scope` 与仓库惯例落盘，不塞进 `docs/roles/`
- 禁止写到仓库根、`docs/` 根、`outputs/` 根、他人目录，或无时间戳直接堆在岗位根下
- 对话引用用工作区绝对路径，如 `@@/Users/me/project/docs/roles/code-agent/20260721-18/report.md@@`（禁止相对路径）

实现：`evoflow.proactive.artifacts.role_docs_rel_dir` / `role_docs_hour_stamp` / `format_role_docs_prompt_block`。

### 3.2 ProactiveEngine（主动思考引擎）

每次心跳触发时，引擎执行以下「思考循环」：

```
1. 感知 (Perceive)
   - 读取角色管辖范围内的当前状态（代码、任务、指标）
   - 读取角色记忆（上次思考的结论、未完成事项）
   - 读取环境信号（新提交、CI 结果、用户反馈）

2. 思考 (Think) — LLM 驱动
   - 基于角色 KPI 评估当前状态
   - 识别可改进的点、潜在风险、待推进事项
   - 生成 1-N 个「倡议」(Initiative)

3. 决策 (Decide)
   - 评估每个倡议的风险等级
   - autonomy_level=full_auto: 直接执行
   - autonomy_level=approval_for_risky: 低风险直接执行，高风险走审批
   - autonomy_level=approval_for_all: 全部走审批

4. 行动 (Act)
   - 通过 ExecutionBridge 执行（LangGraph / Supervisor / Goal）
   - 或通过 DecisionGate 发起审批

5. 反思 (Reflect)
   - 记录本轮思考结论到 ProactiveMemory
   - 更新策略（哪些方向值得继续关注）
```

### 3.3 Initiative（倡议）

AI 主动发起的一项工作提案：

| 字段 | 说明 |
|------|------|
| `id` | 唯一标识 |
| `role_agent_code` | 发起角色 |
| `title` | 倡议标题 |
| `description` | 详细描述（为什么要做） |
| `rationale` | 分析依据 |
| `action_type` | `code_change` / `analysis` / `report` / `task_delegation` / `alert` |
| `risk_level` | `low` / `medium` / `high` / `critical` |
| `action_plan` | 具体执行计划（JSON） |
| `expected_outcome` | 预期效果 |
| `status` | `proposed` → `pending_approval` → `approved`/`rejected` → `executing` → `completed`/`failed` |
| `approval_timeout_minutes` | 审批超时时间 |
| `approved_by` | 审批人 |
| `approved_at` | 审批时间 |
| `execution_result` | 执行结果 |
| `created_at` | 创建时间 |

### 3.4 DecisionGate（人类决策门）

```
倡议风险 > 阈值?
  ├─ 是 → 发起审批
  │   ├─ 飞书交互卡片（标题 + 描述 + 风险 + [同意] [拒绝] [需要讨论]）
  │   ├─ 桌面通知（Tauri 窗口弹窗 + 操作按钮）
  │   └─ 等待审批（默认超时 30 分钟，超时后按策略升级或自动拒绝）
  │
  └─ 否 → 直接执行
```

审批流程：
1. **发送**：生成审批请求 → 推送到飞书 + 桌面通知
2. **等待**：轮询状态，超时检查
3. **回调**：
   - 飞书回调 → `POST /api/proactive/approval/callback`
   - 桌面操作 → `POST /api/proactive/approval/{initiative_id}`
4. **超时处理**：
   - Level 1 超时（30min）→ 升级通知（@更高权限人）
   - Level 2 超时（2h）→ 自动标记为 `timeout_rejected`

### 3.5 ProactiveMemory（角色记忆）

每个角色的长期记忆，跨心跳周期累积：

```json
{
  "role_agent_code": "frontend_architect",
  "memory": {
    "observations": [
      "2026-07-15: evopanel 构建耗时从 45s 降到 38s，仍有优化空间",
      "2026-07-15: src/components/ 下有 3 个组件未做懒加载"
    ],
    "strategies": [
      "优先关注构建性能优化，每次心跳检查构建耗时趋势",
      "代码审查关注 unused imports 和重复逻辑"
    ],
    "completed_initiatives": 12,
    "failed_initiatives": 2,
    "last_think_at": "2026-07-15T10:00:00Z",
    "last_think_summary": "本轮检查了构建配置，发现可拆分 vendor chunk",
    "focus_areas": ["build-perf", "code-splitting", "test-coverage"]
  }
}
```

---

## 4. 数据模型（SQLite 新表）

### 4.1 evoflow_proactive_roles
```sql
CREATE TABLE evoflow_proactive_roles (
    agent_code TEXT PRIMARY KEY,
    role_name TEXT NOT NULL,
    department TEXT NOT NULL DEFAULT '',
    config_json TEXT NOT NULL,  -- responsibilities, domain_scope, kpis, autonomy_level, etc.
    heartbeat_rrule TEXT NOT NULL DEFAULT 'FREQ=HOURLY;INTERVAL=2',
    status TEXT NOT NULL DEFAULT 'active',  -- active / paused / archived
    last_heartbeat_at TEXT,
    next_heartbeat_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

### 4.2 evoflow_proactive_initiatives
```sql
CREATE TABLE evoflow_proactive_initiatives (
    id TEXT PRIMARY KEY,
    role_agent_code TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    rationale TEXT NOT NULL DEFAULT '',
    action_type TEXT NOT NULL DEFAULT 'analysis',
    risk_level TEXT NOT NULL DEFAULT 'low',
    action_plan_json TEXT NOT NULL DEFAULT '{}',
    expected_outcome TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'proposed',
    approval_id TEXT,
    approved_by TEXT,
    approved_at TEXT,
    approval_timeout_minutes INTEGER NOT NULL DEFAULT 30,
    execution_thread_id TEXT,
    execution_result TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (role_agent_code) REFERENCES evoflow_proactive_roles(agent_code)
);
```

### 4.3 evoflow_proactive_approvals
```sql
CREATE TABLE evoflow_proactive_approvals (
    id TEXT PRIMARY KEY,
    initiative_id TEXT NOT NULL,
    role_agent_code TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'feishu',  -- feishu / desktop / both
    feishu_message_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',  -- pending / approved / rejected / timeout / escalated
    decided_by TEXT,
    decided_at TEXT,
    decision_comment TEXT,
    escalation_level INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (initiative_id) REFERENCES evoflow_proactive_initiatives(id)
);
```

### 4.4 evoflow_proactive_memory
```sql
CREATE TABLE evoflow_proactive_memory (
    role_agent_code TEXT PRIMARY KEY,
    memory_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
);
```

---

## 5. 思考引擎 Prompt 设计

### 系统提示词
```
你是 {role_name}，{department} 的负责人。

你的职责：{responsibilities}
你管辖的范围：{domain_scope}
你需要持续优化的指标：{kpis}

你的工作方式：
1. 每次被唤醒时，审视你管辖范围内的当前状态
2. 基于你的专业判断，识别需要改进或推进的事项
3. 对每个事项，评估风险等级并决定是否需要人类审批
4. 生成结构化的倡议（Initiative）

你的记忆（上次思考的结论）：
{memory_summary}

当前环境信号：
{environment_context}

请以 JSON 格式输出你的思考结果：
{
  "observations": ["观察到的现状..."],
  "initiatives": [
    {
      "title": "倡议标题",
      "description": "详细描述",
      "rationale": "分析依据",
      "action_type": "code_change|analysis|report|task_delegation|alert",
      "risk_level": "low|medium|high|critical",
      "action_plan": { ... },
      "expected_outcome": "预期效果",
      "needs_approval": true/false
    }
  ],
  "reflection": "本轮思考的总结和策略调整"
}
```

---

## 6. API 设计

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/proactive/roles` | 列出所有智能体员工角色 |
| POST | `/api/proactive/roles` | 创建智能体员工角色 |
| PUT | `/api/proactive/roles/{agent_code}` | 更新角色配置 |
| DELETE | `/api/proactive/roles/{agent_code}` | 归档角色 |
| POST | `/api/proactive/roles/{agent_code}/heartbeat` | 手动触发心跳 |
| GET | `/api/proactive/initiatives` | 列出倡议（支持过滤角色/状态） |
| GET | `/api/proactive/initiatives/{id}` | 倡议详情 |
| POST | `/api/proactive/approval/{initiative_id}` | 审批操作 |
| POST | `/api/proactive/approval/callback` | 飞书审批回调 |
| GET | `/api/proactive/memory/{agent_code}` | 查看角色记忆 |
| PUT | `/api/proactive/memory/{agent_code}` | 更新角色记忆 |
| GET | `/api/proactive/status` | 引擎运行状态 |

---

## 7. 与现有系统的集成

### 7.1 复用 automation_runner 模式
- ProactiveRunner 复用 automation_runner 的后台循环模式
- 心跳调度复用 rrule 解析
- LangGraph 运行复用信号量并发控制

### 7.2 复用 supervisor_tool
- 当倡议 action_type=task_delegation 时，通过 supervisor 分配给子 Agent
- 多角色协同时，supervisor 负责跨角色任务依赖

### 7.3 复用 goal_service
- 当倡议需要长期推进时，创建一个 Goal 任务持续跟踪
- 智能体员工角色可以成为 Goal 的「执行者」

### 7.4 复用 feishu channel
- 审批卡片使用飞书交互式消息卡片（带按钮）
- 审批回调通过飞书事件回调处理

### 7.5 复用 evoflow_agents
- 智能体员工角色关联 evoflow_agents 表中的 agent_code
- 复用 soul_md 作为角色人设
- 复用 config_json 存储扩展配置

---

## 8. 自主权级与风险矩阵

| 自主权级 | low 风险 | medium 风险 | high 风险 | critical 风险 |
|---------|---------|------------|----------|--------------|
| full_auto | ✅ 自主执行 | ✅ 自主执行 | ⚠️ 通知后执行 | ❌ 必须审批 |
| approval_for_risky | ✅ 自主执行 | ✅ 通知后执行 | ❌ 必须审批 | ❌ 必须审批 |
| approval_for_all | ✅ 通知后执行 | ❌ 必须审批 | ❌ 必须审批 | ❌ 必须审批 |

---

## 9. 实现计划

### Phase 1: 核心基础设施（本次实现）
- [x] 数据模型与 Schema 迁移
- [x] ProactiveRole 仓储层
- [x] Initiative 仓储层
- [x] ProactiveMemory 仓储层
- [x] ProactiveEngine 思考引擎
- [x] DecisionGate 决策门
- [x] ProactiveRunner 心跳调度器
- [x] API Router
- [x] Gateway 集成钩子

### Phase 2: 深度集成（后续）
- [ ] 飞书交互卡片审批
- [ ] Tauri 桌面通知授权
- [ ] 与 supervisor 多角色协同
- [ ] 与 goal_service 长期目标对接
- [ ] 前端管理界面

### Phase 3: 增强（远期）
- [ ] 角色间通信协议
- [ ] 多角色协同决策
- [ ] 策略学习与优化
- [ ] KPI 自动追踪
