# 智能体员工 vs「闭环全景」能力对照

> 对照图：《闭环全景 — 一个想法怎么变成真的软件｜AI 为什么骗不过这套系统》  
> 结论先说：**智能体员工 = 组织 + 值班 + 看板 Task + 审批；`superpowers-*` = 交付流程纪律（脑暴→规格→计划→TDD→评审→验收）；图里的硬 HARNESS（taskctl / run.sh 判决 / 空气墙双模型 / 进化回流）仍未接到值班闭环。**  
> 三者叠在一起才接近图；现在是「员工编制 + Superpowers 软闭环」有了，**硬判决还缺**。

---

## 1. 图在说什么（一句话）

把「想法」变成「可发布软件」靠的不是某个模型嘴硬，而是：

1. **阶段门禁**：PLAN → CONTRACT → DESIGN → BUILD → SHIP  
2. **执行引擎（HARNESS）**：总承包不写业务码，只编排；看板是唯一真相；任务包给最小上下文；Worker 在隔离环境 TDD；硬检查 + `run.sh` 判决；证据独立落账；双模型评审防串通  
3. **人类时刻**：产品确认、砍范围、放闸发布、UI 拍板、HOLD 仲裁  
4. **进化回流**：问题 → 教训 → 守卫脚本 → 每轮 reconcile  

AI 可以漂移、幻觉、隐瞒；**证据与判决独立**，所以「骗不过」。

---

## 2. 你现在有的三层能力（别混在一起）

| 层 | 是什么 | 在仓库里 |
|----|--------|----------|
| **A. 智能体员工** | 岗位编制、心跳值班、组织上下级、岗位工作项看板、审批 | `proactive/` + EvoPanel「智能体员工」 |
| **B. Superpowers 技能族** | 软闭环：脑暴 / 规格 / 计划 / worktree / TDD / 子代理驱动 / 评审 / 验收前验证 / 收尾 | `skills/public/superpowers-*`；产物约定见 `docs/user/evoflow/artifacts/README.md` |
| **C. 聊天 HARNESS** | 小V（`xiaomi`）前台传讯 + Plan → 你授权 → `supervisor` 拆派 DAG；默认聊天 `main` 为通用超级助手 | `agents/xiaomi/` + collab / supervisor；**值班中间件默认禁用 plan/supervisor** |

图要的是 **A + B + C + 硬判决**。你已有 A、B，C 在聊天里部分有；硬判决（taskctl / run.sh / 空气墙 evaluator）仍弱或缺失。

---

## 3. Superpowers 对照图（软闭环你其实已经有）

仓库内技能 ID 为 `superpowers-*`（上游 `superpowers:` 的 `:` → `-`）。项目工种子智能体已按角色挂 wishlist（见 `project_crew.py`）。

| 图阶段 / 组件 | 对应 Superpowers 技能 | 能补到什么程度 |
|---------------|----------------------|----------------|
| **PLAN** SPEC / 澄清 | `superpowers-brainstorming`、`superpowers-using-superpowers` | ✅ 流程：先澄清再动手；产出可进 `docs/user/evoflow/runs/<run-id>/` |
| **CONTRACT / DESIGN** | brainstorming 分段认可 + writing-plans 前的 spec | 🟡 纪律有、机器契约闸没有 |
| **任务包 / 计划** | `superpowers-writing-plans` | ✅ 咬口任务清单（Files / Steps / 验证命令）≈ 软任务包 |
| **Worker · worktree** | `superpowers-using-git-worktrees` | ✅ 复杂变更可隔离工作区（靠技能遵守，非强制沙箱） |
| **Worker · TDD** | `superpowers-test-driven-development` | ✅ 红→绿→重构纪律 |
| **编队执行** | `superpowers-subagent-driven-development`、`superpowers-executing-plans`、`superpowers-dispatching-parallel-agents` | 🟡 聊天/子代理路径可跑；**值班岗默认不能当总承包拉编队** |
| **硬检查前的自证** | `superpowers-verification-before-completion` | 🟡 「完成前验证」是软闸，不是 run.sh 判决器 |
| **评审 ≈ 弱 rebuttal** | `superpowers-requesting-code-review`、`superpowers-receiving-code-review` | 🟡 有评审流程；**不是**双模型空气墙防串通 |
| **排障** | `superpowers-systematic-debugging` | ✅ 对齐 Bug 分析师 |
| **收尾 / 分支** | `superpowers-finishing-a-development-branch` | 🟡 接近 SHIP 前整理，不是 RC 放闸 |
| **证据落账（文档侧）** | 统一落到 `docs/user/evoflow/runs/<run-id>/`（01-brief…99-summary） | 🟡 文件真源有了；未与 Task「完成」硬绑定 |
| **run.sh / taskctl / 进化回流** | — | ❌ Superpowers 不替代硬基础设施 |

