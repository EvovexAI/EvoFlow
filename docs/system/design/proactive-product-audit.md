# 智能体员工（Proactive AI）产品诊断与优化方案

> **文档状态**：已完成工程缺陷修复 + 产品问题诊断，待评审优化方案
> **诊断日期**：2026-07-17
> **数据来源**：`~/.evoflow/data/app/evoflow.db`（314 条 initiative / 50 条 approval / 7 个角色）
> **代码范围**：`backend/packages/harness/evoflow/proactive/` 全模块

---

## 一、背景

智能体员工（Proactive AI）是 EvoFlow 的具身智能模块，核心卖点是：**AI 作为岗位负责人主动巡检工作空间、发现问题、提出方案，人类通过飞书/桌面通知进行审批决策**。

模块包含三个核心子系统：
- **ProactiveEngine** — LLM 驱动的思考循环（感知→思考→产出方案→决策）
- **DecisionGate** — 人机协作审批门（飞书卡片/桌面通知，风险×自治矩阵）
- **ProactiveRunner** — 后台心跳调度器（每 2 小时巡检一次）

---

## 二、已修复的工程缺陷（5 项）

以下 5 个工程级缺陷已在本次修复中解决，代码已合并，60 个单元测试通过。

### 缺陷 1：check_in 永不收尾 → 死循环根源

**现象**：前端工程师（code-agent）24 小时内跑了 30 轮巡检，全部卡在 `executing` 状态，无任何产出。

**根因**：AI 每轮只调 `proactive_submit_work(phase="check_in")`（状态 = EXECUTING），从不调 `phase="wrap_up"`（状态 = COMPLETED）。check_in 日志永久卡 executing，无 TTL 回收。

**修复**：`engine.py` 的 `_run_agent_loop()` 在正常结束但本轮无 wrap_up 时，强制合成一条交班记录。

| 文件 | 改动 |
|------|------|
| `engine.py` | `_run_agent_loop()` 末尾增加强制 wrap_up 补齐逻辑 |

### 缺陷 2：工作日志反馈死循环

**现象**：30 条僵尸 executing 记录被喂给下一轮 AI 作为工作日志上下文，AI 看到"一堆卡死的 executing"后想"清理"，又提一个新任务 → 又卡死 → 日志更长 → 恶性循环。

**根因**：`engine.py` 的 `_build_work_log()` 把最近 20 条记录全量喂给 AI，不做过滤或截断。

**修复**：`_build_work_log()` 对 executing 状态的 journal 日志折叠截断，最多展示 3 条，其余聚合为一行"已折叠 N 条历史卡死的 executing 日志，勿重复提出清理任务"。

| 文件 | 改动 |
|------|------|
| `engine.py` | `_build_work_log()` 增加 executing journal 折叠逻辑 |

### 缺陷 3：executing 状态无 TTL 回收

**现象**：30 条 executing 僵尸记录跨 24 小时无人清理，`_recover_orphaned_pending_approvals()` 只回收 `pending_approval`，完全不管 `executing`。

**根因**：`runner.py` 的 tick 循环没有 executing 超时回收机制。

**修复**：
- `repositories.py` 新增 `list_stale_executing(max_age_hours=6)` 查询超时记录
- `runner.py` 新增 `_recover_stale_executing()`，每个 tick 执行，超 6 小时未收尾的 executing 自动标 FAILED

| 文件 | 改动 |
|------|------|
| `repositories.py` | 新增 `list_stale_executing()` 方法 |
| `runner.py` | `_tick()` 调用 `_recover_stale_executing()` + 新增该方法 |

### 缺陷 4：memory 计数器永久归零

**现象**：数据库 memory 表中 `completed_initiatives: 0`，`failed_initiatives: 0`，但实际有 16 条 completed。

**根因**：`agent_loop` 模式下 `submit_work` 只更新 observations/reflection，从不给 completed/failed 计数器 +1（该逻辑只在已废弃的 `prompt_only` 路径中存在）。

