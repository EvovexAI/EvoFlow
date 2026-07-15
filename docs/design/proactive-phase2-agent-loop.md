# Proactive Phase 2 设计方案

> 日期：2026-07-15  
> 状态：设计中  
> 目标：让 Proactive 角色具备真正的感知能力 + 认知连续性

---

## 1. 现状问题

### 1.1 感知能力为零

Phase 1 的 `ProactiveEngine.think()` 处理方式：

```
拼文本(记忆摘要+近期事项+KPI) → 调一次 LLM → 解析 JSON → 产出事项
```

LLM 只能基于"二手信息"思考，无法主动去读代码、查日志、看 CI、扫数据库。

### 1.2 认知连续性缺失（核心问题）

每次上岗等于"失忆上岗"：

```
ProactiveMemory 只存了：
  - observations: ["lint 错误增多", "3个文件未测试"]  ← 几条文本摘要
  - strategies: ["优先清理高优先级 lint"]              ← 几条策略方向
  - last_think_summary: "上次发现了lint问题..."        ← 500字截断

Agent 不知道：
  ✗ 上次具体看了哪些文件、跑了什么命令
  ✗ 上次为什么决定做/不做某件事
  ✗ 上次产出的事项执行结果如何
  ✗ 哪些事已经处理过，不要重复
```

**人类岗位负责人怎么干的？** 上岗前先翻工作日志：上周做了什么、哪些已闭环、哪些还在跟进、哪些踩过坑。然后基于这些上下文再去看当前状态、做新决策。

### 1.3 前端定位不清

Proactive 页面目前既有管理功能又有数据展示，跟 Observability、Chat 的关系没理清。

---

## 2. 前端页面体系与 Proactive 定位

```
┌─────────────────────────────────────────────────────────────────────┐
│                         EvoPanel 前端                               │
├──────────────┬──────────────────────────────────────────────────────┤
│              │                                                      │
│  交互层       │  /chat          用户 ↔ AI 对话（主界面）              │
│  (人驱动)     │  /channels      飞书/桌面通知渠道配置                 │
│              │                                                      │
├──────────────┼──────────────────────────────────────────────────────┤
│              │                                                      │
│  调度层       │  /cron          自动化：人写 prompt + 定时跑           │
│  (定时驱动)   │  /proactive     智能体员工：AI 自主思考 + 审批         │
│              │                                                      │
├──────────────┼──────────────────────────────────────────────────────┤
│              │                                                      │
│  配置层       │  /agents  /models  /skills  /tools                   │
│  (静态配置)   │  /memory  /knowledge  /settings                      │
│              │                                                      │
├──────────────┼──────────────────────────────────────────────────────┤
│              │                                                      │
│  观测层       │  /observability  全量会话追踪/Token/延迟              │
│  (只读监控)   │  （所有 session 都在这里看，包括 proactive 的）        │
│              │                                                      │
└──────────────┴──────────────────────────────────────────────────────┘
```

### 数据流关系

```
/cron (自动化)                      /proactive (智能体员工)
  │                                   │
  │  人写 prompt                       │  AI 自己思考
  │  定时 → LangGraph run             │  心跳 → Agent loop → 事项 → 审批 → 执行
  │                                   │
  └───────────┬───────────────────────┘
              │
              ▼  都产生 chat_session + chat_message（SQLite 持久化）
              │
  /observability  ← 统一观测所有 session（包括 cron 和 proactive 的）
              │
  /chat       ← 统一交互界面（查看任何 session 的对话）
```

### Proactive 页面的职责边界

| 功能 | 在哪 | 说明 |
|------|------|------|
| 角色管理（配置/启停） | `/proactive` | 独立 UI |
| 事项列表 + 审批 | `/proactive` | 独立 UI |
| 处理过程（中间对话） | 事项详情「查看处理过程」 | **复用 chat-session 消息渲染** |
| 执行过程 | 事项详情「查看执行过程」 | **复用 chat-session 消息渲染** |
| 全量监控/统计 | `/observability` | 已有，proactive session 自动出现 |

