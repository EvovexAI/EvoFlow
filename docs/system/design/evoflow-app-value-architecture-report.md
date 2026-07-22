# EvoFlow「应用（App）」价值与架构分析报告

> 文档类型：产品 + 架构说明（解释性文档）  
> 日期：2026-07-14  
> 关联：[`docs/system/design/app-design.md`](app-design.md)、[`docs/system/api/apps-api.md`](../api/apps-api.md)、[`docs/user/explanation/why-evoflow.md`](../../user/explanation/why-evoflow.md)

---

## 1. 摘要

**EvoFlow 应用 = 可直接运行的多智能体作业流程（SOP）**：流程与角色一次定稿，之后通过少量参数反复开跑。

它解决的不是「第一次怎么探索未知需求」，而是：

> **同一类已经跑通的活，不想每次从零对话、从零规划、从零确认，又希望结果形态可控、可交接。**

一句话产品定义：

| 概念 | 定义 |
|------|------|
| **智能体** | 「谁会干活」——能力、工具、技能、人设 |
| **应用** | 「这件事怎么干完」——步骤 DAG、参数槽、执行模式；可填参复用 |
| **运行（AppRun）** | 某次具体开跑——参数快照 + 进度 + 关联任务 |

应用**可以**只含一个智能体（单步 SOP），也可以串多个智能体（多部门流水线）。人数不是定义本身；**可复用流程 + 参数化输入**才是定义。

---

## 2. 要解决的问题

### 2.1 用户侧痛点

| 痛点 | 没有应用时 | 有应用之后 |
|------|------------|------------|
| 重复劳动 | 同类任务每次重说需求、重出 plan、重确认 | 只填会变的字段再跑 |
| 结果漂移 | 每次临场派工，步骤/工具可能不一致 | `assigned_agent` / tools / skills / 依赖固化 |
| 难交接 | 惯例藏在聊天记录与个人习惯里 | 列表里的可点「能力」，同事填表即可 |
| 批量与无人值守成本高 | 人肉盯每一次确认 | 纯工作流模式换参连跑 |
| 协作结构难沉淀 | 满意的一次协作无法产品化 | 对话/任务 → 沉淀为 App |

### 2.2 组织侧痛点

- **能力无法资产化**：Agent 配得再好，没有「标准作业」层，组织仍依赖「会开会话的人」。
- **无法规模化运营**：重复业务不能变成可审计、可计量的运行次数（AppRun）。
- **探索与交付混在一起**：探索期需要发散；交付期需要收敛。缺少分层会持续用「聊天」扛「流水线」。

### 2.3 明确不解决的问题

| 不负责 | 原因 |
|--------|------|
| 替代所有开放域对话 | 结构未定型时仍应用聊天 + Lead |
| FastGPT 式插件节点引擎 | 节点语义是 Agent 步骤，不是 HTTP/知识库/代码块拼装 |
| 自动发明全新业务流程 | 应用假设「怎么干」已被人确认过 |

---

## 3. 价值主张

### 3.1 当下价值

1. **时间**：去掉重复的 plan / 确认环路。  
2. **稳定性**：同应用多次运行，协作拓扑一致。  
3. **门槛**：业务方不必理解 DAG，只需填参数。  
4. **与现有栈对齐**：渲染后走既有 Plan → SubTask → Supervisor/Workflow 执行链，不另造一套运行时叙事。

### 3.2 中长期价值

Agent 能力增强后，边际成本下降的是「单次智力劳动」；稀缺的变成：

1. **稳定的作业方式**（谁、顺序、验收）  
2. **清晰的变化维度**（参数设计）  
3. **可运营的开跑入口**（权限、历史、失败归因）

「应用 + 参数」把临场多智能体协作收成 **可运营的数字 SOP**——这与 Crew / 企业内部 Agent Hub /「GPTs + Actions」同属一个产业方向：**固化流程，开放输入**。

### 3.3 价值成立的前提（不满足则体感弱）