**修复**：`engine.py` 的 `_run_agent_loop()` 结束后统计本轮 COMPLETED/FAILED 数量，增量更新 memory 计数器。

| 文件 | 改动 |
|------|------|
| `engine.py` | `_run_agent_loop()` 末尾增加 memory 计数器增量更新 |

### 缺陷 5：journal 无去重

**现象**：每轮巡检都新建一条 check_in journal，标题高度重复（"全量 ESLint 质量扫描"出现 27 次），跨轮堆积。

**根因**：`prompt_only` 模式有 `existing_titles` 标题去重，但 `agent_loop` 的 journal 路径豁免了去重检查，且每轮 `round_id` 不同。

**修复**：`submit_work.py` 的 `_upsert_round_journal()` 在新建 check_in 前，先扫描并关闭上一轮未收尾的 check_in journal。

| 文件 | 改动 |
|------|------|
| `submit_work.py` | `_upsert_round_journal()` 新建前关闭上一轮未收尾的 check_in |

### 工程修复验证

| 验证项 | 结果 |
|--------|------|
| `py_compile` 语法校验（4 文件） | ✅ 全通过 |
| 单元测试（test_proactive + round_messages + tool_middleware） | ✅ 60 passed |
| 历史僵尸数据清理 | ✅ 36 条 executing 已回收，全库 executing 归零 |
| 防御层次 | 三道防线：engine 强制 wrap_up → submit_work 关闭旧 check_in → runner TTL 兜底 |

---

## 三、产品级问题诊断（6 项）

以下问题从产品经理视角审视，基于真实运行数据分析。

### 问题 P1：审批门形同虚设，人机协作闭环未转起来

**严重度**：🔴 致命 — 核心卖点不 work

**数据**：

| 审批结果 | 数量 | 占比 |
|---------|:----:|:----:|
| ✅ 批准 (approved) | 0 | 0% |
| ❌ 拒绝 (rejected) | 3 | 6% |
| ⌛ 超时自动枪毙 (timeout) | 47 | **94%** |

50 条审批记录，**没有一条被真正批准过**。AI 提出的 code_change / optimization 提案，全部因超时被自动拒绝。

所有审批集中在 07-15 11:41~11:42 一分钟内创建（初始化批量触发），之后用户从未主动操作过任何审批。

**问题分解**：

1. **通知触达失效**：飞书卡片/桌面通知发出后，用户大概率没看到或没注意
2. **超时时间不合理**：巡检型提案超时 30~60 分钟，用户可能在开会/吃饭/睡觉
3. **提案质量不可见**：没有"拒绝原因"字段，无法判断是"没看到"还是"看到了不想批"
4. **无重新提案机制**：超时枪毙后该方案永久作废，不会在下次巡检时重新评估

**产品影响**：对外讲"AI 员工会主动提方案，你审批后执行"，实际是"AI 提了方案，然后自己超时了"。

---

### 问题 P2：56% 的巡检是"无事可办" — 定时推送是错误模型

**严重度**：🟡 高 — 持续浪费资源

**数据**：

| 角色 | 完成数 | "无事可办"报告数 | 占比 |
|------|:------:|:---------------:|:----:|
| code-agent（前端工程师） | 16 | 9 | **56%** |
| backend_engineer | 83 | 0 | 0% |
| frontend_architect | 90 | 0 | 0% |
| project-debugger | 3 | 0 | 0% |

前端工程师一半以上的巡检产出是"确认无变化，无事待办"。

**问题分解**：

1. **触发模型错误**：现在是**定时推（push）**—每 2 小时无脑巡检，不管有没有事。应该是**事件驱动（event-driven）**—git 有新提交时触发、CI 挂了时触发、PR 创建时触发
2. **巡检范围模糊**：code-agent 和 frontend_architect 都管 `evopanel/src/`，重复巡检同一片代码
3. **无"上次巡检结论"记忆**：上一轮说"无变化"，下一轮还是全量扫一遍，没有增量巡检