**Proactive 页面 = 管理 + 决策入口**，不是数据展示页面。数据展示统一走 Observability 和 chat-session 消息渲染。

---

## 3. 核心设计：认知连续性

### 3.1 像人一样"翻工作日志"

```
人类岗位负责人上岗流程：
  1. 翻开工作日志 → 看上次做了什么、结果如何
  2. 看看待办清单 → 哪些事还在跟进
  3. 巡视当前状态 → 看现场/看数据/看报告
  4. 做新决策 → 基于以上全部信息

Proactive Agent 应该一模一样：
  1. 翻工作日志 → 读最近 N 次上岗的事项记录（含状态+结果）
  2. 看待办清单 → 哪些事项还在 pending/executing
  3. 巡视当前状态 → Agent loop 调工具感知环境
  4. 做新决策 → 产出新事项（避免重复、基于结果调整）
```

### 3.2 数据流全景

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Proactive 数据流全景                               │
│                                                                     │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐      │
│  │ 角色配置  │    │ 处理     │    │ 事项     │    │ 执行     │      │
│  │          │───▶│ (Agent   │───▶│ (决策    │───▶│ (LangGraph│     │
│  │ 职责/KPI │    │  loop)   │    │  产物)   │    │  run)    │      │
│  │ 工具/技能 │    │          │    │          │    │          │      │
│  └──────────┘    └────┬─────┘    └────┬─────┘    └────┬─────┘      │
│       │               │               │               │            │
│       │          ┌────▼─────┐    ┌────▼─────┐    ┌────▼─────┐      │
│       │          │chat_     │    │evoflow_  │    │chat_     │      │
│       │          │sessions  │    │proactive_│    │sessions  │      │
│       │          │+ messages│    │initiativ.│    │+ messages│      │
│       │          │(处理过程) │    │s (事项)  │    │(执行过程) │      │
│       │          └────┬─────┘    └────┬─────┘    └────┬─────┘      │
│       │               │               │               │            │
│       │          ┌────▼─────────────▼─────────────────▼─────┐      │
│       └─────────▶│         ProactiveMemory                   │      │
│                  │  (从上述数据中提炼的工作摘要)               │      │
│                  │  - 近期事项状态汇总                         │      │
│                  │  - 执行结果摘要                             │      │
│                  │  - 策略调整方向                             │      │
│                  └───────────────────────────────────────────┘      │
│                                                                     │
│  下次上岗时：                                                     │
│    Agent 先读 ProactiveMemory + 近期 Initiative 列表                 │
│    → 知道做过啥、结果如何 → 避免重复 → 基于结果调整                   │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.3 处理阶段的信息输入（工作日志 + 主动查询）

Agent 获取历史信息分两层：

```
┌─────────────────────────────────────────────────────────┐
│  第一层：被动接收（user prompt 里直接塞的）                │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ① 角色身份（system prompt）                             │
│     - 你是「XX负责人」                                   │
│     - 职责/管辖范围/KPI                                  │
│     - 自主权级 + 输出格式要求                             │
│                                                         │
│  ② 工作日志摘要（user prompt 核心部分）                   │
│     - 最近 N 次上岗的事项列表（概要）：                    │
│       ├─ [✅已完成] 清理 lint 错误 → 修复8个,4个待确认   │
│       ├─ [❌已拒绝] 重构数据库 → 人类拒绝,原因:暂不需要   │
│       ├─ [⏳执行中] 补充单元测试 → 完成60%               │
│       └─ [🔔待审批] 优化 CI 配置 → 等待人类审批           │
│     - 每条只有：标题 + 状态 + 结果摘要（200字截断）        │
│                                                         │
│  ③ 角色记忆（ProactiveMemory）                           │
│     - 历史观察 + 策略方向 + 上次反思                      │
│                                                         │
├─────────────────────────────────────────────────────────┤
│  第二层：主动查询（Agent 调用工具自己查）                  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ④ proactive_history 工具                               │
│     - list: 查最近 N 条事项（可筛选状态）                 │
│     - detail: 查某条事项的完整信息                        │
│       (含完整行动计划、执行结果、决策依据)                 │
│     - session: 查某次上岗的完整对话记录                   │
│       (通过 round_id 查 chat_messages)                  │
│                                                         │
│  使用场景：                                              │
│  - 看到摘要里有条"被拒绝"的，想看具体拒绝原因             │
│  - 看到"执行中"的，想查进展到哪了                         │
│  - 想回顾上次完整的处理过程，避免重复分析                  │
│  - 想对比上次和这次的环境变化                             │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

#### proactive_history 工具设计

```python
@tool("proactive_history")
def proactive_history(
    action: str,  # "list" | "detail" | "round"
    *,
    initiative_id: str | None = None,
    round_id: str | None = None,
    status: str | None = None,
    limit: int = 10,
) -> str:
    """查询你自己的历史工作记录。

    action=list: 查看最近的上岗记录列表
    action=detail: 查看某条事项的完整信息（行动计划、执行结果、决策依据）
    action=round: 查看某次上岗的完整对话记录（你当时看了什么、怎么想的）
    """