| 成立 | 不成立（会觉得「没用」） |
|------|--------------------------|
| 同结构任务重复出现 | 每次任务结构全新 |
| 流程可说清、可验收 | 仍在探索、步骤天天改 |
| 参数能收敛到少量（建议 ≤5） | 「整件事」都必须长篇口述 |
| 有人愿意做「第一次定稿」 | 只想永远即时聊天 |

**判断标准**：能否说出「这件事下周还会干，干法基本一样，只有 X、Y 会变」。说得出 → 应用有价值；说不出 → 继续聊天。

---

## 4. 核心概念模型

### 4.1 三层运行对象

```
App（应用定义）
  ├─ parameters[]     参数槽（运行时填写）
  ├─ steps[]          DAG 步骤（执行真相）
  ├─ canvas           画布布局（仅 UI；可选）
  ├─ goal_template    总目标模板（可含 {{param}}）
  └─ execution_mode   workflow | lead_supervised
        │
        │  run(parameters)
        ▼
AppRun（运行实例）
  ├─ parameters 快照
  ├─ status / progress
  └─ task_id / thread_id
        │
        ▼
SubTask 波次执行（复用 collab 子任务与调度）
```

### 4.2 智能体 vs 应用

| 维度 | 智能体 | 应用 |
|------|--------|------|
| 本质 | 能力角色 | 作业流程（SOP） |
| 复用物 | 「谁会干活」 | 「怎么干完 + 这次填啥」 |
| 典型形态 | 可被多个 App 雇佣 | 可雇佣一个或多个 Agent |
| 用户动作 | 配置人设/工具/技能 | 配置流程后填参开跑 |

**易混点纠正**：不是「多智能体 = 应用、单智能体 = 非应用」。  
单智能体也可包成单步应用；多智能体更需要应用来编排。差别是 **角色** vs **流程资产**。

### 4.3 参数化边界（写死规则）

| 可参数化（内容） | 不参数化（结构） |
|------------------|------------------|
| `goal` / `name` / `inputs` / `outputs` / `acceptance` / `instruction` 中的文案 | `assigned_agent` |
| `goal_template` | `tools` / `skills` |
| 少量业务变量（品牌、路径、版本号…） | `depends_on` |

原则：**骨架稳定，血肉可变。** 把结构字段做成参数，应用会退化成「每次重新编排」。

### 4.4 两种执行模式

| 模式 | 适用 | 行为概要 |
|------|------|----------|
| **workflow（纯工作流）** | 标准化、批量、无人值守 | 无 Lead 介入，DAG 按依赖波次自动推进 |
| **lead_supervised** | 仍需确认/干预 | 绑定会话，走 plan 确认与监督路径 |

---

## 5. 架构模式

### 5.1 在 EvoFlow 四层中的位置

```
EvoPanel（应用中心 / 画布编辑器 / 运行表单）
        │  REST
Gateway  /api/apps*
        │
Harness  collab.app_*  （定义、渲染、运行分发）
        │
既有执行面  Plan → sync_subtasks → Supervisor / WorkflowRuntime
```

应用是 **产品层编排资产**，不替代 Harness 内核；它复用 Plan/SubTask 体系，避免「第二套任务系统」。

### 5.2 双轨存档（执行轨 + 视觉轨）

| 轨 | 存储 | 职责 |
|----|------|------|
| **执行轨** | `steps_json` | agent / tools / skills / depends_on / 文案（可含 `{{param}}`） |
| **视觉轨** | `canvas_json` | nodes / edges / position / viewport（对齐常见流程图存档形态） |

一致性规则：

- **保存时**：由画布边推导 `depends_on`，同时写完整 `canvas_json`；经 `normalize_app_document`（`tools`/`skills`→`string[]`，剥离 `steps[].canvas`）
- **加载时**：优先 `canvas_json` 恢复布局；缺失则从旧 `step.canvas` + `depends_on` 回填  
- **运行时**：runner **只读 steps**（经参数渲染），忽略 canvas  

该模式借鉴 FastGPT「图 JSON 落库」的存档体验，但 **节点语义保持 Agent 步骤**，不引入插件节点类型。