**产品影响**：56% 的 token 花在确认"没事"上，纯浪费。

---

### 问题 P3：成本完全不可见

**严重度**：🟡 高 — B2B 续费障碍

**数据**：

```
07-15: 263 条 initiative（初始化 + 大量巡检）
07-16:  41 条
07-17:  10 条
```

每个角色每轮巡检跑一个完整 LangGraph agent loop（max_turns=12~15，timeout 420~600s），但**没有任何地方记录**：
- token 消耗
- 模型调用次数
- 单轮成本
- 日均/月均成本

**缺失的产品能力**：
- 每角色日均成本看板
- 单次巡检 token 消耗记录
- 成本 vs 产出比（ROI）
- 成本预警 / 预算上限熔断

**产品影响**：用户无法回答"我养这 3 个 AI 员工一个月花多少钱、值不值"。B2B 产品如果客户算不清 ROI，续费就悬。

---

### 问题 P4：角色设计有重叠和僵尸

**严重度**：🟠 中 — 数据债 + 体验混乱

**数据**：

数据库中有 **7 个角色代码**产生过 initiative，但只有 **3 个**在 active 角色表里：

| 角色 | agent_code | 在 active 表 | initiative 数 | 问题 |
|------|-----------|:---:|:---:|------|
| 前端架构负责人 | frontend_architect | ❌ | 111 | 旧角色，数据残留 |
| 后端工程负责人 | backend_engineer | ❌ | 122 | 旧角色，数据残留 |
| 运维负责人 | devops_lead | ❌ | 2 | 旧角色，数据残留 |
| 前端工程师 | code-agent | ✅ | 46 | 与 frontend_architect 职责重叠 |
| 后端工程师 | project-implementer | ✅ | 2 | 产出极少 |
| Bug 分析师 | project-debugger | ✅ | 8 | 产出少 |

**问题分解**：

1. **职责重叠**：`frontend_architect`（前端架构负责人）和 `code-agent`（前端工程师）都管 `evopanel/src/`，KPI 类似
2. **僵尸角色**：4 个旧角色不在 active 表但数据还在，无归档/清理策略
3. **角色配置不一致**：有的角色有详细 KPI，有的只有模糊描述
4. **无生命周期管理**：创建→调优→归档→删除的流程缺失

**产品影响**：用户不知道哪些角色还在"上班"，角色页可能显示混乱。

---

### 问题 P5：没有产品级健康看板

**严重度**：🟠 中 — 缺乏可观测性导致问题无法及时发现

**现状**：唯一的可见性是 `runner.status()` 返回的运行时状态（几个角色活跃、几个待审批）。

**缺失的看板能力**：

| 指标 | 当前 | 应有 |
|------|:---:|:---:|
| 各角色产出趋势 | ❌ | ✅ |
| 审批通过率/超时率 | ❌ | ✅ |
| 成本趋势 | ❌ | ✅ |
| 僵尸记录数量 | ❌ | ✅ |
| 异常自动告警 | ❌ | ✅ |

**案例**：本次发现的 30 条僵尸 executing 记录跨 24 小时没人发现，就是因为没有任何健康监控。如果有个看板显示"executing 堆积 30 条"，第一天就会发现。

**产品影响**：功能出问题时用户和开发者都无感知，问题积累到严重才暴露。

---

### 问题 P6：KPI 不可度量，无法评估"员工绩效"

**严重度**：🟢 低 — 影响长期优化

**数据**：

| 角色 | KPI 示例 | 能否自动度量 |
|------|---------|:---:|
| 前端架构负责人 | "构建耗时 < 30s" | ✅ 可度量 |
| 前端架构负责人 | "Lighthouse 评分 > 90" | ✅ 可度量 |
| 前端工程师 | "页面UI美观" | ❌ 主观 |
| 前端工程师 | "页面功能正常" | ❌ 无定义 |
| 后端工程师 | "API 可调用" | 🟡 模糊 |
| Bug 分析师 | "根因带证据" | ❌ 人工判断 |