```

这个工具让 Agent 从"被动接受摘要"升级为"主动翻阅工作档案"，跟人上岗前翻文件夹一样。

### 3.4 目标→结果闭环

每次上岗不是"随便看看"，而是有明确目标，做完有结果。

#### 数据模型

```python
@dataclass
class Initiative:
    # ... 现有字段 ...
    round_id: str | None = None   # 本次上岗的轮次 ID（用于定位该轮完整对话）
    goal: str = ""                # 本次上岗目标（Agent 自己定的）
    outcome: str = ""             # 本次上岗结果总结
    # 不需要存 session_key，角色共用一个固定会话
    # 通过 round_id 定位某次上岗的完整对话
```

#### 工作日志展示效果

```
## 工作日志

✅ 2026-07-15 14:30  目标: 检查代码质量并清理 lint 错误
   结果: 发现12个lint错误，已修复8个，4个需人工确认
   产出: 2个事项

❌ 2026-07-15 12:30  目标: 优化数据库查询性能
   结果: 被拒绝 — 人类认为当前性能可接受，暂不需要优化
   产出: 1个事项（已拒绝）

⏳ 2026-07-15 10:30  目标: 补充核心模块单元测试
   结果: 执行中，已完成 60%
   产出: 1个事项（执行中）
```

#### Agent 输出格式扩展

ThinkResult JSON 增加 `goal` 和 `outcome`：

```json
{
  "goal": "本次上岗的目标：检查代码质量并清理 lint 错误",
  "observations": ["发现12个lint错误", "..."],
  "initiatives": [...],
  "outcome": "结果总结：发现12个错误，修复8个，4个需人工确认",
  "reflection": "反思：lint错误持续增多，建议增加 pre-commit hook"
}
```

#### 闭环价值

| 维度 | 没有目标/结果 | 有目标/结果 |
|------|-------------|------------|
| Agent 认知 | 不知道上次为啥上岗 | 清楚上次目标+结果，决策有依据 |
| 人类理解 | 只看到事项列表，不知道为什么 | 一眼看懂每次处理的目的和成效 |
| 去重判断 | 只能按标题匹配 | 按目标语义判断——上次目标已达成就不重复 |
| 效果评估 | 无法衡量 | 可以统计"目标达成率" |

### 3.5 去重与幂等

Agent 看到工作日志后，自然能避免重复。但 engine 层也做兜底：

```python
# 在产出事项前，检查是否已有相同标题的近期事项
existing_titles = {init.title for init in recent_initiatives}
for init_data in result.initiatives:
    if init_data["title"] in existing_titles:
        logger.info("proactive: skip duplicate initiative '%s'", init_data["title"])
        continue
    # ... 正常持久化
