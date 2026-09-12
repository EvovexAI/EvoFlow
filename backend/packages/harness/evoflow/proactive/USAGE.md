# 智能体员工（Proactive AI）模块使用指南

## 概述

本模块让每个 AI 角色像真实岗位负责人一样**主动工作**：
- 定时"醒来"审视自己的领域，发现问题
- 低风险事项自主执行
- 高风险事项推送飞书审批卡片 / 桌面通知，人只需要点「同意」或「拒绝」

---

## 1. 创建一个智能体员工角色

```bash
curl -X POST http://localhost:8080/api/proactive/roles \
  -H "Content-Type: application/json" \
  -d '{
    "agent_code": "frontend_architect",
    "role_name": "前端架构负责人",
    "department": "技术部",
    "responsibilities": [
      "前端架构演进",
      "代码质量保障",
      "性能优化"
    ],
    "domain_scope": [
      "evopanel/src/",
      "backend/packages/harness/evoflow/tools/"
    ],
    "kpis": [
      "构建耗时 < 30s",
      "Lighthouse 评分 > 90",
      "代码覆盖率 > 80%"
    ],
    "autonomy_level": "approval_for_risky",
    "risk_threshold": "medium",
    "approval_channels": ["feishu", "desktop"],
    "approval_timeout_minutes": 30,
    "heartbeat_rrule": "FREQ=HOURLY;INTERVAL=2",
    "max_initiatives_per_cycle": 3,
    "soul_md": "你是一位严谨务实的前端架构师，注重性能与代码质量。"
  }'
```

### 自主权级说明

| 级别 | 含义 | low 风险 | medium | high | critical |
|------|------|---------|--------|------|----------|
| `full_auto` | 高度自主 | ✅自动执行 | ✅自动 | ✅自动 | ❌需审批 |
| `approval_for_risky` | 平衡型（推荐） | ✅自动执行 | ❌需审批 | ❌需审批 | ❌需审批 |
| `approval_for_all` | 谨慎型 | ❌需审批 | ❌需审批 | ❌需审批 | ❌需审批 |

### 心跳周期配置

使用 RRULE 格式：
- 每2小时：`FREQ=HOURLY;INTERVAL=2`
- 每天上午9点：`FREQ=DAILY;INTERVAL=1;BYHOUR=9`
- 每30分钟：`FREQ=MINUTELY;INTERVAL=30`
- 每周一：`FREQ=WEEKLY;INTERVAL=1`

---

## 2. 查看角色与状态

```bash
# 列出所有角色
curl http://localhost:8080/api/proactive/roles

# 查看某个角色详情（含近期倡议）
curl http://localhost:8080/api/proactive/roles/frontend_architect

# 查看引擎运行状态
curl http://localhost:8080/api/proactive/status
```

---

## 3. 手动触发心跳

不想等定时器？可以手动触发一次思考：

```bash
curl -X POST http://localhost:8080/api/proactive/roles/frontend_architect/heartbeat
```

---

## 4. 查看倡议（Initiative）

AI 每次心跳后可能产生若干倡议：

```bash
# 列出所有倡议
curl http://localhost:8080/api/proactive/initiatives

# 按角色过滤
curl "http://localhost:8080/api/proactive/initiatives?role_agent_code=frontend_architect"

# 按状态过滤（proposed / pending_approval / approved / rejected / executing / completed / failed）
curl "http://localhost:8080/api/proactive/initiatives?status=pending_approval"

# 查看单个倡议详情
curl http://localhost:8080/api/proactive/initiatives/init_abc123def456
```

---

## 5. 审批流程（人类决策）

当 AI 产生高风险倡议时，系统会：
1. **飞书推送**：发送审批卡片到默认飞书群，含倡议详情和风险等级
2. **桌面通知**：通过 SSE 推送到 EvoPanel 桌面端，弹窗显示

### 审批操作

```bash
# 同意
curl -X POST http://localhost:8080/api/proactive/approval/init_abc123def456 \
  -H "Content-Type: application/json" \
  -d '{"decision": "approved", "decided_by": "张三", "comment": "同意，按计划执行"}'

# 拒绝
curl -X POST http://localhost:8080/api/proactive/approval/init_abc123def456 \
  -H "Content-Type: application/json" \
  -d '{"decision": "rejected", "decided_by": "张三", "comment": "暂缓，需进一步讨论"}'
```

### 飞书卡片回调