一半 KPI 是定性的，无法被系统自动验证。且 memory 里的 `completed_initiatives` / `failed_initiatives` 计数器此前是坏的（已修复），就算修好也只是"干了多少活"而非"干得好不好"。

**产品影响**：没法做"绩效评估"和"角色优化建议"，功能停留在"能跑"而非"跑得好"。

---

## 四、优化方案

### 方案 O1：修复审批闭环 [P0]

**解决问题**：P1 审批门形同虚设

#### O1.1 超时时间按场景分级

当前所有审批统一 30~60 分钟超时，不合理。改为按 action_type 分级：

| action_type | 当前超时 | 建议超时 | 理由 |
|-------------|:---:|:---:|------|
| analysis / report | 30min | **2h** | 分析报告不紧急，给用户充足时间 |
| code_change | 30~45min | **24h** | 代码变更需仔细审，可能需要看 diff |
| optimization | 45min | **24h** | 优化方案需评估影响范围 |
| alert | 30min | **1h** | 告警类需较快响应 |
| task_delegation | 30min | **4h** | 任务委派需协调 |

**改动点**：
- `models.py` — `ProactiveRoleConfig` 增加 `approval_timeout_by_type: dict[str, int]` 字段
- `decision_gate.py` — `request_approval()` 按 action_type 查找对应超时时间
- `repositories.py` — `Approval` 增加实际生效的 `timeout_minutes` 字段（已持久化）

#### O1.2 通知内嵌深链一键操作

当前飞书卡片可能只展示了方案内容，用户需要跳转到应用内操作。改为：

- 飞书卡片按钮直接带 callback URL：`{app_url}/proactive/approval/{id}?action=approve`
- 桌面通知点击直接跳转审批页并高亮该条目
- 审批页支持快捷键 `Y`(批准) / `N`(拒绝) / `J`(下一条)

**改动点**：
- `channels/feishu.py` — 卡片模板增加 action button + callback
- `evopanel/src/pages/proactive-employee.js` — 审批页支持 URL 参数定位 + 快捷键

#### O1.3 超时方案自动重新评估

超时枪毙后，在下次巡检时自动检查该方案是否仍然有效（问题是否还存在），如果有效则重新提案并标记"历史超时重新评估"。

**改动点**：
- `engine.py` — `_run_agent_loop()` 构建 work_log 时，将超时拒绝的 initiative 以"待重新评估"标记喂给 AI
- `prompt.py` — system prompt 增加"对于标记为超时重新评估的历史方案，请确认问题是否仍然存在"

#### O1.4 记录拒绝原因

`Approval` 增加 `rejection_reason` 字段，用户拒绝时可填理由，用于后续优化 AI 提案质量。

**改动点**：
- `repositories.py` — `Approval` 数据结构 + DB schema migration
- `decision_gate.py` — 拒绝时写入 reason
- `evopanel/src/pages/proactive-employee.js` — 拒绝弹窗增加 reason 输入

---

### 方案 O2：加成本可见性 [P0]

**解决问题**：P3 成本不可见

#### O2.1 每轮巡检记录 token 消耗

在 `engine.py` 的 `_run_agent_loop()` 中，LangGraph run 结束后记录：

```
proactive_cost_log 表:
  - id (PK)
  - role_agent_code
  - round_id
  - thread_id
  - model_name
  - input_tokens
  - output_tokens
  - total_tokens
  - cost_usd (按模型价格表计算)
  - duration_seconds
  - created_at
```

**改动点**：
- `repositories.py` — 新增 `ProactiveCostRepository` + schema migration
- `engine.py` — `_run_langgraph_agent()` 返回 run metadata，`_run_agent_loop()` 持久化成本
- `chat_session.py` 或 LangGraph callback — 采集 token 用量