```

---

## 4. 感知升级：Agent Loop

### 4.1 整体流程

```
ProactiveRunner._tick()
  │
  ├─ 找到到期角色
  │
  └─ _process_role(role)
       │
       ├─ 1. 收集工作日志
       │     ├─ 近期事项列表（含状态+结果）
       │     └─ ProactiveMemory（观察+策略+反思）
       │
       ├─ 2. 复用角色固定会话 + 生成 round_id
       │     ├─ session_key = "proactive:{agent_code}"（固定不变）
       │     └─ round_id = "round:{timestamp}"（本次轮次）
       │
       ├─ 3. 启动 LangGraph Agent loop
       │     ├─ system prompt: 角色身份 + 感知方式 + 输出格式
       │     ├─ user prompt: 工作日志 + 探索指令
       │     ├─ Agent 自主调工具探索环境
       │     └─ transcript_middleware 自动持久化消息到 SQLite
       │
       ├─ 4. 解析结构化事项 JSON
       │     ├─ 去重（跳过已有相同标题的事项）
       │     └─ 每条事项写入 round_id
       │
       ├─ 5. 更新 ProactiveMemory（观察+反思）
       │
       └─ 6. 走审批/执行流程（DecisionGate / ExecutionBridge）
```

### 4.2 Engine 改造

```python
async def think(self, role, *, environment_context="", memory=None):
    if role.think_mode == "agent_loop":
        return await self._run_agent_loop(role, memory=memory)
    else:
        return await self._run_prompt_only(role, memory=memory, ...)