飞书交互卡片的按钮回调走 `/api/proactive/approval/callback`，系统自动解析卡片 action value 中的 `initiative_id` 和 `decision`。

### 超时处理

- **30 分钟**未审批：升级通知（重新推送，标题加 🚨）
- **2 小时**未审批：自动标记为 `timeout_rejected`

---

## 6. 查看角色记忆

每个角色的跨周期记忆：

```bash
curl http://localhost:8080/api/proactive/memory/frontend_architect
```

返回：
```json
{
  "observations": [
    "evopanel 构建耗时从 45s 降到 38s",
    "src/components/ 下有 3 个组件未做懒加载"
  ],
  "strategies": ["优先关注构建性能优化"],
  "focus_areas": ["build-perf", "code-splitting"],
  "completed_initiatives": 12,
  "failed_initiatives": 2,
  "last_think_at": "2026-07-15T10:00:00Z",
  "last_think_summary": "本轮检查了构建配置，发现可拆分 vendor chunk"
}
```

---

## 7. 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `EVOFLOW_PROACTIVE_SCHEDULER` | `1` | 启用/禁用主动引擎（`0` 关闭） |
| `EVOFLOW_PROACTIVE_MODEL` | 系统默认 | 思考引擎使用的 LLM 模型名 |
| `EVOFLOW_PROACTIVE_ASSISTANT_ID` | `lead_agent` | 执行倡议时调用的 LangGraph assistant |
| `EVOFLOW_PROACTIVE_EXECUTION_TIMEOUT` | `600` | 倡议执行超时（秒） |

---

## 8. 完整工作流程

```
1. 创建角色（POST /api/proactive/roles）
   ↓
2. ProactiveRunner 每 60s 检查到期角色
   ↓
3. 角色 next_heartbeat_at 到期 → 触发心跳
   ↓
4. ProactiveEngine.think()
   ├── 读取角色记忆 + 环境上下文
   ├── 调 LLM（system prompt + memory + env）
   ├── 解析 JSON 输出（observations + initiatives + reflection）
   └── 持久化倡议 + 更新记忆
   ↓
5. 对每个倡议：
   ├── 风险低 + 自主权允许 → 自动执行（ExecutionBridge → LangGraph）
   └── 风险高 / 需审批 → DecisionGate
       ├── 推送飞书卡片
       ├── 推送桌面 SSE 通知
       └── 等待人类决策
           ├── 人点「同意」→ 执行
           ├── 人点「拒绝」→ 标记 rejected
           └── 超时 2h → 自动 timeout_rejected
   ↓
6. 执行完成 → 更新倡议状态 + 记录结果
   ↓
7. 下一次心跳 → 循环
```

---

## 9. 文件结构

```
backend/packages/harness/evoflow/proactive/
├── __init__.py          # 模块入口
├── DESIGN.md            # 设计文档（详细架构）
├── models.py            # 数据模型 + 枚举 + 风险矩阵
├── repositories.py      # 仓储层（CRUD）
├── prompt.py            # 思考引擎提示词模板
├── engine.py            # ProactiveEngine（LLM 思考循环）
├── decision_gate.py     # DecisionGate（人类审批门）
├── execution_bridge.py  # ExecutionBridge（LangGraph 执行桥）
├── runner.py            # ProactiveRunner（心跳调度器）
└── router.py            # API Router

backend/packages/harness/evoflow/persistence/
└── schema_migration_v86.py  # 4 张新表 DDL

backend/packages/harness/tests/
└── test_proactive.py    # 40 个测试用例
```

---

## 10. 数据库表

| 表名 | 说明 |
|------|------|
| `evoflow_proactive_roles` | 智能体员工角色定义 |
| `evoflow_proactive_initiatives` | AI 发起的倡议 |
| `evoflow_proactive_approvals` | 人类审批记录 |
| `evoflow_proactive_memory` | 角色长期记忆 |

---

## 11. 后续规划（Phase 2+）

- [ ] 前端管理界面（EvoPanel React 组件）
- [ ] 飞书交互卡片按钮直接审批（带 action callback）
- [ ] Tauri 原生桌面通知弹窗
- [ ] 多角色协同（角色间通信、任务委派）
- [ ] 与 goal_service 深度集成（长期目标驱动）
- [ ] KPI 自动追踪与趋势图
- [ ] 策略学习（基于历史成功率优化建议方向）