#### O2.2 角色页显示成本汇总

在员工名册页面，每个角色卡片显示：
- 今日成本（token + USD）
- 7 日趋势迷你图
- 单次巡检平均成本
- 累计成本

**改动点**：
- `proactive/router.py` — 新增 `GET /proactive/roles/{code}/cost` 接口
- `evopanel/src/pages/proactive-employee.js` — 角色卡片增加成本区块

#### O2.3 全局预算熔断

在 `ProactiveRoleConfig` 增加 `daily_budget_usd` 字段，当某角色当日成本超限时：
- 暂停该角色巡检
- 发送飞书通知"角色 X 今日成本已达预算上限 $Y，已暂停巡检"
- 在角色页显示"预算超限暂停"状态

**改动点**：
- `models.py` — `ProactiveRoleConfig` 增加 `daily_budget_usd`
- `runner.py` — `_tick()` 调度前检查当日累计成本
- `repositories.py` — 新增 `get_daily_cost(agent_code, date)` 查询

---

### 方案 O3：事件驱动触发 [P1]

**解决问题**：P2 56% 空转巡检

#### O3.1 事件触发架构

新增事件总线，以下事件自动触发对应角色巡检：

| 事件 | 触发角色 | 延迟 |
|------|---------|:---:|
| git push（工作空间有新提交） | 该工作空间绑定的角色 | 60s（debounce） |
| CI 构建失败 | 绑定的角色 | 立即 |
| PR 创建/更新 | 绑定的角色 | 30s |
| 定时巡检（保留，降频） | 所有角色 | 每天 09:00 "早会" |

**改动点**：
- 新增 `proactive/triggers.py` — 事件监听 + debounce + 触发 `runner.dispatch_task()`
- `runner.py` — `dispatch_task()` 支持 `source="event:git_push"` 等来源标记
- 定时巡检 `heartbeat_rrule` 默认改为 `FREQ=DAILY;INTERVAL=1;BYHOUR=9`

#### O3.2 增量巡检

在 `_build_work_log()` 中注入"自上次巡检以来的变化"：

```markdown
### 自上次巡检以来的变化（增量）
- git: 3 个新提交 (abc1234..def5678)
  - feat: 新增用户头像上传组件
  - fix: 修复登录页闪烁
  - refactor: 提取公共 Table 组件
- 文件变更: 8 files changed, +234/-56
- ESLint: 0 errors (上次: 0), 2 warnings (上次: 3, 减少 1)
```

**改动点**：
- `engine.py` — `_gather_environment_context()`（runner 层）增加 git diff 采集
- `runner.py` — `_gather_environment_context()` 调用 git 获取增量变化

#### O3.3 "无事可办"感知

当连续 N 轮（建议 3 轮）巡检均为"无事可办"时，自动降频该角色巡检间隔（如 2h → 4h → 8h），有事时恢复原始频率。

**改动点**：
- `runner.py` — `_process_role()` 结束后检查连续"无事"次数，动态调整 next_heartbeat

---

### 方案 O4：健康看板 [P1]

**解决问题**：P5 无可观测性

#### O4.1 看板指标定义

| 指标 | 数据来源 | 展示形式 |
|------|---------|---------|
| 各角色产出趋势 | initiatives 表按天聚合 | 7 日折线图 |
| 审批通过率/超时率 | approvals 表聚合 | 环形图 + 数值 |
| 僵尸记录数 | `list_stale_executing()` 实时查 | 数值 + 红色告警 |
| 成本趋势 | cost_log 表按天聚合 | 7 日折线图 |
| "无事可办"占比 | initiatives outcome 关键词匹配 | 百分比 + 趋势 |
| 角色活跃状态 | roles 表 + busy_roles | 状态卡片 |

#### O4.2 异常自动告警