```

#### _run_agent_loop()

```python
async def _run_agent_loop(self, role, *, memory=None):
    # 1. 收集工作日志
    recent_initiatives = ProactiveRepository.list_initiatives(
        role_agent_code=role.agent_code, limit=20,
    )
    work_log = self._build_work_log(recent_initiatives)
    
    # 2. 生成 round_id + 复用角色固定会话
    session_key = f"proactive:{role.agent_code}"
    round_id = f"round:{utc_now_iso_z()}"
    create_new_session(session_key=session_key, title=f"[处理] {role.role_name}")
    
    # 3. 构建 prompts
    system_prompt = build_system_prompt(role)
    user_prompt = build_user_prompt(role, memory, work_log=work_log)
    
    # 4. 启动 LangGraph run
    client = get_client(url=self._langgraph_url)
    thread = await client.threads.create(metadata={
        "session_key": session_key,  # 角色固定会话 "proactive:{agent_code}"
        "round_id": round_id,        # 本次上岗轮次
        "proactive_role": role.agent_code,
    })
    run = await client.runs.create(
        thread_id=thread["thread_id"],
        assistant_id=role.agent_code,
        input={"messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]},
        config={
            "recursion_limit": role.max_turns * 10,
            "configurable": {
                "triggered_by": "proactive_engine",
                "session_mode": "agent",
                "proactive_process": True,
                "round_id": round_id,
            },
        },
    )
    
    # 5. 等待完成 + 提取输出
    final_state = await self._wait_for_run(client, thread["thread_id"], run["run_id"])
    raw_output = self._extract_final_message(final_state)
    
    # 6. 解析 + 去重 + 关联 round_id
    result = ThinkResult.from_llm_output(raw_output)
    existing_titles = {init.title for init in recent_initiatives}
    for init_data in result.initiatives:
        if init_data.get("title", "") in existing_titles:
            continue  # 跳过重复
        init = self._build_initiative(role, init_data)
        init.round_id = round_id
        ProactiveRepository.save_initiative(init)
    
    return result
```

### 4.3 工作日志构建

```python
def _build_work_log(self, initiatives: list[Initiative]) -> str:
    """把近期事项列表格式化为 Agent 可读的工作日志。"""
    if not initiatives:
        return "（暂无历史记录，这是首次上岗）"
    
    lines = ["## 工作日志（近期事项记录）\n"]
    for init in initiatives[:15]:  # 最近 15 条
        status_emoji = {
            "completed": "✅",
            "failed": "❌",
            "rejected": "🚫",
            "executing": "⏳",
            "pending_approval": "🔔",
            "proposed": "📋",
            "timeout_rejected": "⏰",
            "skipped": "⏭️",
        }.get(init.status.value, "•")
        
        line = f"  {status_emoji} [{init.status.value}] {init.title}"
        
        # 附加结果摘要
        if init.execution_result:
            # 截取前 200 字作为结果摘要
            summary = init.execution_result[:200].replace("\n", " ")
            line += f"\n    → 执行结果: {summary}..."
        
        if init.rationale:
            line += f"\n    → 决策依据: {init.rationale[:100]}..."
        
        lines.append(line)
    
    return "\n".join(lines)
```

### 4.4 Prompt 设计

#### System Prompt 新增

```
## 感知方式
你不是只能基于已有信息思考。你可以主动使用工具去探索环境：
- 读取代码文件，了解当前实现状态
- 执行命令，查看 CI 结果、git log、测试结果
- 搜索信息，了解外部依赖或行业动态
- 查询数据库，检查数据质量

在思考前，先用工具充分感知环境，再基于真实数据产出事项。

## 认知连续性
你会收到一份「工作日志」，记录了你之前每次上岗时的决策和结果。
请认真阅读：
- 已经处理过的事情不要重复发起
- 被拒绝的事项要理解拒绝原因，不要原样重提
- 执行失败的事项要分析原因，调整方案后再发起
- 执行成功的事项可以在此基础上继续优化
```

#### User Prompt 改造

```python
def build_user_prompt(role, memory, *, work_log=""):
    parts = [
        "## 你的工作日志",
        work_log or "（暂无历史记录）",
        "",
        "## 你的记忆",
        memory.summary(max_items=8) if memory else "（暂无历史记忆）",
        "",
        "## 探索指令",
        f"请以「{role.role_name}」的身份：",
        "1. 先阅读工作日志，了解之前做过什么、结果如何",
        "2. 用工具主动探索当前环境状态",
        "3. 对比工作日志和当前状态，识别需要改进的事项",
        "4. 不要重复已处理/处理中的事项",
        "5. 以 JSON 格式输出思考结果（observations + initiatives + reflection）",
    ]
    return "\n".join(parts)
```

---

## 5. 处理过程追踪

### 5.1 原则

不造新轮子，复用现有 `evoflow_chat_sessions` + `evoflow_chat_messages`。

### 5.2 会话组织

```
一个角色一个固定的"工作会话"：
  session_key = "proactive:{role.agent_code}"

  不是每次 上岗创建新会话，而是：
  - 角色首次上岗时创建会话（如果不存在）
  - 每次 上岗对话追加到同一个会话里
  - 通过 round_id 区分不同的上岗轮次

  就像"工作日志本"——一个本子，每次上岗写一页

查看时:
  前端通过 session_key 调现有 API 查消息
  按 round_id 筛选某次上岗的对话
```

### 5.3 数据模型

```python
@dataclass
class Initiative:
    # ... 现有字段 ...
    round_id: str | None = None        # 本次上岗的轮次 ID
    goal: str = ""                     # 本次上岗目标
    outcome: str = ""                  # 本次上岗结果总结
    # 不需要存 session_key，角色共用一个固定会话
    # 通过 round_id 定位某次上岗的完整对话
```

### 5.4 轮次标记

```python
# 每次上岗开始时生成 round_id
round_id = f"round:{utc_now_iso_z()}"  # 如 "round:2026-07-15T14:30:00Z"

# 创建 LangGraph thread 时，metadata 里带 round_id
thread = await client.threads.create(metadata={
    "session_key": session_key,  # 角色固定会话 "proactive:{agent_code}"
    "round_id": round_id,        # 本次上岗轮次
    "proactive_role": role.agent_code,
})

# transcript_middleware 写消息时，自动带 round_id 到 extra 字段
# 查询时按 round_id 筛选，就能拿到某次上岗的完整对话
```

### 5.5 proactive_history 工具

```python
@tool("proactive_history")
def proactive_history(
    action: str,  # "list" | "detail" | "round"
    *,
    initiative_id: str | None = None,
    round_id: str | None = None,
    status: str | None = None,
    limit: int = 10,
) -> str:
    """查询你自己的历史工作记录。

    action=list: 查看最近的事项列表
    action=detail: 查看某条事项的完整信息（行动计划、执行结果、决策依据）
    action=round: 查看某次上岗的完整对话记录（当时看了什么、怎么想的）
    """
```

### 5.6 前端展示

事项详情面板里加「查看处理过程」按钮 → 按 round_id 查消息 → 复用聊天渲染组件。

**重启安全**：session_key 固定不变，消息存在 SQLite，不依赖 LangGraph checkpoint。

---

## 6. 数据模型变更汇总

### ProactiveRole 新增字段

```python
@dataclass
class ProactiveRole:
    # ... 现有字段 ...
    
    # Phase 2 新增
    think_mode: str = "agent_loop"       # "agent_loop" | "prompt_only"
    max_turns: int = 10            # Agent loop 最大轮次
    timeout_seconds: int = 300     # 单次处理超时
    tool_groups: list[str] = field(default_factory=list)
    skills: list[str] = field(default_factory=list)
```

### Initiative 新增字段

```python
@dataclass
class Initiative:
    # ... 现有字段 ...
    round_id: str | None = None  # 本次上岗的轮次 ID（定位该轮完整对话）
    goal: str = ""               # 本次上岗目标
    outcome: str = ""            # 本次上岗结果总结
    # 不存 session_key，角色共用固定会话 proactive:{agent_code}
```

### ProactiveMemory 不变

现有结构够用，工作日志从 Initiative 表实时查询，不需要额外存。

---

## 7. 改造范围

| 文件 | 改动 |
|------|------|
| `proactive/models.py` | ProactiveRole 新增 think_mode 等字段；Initiative 新增 `round_id`/`goal`/`outcome` |
| `proactive/engine.py` | 新增 `_run_agent_loop()`；think() 分流；工作日志构建；去重逻辑 |
| `proactive/prompt.py` | system prompt 增加感知方式+认知连续性说明；user prompt 改为工作日志+探索指令 |
| `proactive/runner.py` | `_gather_environment_context()` 改为构建工作日志；传递新字段 |
| `proactive/repositories.py` | Initiative 持久化新增 round_id/goal/outcome |
| `proactive/router.py` | 角色 CRUD 支持新字段；事项详情返回 round_id/goal/outcome |
| `evopanel/src/pages/proactive.js` | 角色编辑增加 think_mode 等配置；事项详情增加「查看处理过程」按钮 |
| 测试 | agent_loop 模式 + 工作日志 + 去重逻辑的单元测试 |

---

## 8. 分步实施计划

### Step 1：数据模型 + 持久化（~30min）
- ProactiveRole 新增 think_mode/max_turns/timeout_seconds
- Initiative 新增 round_id/goal/outcome
- repositories.py + router.py 适配

### Step 2：Engine 改造（~1.5h）
- 新增 `_run_agent_loop()`
- 工作日志构建 `_build_work_log()`
- think() 分流 + 去重逻辑
- 上岗前复用角色固定会话 + 生成 round_id，完成后把 round_id 写入事项

### Step 3：Prompt 改造（~30min）
- system prompt 增加感知方式 + 认知连续性说明
- user prompt 改为工作日志 + 探索指令

### Step 4：Runner 适配（~20min）
- 传递新字段
- `_gather_environment_context()` 简化

### Step 5：前端 UI（~40min）
- 角色编辑增加 think_mode / max_turns 等配置
- 事项详情增加「查看处理过程」按钮（复用 chat-session 渲染）

### Step 6：测试 + 验证（~30min）
- 单元测试
- 手动触发验证 agent_loop + 工作日志 + 去重 + round_id 关联

**预估总工时：~4h**

---

## 9. 风险与注意事项

1. **Token 消耗**：Agent loop 模式下每次处理会多轮工具调用 + 工作日志上下文，Token 消耗显著增加。需要合理设置 `max_turns` 和心跳频率。
2. **工作日志长度**：近期事项太多时 work_log 会很长。限制最多 15 条，每条结果摘要截断 200 字。
3. **写操作约束**：处理阶段不应直接执行写操作。Phase 2 先靠 prompt 约束，后续可加 middleware 硬拦截。
4. **LangGraph 并发**：多个角色同时 think 会创建多个 run。现有 `_MAX_CONCURRENT_THINK = 2` 已有限制。
5. **去重策略**：按标题精确匹配去重。如果 Agent 换了个说法描述同一件事，暂时无法识别——后续可考虑语义去重。