**岗位建议挂载（可写进员工 `config.skills`，与已启用技能求交）：**

| 岗位 | 建议 skills |
|------|-------------|
| 产品经理 | `superpowers-brainstorming`、`superpowers-using-superpowers` |
| 技术总监 | `superpowers-writing-plans`、`superpowers-requesting-code-review` |
| 前端 / 后端工程师 | `superpowers-executing-plans` 或 `subagent-driven-development`、`test-driven-development`、`using-git-worktrees`、`verification-before-completion` |
| Bug 分析师 | `superpowers-systematic-debugging`、`dispatching-parallel-agents` |
| 产品传播 | （可选）brainstorming；主战场仍是 docs/website |

> 注意：技能是**提示词级纪律**。值班路径会把岗位 `config.skills`（或内置默认 kit）注入 duty brief 的 `<skill_system>`，并写入 run `preferred_skills`；员工需 ``read("skill:<名>")`` 后按步骤执行。**不会**自动变成图里的 PASS/FAIL 判决器。

---

## 4. 你现在的智能体员工是什么

当前名册（对 EvoFlow / haze-ctrl）：

| 岗位 | agent_code | 角色定位 |
|------|------------|----------|
| **小V**（用户全局前台） | `xiaomi` | 接待、传讯、分诊；**常驻心跳催办**未结 Task（`agents/xiaomi/duty.py`）；不亲自一线工程。**不占用**默认主智能体 `main`（超级助手） |
| 产品经理 | `product-manager` | 提需求、写验收、跨岗交接、盯看板 |
| 技术总监 | `quality-inspector` | 拆技术任务、派工、把关集成 |
| 前端工程师 | `code-agent` | EvoPanel 实现与体验 |
| 后端工程师 | `project-implementer` | Gateway / harness 实现 |
| Bug 分析师 | `project-debugger` | 复现、证据、闭环或移交 |
| 产品传播 | `marketing-social-media-operation` | 官网/文档对外表达 |

运行机制：

- **心跳值班**（RRULE + 上班时间）→ 读岗位职责 / 组织架构 → 用 CLI 建/改 **岗位工作项 Task**
- **跨岗**：`tasks create` + `employees wake`（聊天 @ **不会**叫醒对方）
- **风险闸**：`approvals request` → 你批准后才允许下游实现类动作（约定层面）
- **低风险**：批准后可走单次 ExecutionBridge；**不能**在值班里自己拉起 supervisor 多 Worker DAG
- **若启用 Superpowers**：同一岗在可加载 skills 的会话里，可按上表跑软闭环（规格/计划/TDD/验证）

---

## 5. 能力矩阵：图的每一块，员工 + Superpowers 能不能干

图例：✅ 能 · 🟡 部分能 · ❌ 不能（或值班路径明确封死）

### 5.1 五阶段流水线

| 阶段 | 图要求 | 仅员工 | + Superpowers | 说明 |
|------|--------|--------|---------------|------|
| **PLAN** | SPEC、价值/风险、跨模型评审 | 🟡 | 🟡→偏 ✅ | brainstorming + runs 目录规格；仍无强制跨模型评审闸 |
| **CONTRACT** | 交互契约、数据跑得通 | 🟡 | 🟡 | 审批 + 计划里的验收项；无机器契约校验 |
| **DESIGN** | No API no UI、mock | 🟡 | 🟡 | 「先设计后实现」靠技能；无硬门禁 |
| **BUILD** | 切片、闭环编译 | 🟡 | 🟡→偏 ✅ | TDD + worktree + executing-plans；仍非强制绿构建闸 |
| **SHIP** | 上线审计 → RC | ❌ | 🟡 | finishing-branch / verification；无产品级 RC 放闸 |

### 5.2 HARNESS（图中绿区核心）

| 组件 | 图要求 | 仅员工 | + Superpowers | 说明 |
|------|--------|--------|---------------|------|
| **主 Agent · 总承包** | 协调不写业务码 | ❌ 值班 | 🟡 聊天 | 聊天 lead + plan/supervisor；值班仍禁 orchestration |
| **BACKLOG 看板** | 唯一真相源 | 🟡 | 🟡 | 岗位看板 + runs 文件索引；非统一阶段 BACKLOG |
| **taskctl 审核闸** | 前置不满足不许开工 | 🟡 | 🟡 | approvals +「完成前验证」技能；无 taskctl |
| **任务包编译** | 最小上下文打包 | ❌ | 🟡 | writing-plans 的 bite-sized task ≈ 软任务包 |
| **Worker 编队** | worktree / TDD | 🟡 | ✅ 流程 | 技能链齐全；值班仍是单代理，不是系统编队 |
| **硬检查** | 编译+测试+边界 | 🟡 | 🟡 | verification + 本地测；非架构边界扫描器 |
| **run.sh 判决器** | PASS/HOLD | ❌ | ❌ | 技能不能替代判决器进程 |
| **证据落账** | 独立可审计 | 🟡 | 🟡→偏 ✅ | `docs/user/evoflow/runs/<run-id>/` + Task/trail |
| **evaluator & rebuttal** | 双模型空气墙 | ❌ | 🟡 | code-review 技能是流程评审，非空气墙双模型 |