| 告警条件 | 告警方式 |
|---------|---------|
| 僵尸 executing > 5 条 | 飞书通知 + 看板红色标记 |
| 审批超时率 > 80%（7 日窗口） | 飞书通知"审批通道可能异常" |
| 单角色日均成本 > 预算 80% | 飞书通知"角色 X 成本接近上限" |
| 角色连续 3 轮无产出 | 看板黄色标记"疑似空转" |
| 角色巡检失败率 > 30% | 飞书通知"角色 X 巡检异常" |

**改动点**：
- `proactive/router.py` — 新增 `GET /proactive/dashboard` 聚合接口
- `evopanel/src/pages/proactive.js` — 新增看板视图
- `runner.py` — `_tick()` 增加告警检查逻辑

---

### 方案 O5：角色生命周期管理 [P2]

**解决问题**：P4 角色重叠和僵尸

#### O5.1 角色状态扩展

当前只有 `active / paused / archived`。扩展为：

| 状态 | 含义 | 巡检 | 展示 |
|------|------|:---:|:---:|
| active | 在职 | ✅ | 员工名册 |
| paused | 请假/暂停 | ❌ | 员工名册（灰色） |
| archived | 归档（离职） | ❌ | 历史归档页 |
| draft | 草稿（未上岗） | ❌ | 编辑页 |

#### O5.2 旧角色归档 + 数据清理

一键将不在 active 表的旧角色（frontend_architect / backend_engineer / devops_lead）归档：
- 角色状态 → archived
- initiative 数据保留但标记为归档
- 员工名册不展示，历史归档页可查

#### O5.3 职责去重检测

创建/编辑角色时，检测与现有角色的 `domain_scope` 和 `responsibilities` 重叠度，重叠 > 50% 时提示"与角色 X 职责高度重叠，建议合并或明确分工"。

**改动点**：
- `proactive/router.py` — 新增 `POST /proactive/roles/check-overlap` 接口
- `evopanel/src/pages/proactive-employee.js` — 角色编辑表单增加重叠检测

---

### 方案 O6：KPI 自动度量 [P2]

**解决问题**：P6 KPI 不可度量

#### O6.1 KPI 结构化

将 KPI 从自由文本升级为结构化：

```json
{
  "kpis": [
    {
      "name": "ESLint error 数",
      "target": 0,
      "metric_type": "command",
      "metric_command": "npx eslint evopanel/src/ --format json | jq '[.[] | .errorCount] | add'",
      "check_frequency": "per_patrol"
    },
    {
      "name": "构建耗时",
      "target": 30,
      "target_op": "<=",
      "metric_type": "command",
      "metric_command": "npm run build 2>&1 | grep 'built in' | grep -oP '\\d+\\.?\\d*s'",
      "check_frequency": "daily"
    }
  ]
}
```

#### O6.2 绩效评估报告

每周自动生成角色绩效报告：

```
前端工程师 周报（07-15 ~ 07-21）
├─ 巡检次数：12 次
├─ 产出方案：8 个（completed 5 / failed 3）
├─ 审批通过：2 / 提案 4（通过率 50%）
├─ KPI 达标情况：
│  ✅ ESLint error: 0 (目标 0)
│  ✅ 构建耗时: 24s (目标 <30s)
│  ⚠️ 无度量: "页面UI美观"（建议转为可度量指标）
├─ 成本：$X.XX（token YYYK）
└─ 建议：连续 3 轮无事可办，建议降频至每 4 小时
```

**改动点**：
- `models.py` — `ProactiveRoleConfig.kpis` 支持结构化格式
- 新增 `proactive/kpi_checker.py` — 执行 metric_command 并对比 target
- `runner.py` — 巡检结束后跑 KPI check
- `proactive/router.py` — 新增 `GET /proactive/roles/{code}/performance` 接口

---

## 五、优先级与排期建议