### 5.2.1 与 Plan / 任务表：一套定义，物化到执行面（不是三套主数据）

```
evoflow_apps  ──run──►  render_plan(内存)
                 ├─► evoflow_app_runs（运行账本）
                 └─► evoflow_collab_tasks.plan_* + subtasks（当次执行实例）
```

会话里手动 `plan` / 任务中心看到的 `plan_steps_json`，与 App 跑出来写入的是**同一执行面结构**。App 表只存模板；Task/Subtask 存「这一单」物化结果。详见 `docs/system/design/app-design.md` §3.1.1 与 `evoflow.collab.app_schema` 模块注释。

### 5.3 运行管线（逻辑）

```
校验 parameters
    → render_plan(app, parameters)   # {{param}} → 实参
    → 生成 AppRun
    → 按 execution_mode 分发
         ├─ workflow → WorkflowRuntime / 无人值守式 DAG 推进
         └─ lead_supervised → 绑定 thread，进入 plan 监督链路
    → 进度回写 AppRun；详情仍可进任务中心
```

关键模块（实现层）：

| 模块 | 职责 |
|------|------|
| `app_repositories` | App / AppRun 持久化 |
| `app_engine.render_plan` | 参数渲染 |
| `app_runner.run_app` | 模式分发与运行入口 |
| `app_extractor` / `app_generator` | 从 plan/任务抽取参数并生成 App |
| `evopanel` 应用页 + `AppWorkflowCanvas` | 列表、画布、填参运行 |

### 5.4 与相近模式对照

| 模式 | 像什么 | EvoFlow App 的取舍 |
|------|--------|-------------------|
| **CrewAI Crew** | Crew + Agent + Task + kickoff(inputs) | **里子相似**（流程 + inputs）；**面子不同**——面向产品填表，而非 SDK/YAML 优先 |
| **FastGPT 应用** | 可视化工作流 + 变量 | **抄存档与编辑体验**；不抄插件节点与其执行引擎 |
| **聊天中的 Plan** | 当次任务规划 | App 是 Plan 的**产品化沉淀**，不是替代探索聊天 |
| **定时/自动化任务** | 时间触发 | App 是「能力定义」；可被定时或手动触发消费 |

推荐定位口号：

> **里子像 Crew，面子像可安装的企业内部应用，编辑器体验借鉴流程图产品。**

### 5.5 推荐架构原则（模式级）

1. **探索 / 交付两段式**：聊天探索 → 满意后「另存为应用」→ 之后填参交付。主对话 Plan 确认条与任务详情均挂入口（`POST /tasks/{id}/save-as-app`）。  
2. **单主路径消费**：日常路径应是「应用中心 → 填参 → 运行」，画布仅用于改流程。  
3. **步骤是 Agent，不是插件**：能力挂在智能体与 tools/skills 上。  
4. **参数宜少而业务化**：名称用「竞品名 / 仓库路径」，不用工程黑话。  
5. **结构字段冻结**：避免把编排本身参数化导致 SOP 倒塌。

---

## 6. 用户旅程与用法

### 6.1 生命周期

```
① 探索：聊天 / Lead 协作，跑通一次
② 沉淀：另存为应用或 AI 生成 App（抽取 {{param}}）
③ 定稿：人工核对参数标签、默认值、执行模式；必要时改画布
④ 复用：应用中心反复填参运行
⑤ 演进：流程变了再打开画布改一版并发布新 version
```

### 6.2 复杂办公 + 写码示例（复用长什么样）

**应用：`版本小需求交付`**

参数：`requirement`、`repo_path`、`base_branch`、`assignee_note`、`release_tag`

固定步骤：

1. 分析 Agent → 拆任务与验收  
2. 实现 Agent → 在仓库落地  
3. 调试 Agent → 构建/测试到绿  
4. 写作 Agent → 写给人看的 Changelog  

每周换需求与版本号即可连跑；不必重新编排四人分工。

### 6.3 简单示例（单智能体也可成应用）