### 5.3 人类时刻

| 人类时刻 | 现状 |
|----------|------|
| 产品确认「该不该做」 | 🟡 approvals + brainstorming 分段认可 |
| 砍范围 | 🟡 人工改 Task / 拒绝；计划里 Out of scope |
| 放闸发布 | ❌（finishing-branch 只到分支收尾） |
| UI 拍板 | 🟡 审批 / 设计分段认可 |
| HOLD 仲裁 | ❌ 无系统 HOLD |

### 5.4 进化回流

| 层级 | 现状 |
|------|------|
| V1 问题浮出 | 🟡 失败 Task / 轨迹 / systematic-debugging |
| V2 记教训 | 🟡 memory + runs 小结；无结构化 LESSON_LOGGER |
| V3 教训→守卫脚本 | ❌ |
| V4 reconcile | ❌ |

---

## 6. 岗位 ↔ 图角色 粗映射

```text
图：主 Agent（总承包）     ≈  聊天 lead + plan/supervisor
                              ≠  值班技术总监（岗，不是 HARNESS 总承包）

图：Worker 编队            ≈  code-agent / project-implementer
                              + superpowers-executing-plans / TDD / worktrees

图：审核 / 硬检查          ≈  quality-inspector + Bug 分析师
                              + verification / code-review / systematic-debugging
                              ≠  run.sh / 空气墙 evaluator

图：证据落账               ≈  docs/user/evoflow/runs/<run-id>/ + Task/trail
图：进化回流               ≈  基本没有（Superpowers 也不覆盖 V3/V4）
```

**三条轨道：**

| 轨道 | 能干啥 | 不能干啥 |
|------|--------|----------|
| **智能体员工值班** | 巡检、建 Task、wake、审批、低风险单次执行 | 值班内拉 supervisor DAG |
| **Superpowers（技能）** | 规格→计划→TDD→评审→验收前验证的**纪律与产物路径** | 替代硬判决器 / 发布闸 / 进化脚本 |
| **聊天 HARNESS** | plan → 授权 → supervisor 拆派 | 不会自动等于员工心跳 |

---

## 7. 诚实结论（更新）

**能（比上一版更完整的说法）：**  
- **编制层（员工）**：像真人部门一样值班、交单、催办。  
- **纪律层（Superpowers）**：你已经有一套与图高度同构的**软闭环**——脑暴、计划、worktree、TDD、子代理驱动、评审、完成前验证、产物落 `docs/user/evoflow/runs/`。挂到对应岗位 / 聊天会话后，**PLAN→BUILD 的「人该怎么干」大多能覆盖**。  

**仍不能自称「骗不过」：**  
缺的是图里标红的**硬东西**——taskctl、run.sh 判决、独立证据账与完成态绑定、双模型空气墙、RC 放闸、教训→守卫脚本。Superpowers 是「教练手册」，不是「闸机」。

**对齐图的最短路径：**

1. **给岗位挂上表中的 `superpowers-*` skills**（立刻提升软闭环）  
2. **桥**：岗位 Task / runs 目录 → 聊天 plan+supervisor（硬编队）  
3. **硬**：判决器 + 证据落账成为「可标完成」的必要条件  
4. **进化**：失败模式 → 守卫脚本 → reconcile  

一句话：**员工负责「谁来干」，Superpowers 负责「按什么规矩干」，图还要「不按规矩就过不了闸」。你前两层有了，第三层还要补。**

---

## 8. 一页速览

| 你问 | 答 |
|------|----|
| 员工能干图上这些事吗？ | **编制协作能**；**交付纪律靠 Superpowers 能大部分软覆盖**；**硬 HARNESS 闸还不能** |
| Superpowers 算不算图里的闭环？ | **算软闭环**（流程+产物路径）；**不算硬闭环**（判决器/空气墙/进化脚本） |
| 谁最接近「总承包」？ | 聊天 Main Agent；技术总监是岗，不是引擎 |
| 谁最接近 Worker？ | 前/后端岗 + TDD/worktree/executing-plans |
| 最缺什么？ | 硬检查判决器、完成态绑定证据、空气墙评审、发布闸、值班↔HARNESS 桥 |

*文档对照：闭环全景图 + proactive 实现 + `skills/public/superpowers-*` + `project_crew` wishlist + `docs/user/evoflow/artifacts`。*