| 优先级 | 方案 | 解决问题 | 工作量估算 | 阶段 |
|:---:|------|---------|:---:|:---:|
| **P0** | O1 修复审批闭环 | P1 审批形同虚设 | 3~5 天 | 立即 |
| **P0** | O2 成本可见性 | P3 成本不可见 | 3~4 天 | 立即 |
| **P1** | O3 事件驱动触发 | P2 56% 空转 | 5~7 天 | 第二阶段 |
| **P1** | O4 健康看板 | P5 无可观测性 | 3~5 天 | 第二阶段 |
| **P2** | O5 角色生命周期 | P4 角色重叠僵尸 | 2~3 天 | 第三阶段 |
| **P2** | O6 KPI 自动度量 | P6 KPI 不可度量 | 4~6 天 | 第三阶段 |

**建议路径**：
1. **第一阶段（立即）**：O1 + O2 — 先让核心闭环（审批）转起来 + 让用户看到成本
2. **第二阶段**：O3 + O4 — 从"定时空转"升级为"事件驱动" + 加上可观测性
3. **第三阶段**：O5 + O6 — 角色管理规范化 + 绩效可度量

---

## 六、附录

### A. 诊断数据快照

#### 角色产出分布（修复前）

| 角色 | initiative 总数 | completed | failed | executing(僵尸) | pending_approval | timeout_rejected |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| frontend_architect | 111 | 90 | 0 | 0 | 23 | 21 |
| backend_engineer | 122 | 83 | 0 | 0 | 10 | 26 |
| code-agent | 46 | 16 | 0 | **30** | 0 | 0 |
| project-debugger | 8 | 3 | 5 | 0 | 0 | 0 |
| project-implementer | 2 | 0 | 2 | 0 | 0 | 0 |
| devops_lead | 2 | 0 | 0 | 0 | 2 | 0 |

#### 审批使用情况

```
审批总数：50
  approved:    0 (0%)
  rejected:    3 (6%)
  timeout:    47 (94%)
  pending:     0
```

#### 日均 initiative 产出

```
2026-07-15: 263 条（初始化 + 批量巡检）
2026-07-16:  41 条
2026-07-17:  10 条
```

### B. 涉及代码文件清单

| 文件 | 已修复 | 待优化 |
|------|:---:|:---:|
| `proactive/engine.py` | ✅ 强制wrap_up + 工作日志截断 + memory计数器 | O2.1 成本记录 / O3.2 增量巡检 |
| `proactive/runner.py` | ✅ TTL回收 + tick调度 | O2.3 预算熔断 / O3.1 事件触发 / O3.3 无事降频 |
| `proactive/repositories.py` | ✅ list_stale_executing | O1.1 审批超时分级 / O2.1 成本表 |
| `proactive/submit_work.py` | ✅ journal去重 | — |
| `proactive/models.py` | — | O1.1 超时配置 / O2.3 预算字段 / O6.1 KPI结构化 |
| `proactive/decision_gate.py` | — | O1.1 超时分级 / O1.4 拒绝原因 |
| `proactive/prompt.py` | — | O1.3 超时重新评估提示 |
| `proactive/router.py` | — | O2.2 成本接口 / O4.1 看板接口 / O5.3 重叠检测 |
| `channels/feishu.py` | — | O1.2 飞书卡片深链 |
| `evopanel/src/pages/proactive-employee.js` | — | O1.2 审批页 / O2.2 成本展示 / O4.1 看板 |
| 新增 `proactive/triggers.py` | — | O3.1 事件触发架构 |
| 新增 `proactive/kpi_checker.py` | — | O6.1 KPI 自动度量 |

### C. 已修复的三道防线

修复后的 executing 死循环问题有三层防御：

```
① 源头（engine.py）  本轮忘交班 → 强制合成 wrap_up
② 入口（submit_work） 新一轮开工前 → 关闭上一轮的 check_in
③ 兜底（runner.py）   超 6 小时未收尾 → 自动标 FAILED
```

任何一层都能独立阻断死循环，加上工作日志折叠，AI 不会再被僵尸记录诱导进入反馈循环。