**应用：`竞品快报`**——单步调研 Agent + `brand` / `format` 两参数。  
此时用户体感像「点开一个 Agent 应用」，实现上仍是 **App 包住 Agent**，保持模型干净。

---

## 7. 同类产品与市场对照

市场上有大量「可复用 AI 流程」产品，但大多落在两条谱系上：**SaaS 工作流应用**（可视化 + 变量 + 填参跑）与 **多 Agent 开发框架**（Crew / Graph + inputs）。EvoFlow App 位于二者交叉带：**桌面本机 Agent 运行时 + 以智能体为节点的 SOP + 对话沉淀成可填参应用**。

### 7.1 最接近的同类

| 产品 / 方向 | 像在哪 | 与 EvoFlow App 的主要差异 |
|-------------|--------|---------------------------|
| **FastGPT** | 应用、工作流画布、变量、发布后填参跑 | 节点偏 LLM / 知识库 / HTTP / 条件等**插件类型**；云端/SaaS 基因强。EvoFlow 节点是 **Agent 步骤**（tools/skills），且绑定本机 Harness |
| **Dify** | 应用 / Workflow、输入变量、可视化编排 | 同样偏模型应用与工具节点生态；企业云部署常见。EvoFlow 强调本机多智能体协作与任务中心闭环 |
| **扣子 Coze** | Bot/工作流、发布为可复用能力 | 消费级/平台分发强；Agent 深度与本机工具链弱于 EvoFlow 桌面运行时 |
| **CrewAI**（含 Studio） | Crew + Agent + Task + `kickoff(inputs)` | **心智最接近**（流程固定、inputs 复用）；偏 **框架/开发者**，不是 EvoPanel 式业务填表产品 |
| **Microsoft Agent Framework / AutoGen 生态** | 多 Agent Team、可复用协作结构 | 平台与代码集成导向；业务用户「应用中心」体验需自建 |
| **LangGraph Platform / LangSmith 部署** | 图工作流可部署、可重复调用 | 开发者平台；填参 UX、桌面 Agent 工具链不在产品默认范围内 |
| **n8n / Make + AI Agent 节点** | 固化流程、变量、触发器、反复执行 | 传统 iPaaS 基因；多 Agent 分工、本机写码/沙箱等深度通常不如专用 Agent 产品 |

### 7.2 相关但不全同类

| 产品 / 方向 | 关系说明 |
|-------------|----------|
| **ChatGPT GPTs / Projects** | 「可复用助手 + 指令」接近单步应用；多 Agent 流水线与本机工具弱 |
| **Cursor / Copilot Workspace 类** | 偏写码会话与工程任务，不是组织级可填参 SOP 目录 |
| **飞书 / 钉钉智能伙伴、各类 Agent 商店** | 「应用分发」形态接近；编排深度与是否本机 Agent 运行时因产品而异 |
| **EvoFlow 会话内 Plan / 任务中心** | 同属本产品能力栈：Plan = 当次探索与交付；App = Plan 的**产品化沉淀**，不是外部竞品 |

### 7.3 定位一句话

| 谱系 | 对应 |
|------|------|
| SaaS 工作流应用（FastGPT / Dify / Coze） | 外壳：应用中心 + 画布 + 变量 |
| 多 Agent 框架（CrewAI 等） | 内核心智：多角色 + inputs 复用 |
| **EvoFlow App** | 交叉点：本机 Agent 运行时 + Agent 步骤 DAG + 对话沉淀 + 填参开跑 |

**结论（竞品）：** 有同类，没有完全同构的「EvoFlow App」副本。对外叙事可写：

> 交互与资产形态对齐「工作流应用产品」，协作语义对齐「Crew 式多 Agent + inputs」，运行与工具绑定「本机 EvoFlow Agent」，而不是再做一个云端插件流程图。

### 7.4 差异化检查清单（产品决策用）

做功能取舍时可对照：是否强化下列差异，而不是追平 FastGPT 插件库——

1. 节点是否始终是 **智能体 + tools/skills**（拒绝无意义堆插件）  
2. 是否打通 **会话 / 任务 → 另存为应用** 的沉淀漏斗  
3. 是否默认强调 **填参运行** 主路径（画布为改流程，不为日常入口）  
4. 是否发挥 **本机路径、终端、仓库、沙箱** 等桌面优势（写码/办公交付场景）  
5. 是否与任务中心 / AppRun 历史形成可审计闭环  

---

## 8. 边界与风险

| 风险 | 说明 | 缓解 |
|------|------|------|
| 过早产品化 | 流程未稳就固化，改应用比聊天还烦 | 明确「跑稳 2～3 次再沉淀」 |
| 参数爆炸 | 参数过多等于长问卷 | ≤5 为默认纪律；其余写死在 instruction |
| 与任务中心概念重叠 | 用户分不清 App / Task / 会话 | 文案区分：应用=能力，运行/任务=这一次 |
| 画布喧宾夺主 | 用户以为价值在「画画」 | 强化列表「运行」主路径 |
| 模式误选 | 探索任务却用纯工作流 | 默认可建议；复杂变更引导 Lead 模式 |
| 竞品同质化 | 做成「又一个 Dify/FastGPT」 | 守住 §7.4 差异化清单，不堆插件节点 |

---

## 9. 成功度量（建议）

| 指标 | 含义 |
|------|------|
| 二次运行率 | 同一 App 被运行 ≥2 次的比例 |
| 填参到达率 | 从打开应用到完成参数提交的转化 |
| 画布编辑频率 | 相对运行次数应较低（过高说明未定型或参数设计失败） |
| 参数个数分布 | 中位数是否落在 2～5 |
| 从会话另存为 App 的次数 | 沉淀漏斗是否通 |

**P0 闭环（已实现）**：列表「运行」= 填参表单（不进画布）；任务详情「另存为应用」；workflow 显式 run 必授权派发；Lead 缺 `thread_id` 时后端建会话；应用设置可编辑参数槽；`get_run_status` 回写 AppRun。

---

## 10. 结论

1. **应用的价值**在于把多智能体协作从「每次临场对话」升级为「可填参复用的 SOP 资产」。  
2. **解决的问题**是重复、漂移、难交接、难批量——不是替代探索。  
3. **架构模式**是：参数渲染 + Agent 步骤 DAG + 双轨存档（steps/canvas）+ 复用既有 Plan/SubTask 执行面；产品形态对齐 Crew 的 kickoff(inputs)，交互对齐「企业应用」而非编排框架。  
4. **市场位置**是 SaaS 工作流应用与多 Agent 框架的交叉带；有同类（FastGPT/Dify/Coze/CrewAI 等），差异在本机 Agent 运行时、Agent 步骤语义与对话沉淀漏斗（见 §7）。  
5. **未来价值**取决于组织是否持续产生「结构稳定、输入可变」的工作；在该前提成立时，应用层会越来越像 Agent 产品的「操作系统级能力」，而不仅是画布功能点。

---

## 11. 文档与代码索引

| 资源 | 路径 |
|------|------|
| 设计稿（数据模型 / 模式细节） | `docs/system/design/app-design.md` |
| HTTP API | `docs/system/api/apps-api.md` |
| 平台架构原则 | `docs/user/explanation/why-evoflow.md` |
| 运行入口 | `backend/packages/harness/evoflow/collab/app_runner.py` |
| 参数渲染 | `backend/packages/harness/evoflow/collab/app_engine.py` |
| App JSON 契约 / 归一化 | `backend/packages/harness/evoflow/collab/app_schema.py` |
| App 版本快照 | `evoflow_app_revisions`（schema v84）+ `app_repositories.save_revision` |
| 任务溯源字段 | 主任务 `source_app_id` / `source_run_id`（extra_json，由 `app_runner` 写入） |
| 持久化 | `backend/packages/harness/evoflow/persistence/app_repositories.py` |
| 画布与双轨前端 | `evopanel/src/react/components/AppWorkflowCanvas.tsx`、`app-workflow-canvas-json.ts` |
| 应用中心入口开关 | `evopanel/src/lib/nav-visibility.js`（`SHOW_APPS_NAV`） |
