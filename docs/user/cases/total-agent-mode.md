# 案例七：多角色自动编排（Plan 模式 + 项目团队）

> **场景：你要做一个"全栈项目开发"，需要不同角色分工——方案、编码、测试、审查、部署。**
>
> EvoFlow 通过 **Plan 模式 + 项目团队（`project-*` 预设角色）** 实现多角色自动编排：主智能体自动拆解任务、为每步指定执行角色、你确认后由 supervisor 按依赖图派发、出错自动调整方案。它就像是你的"技术总监"——你告诉它"做这个"，它自己安排人干。
>
> 详细流程与提示词模板见 [项目团队与 Plan 模式协作流程](../guides/chat/project-team-plan-workflow.md) [[guides/chat/project-team-plan-workflow|项目团队与 Plan 模式协作流程]]。

## 操作步骤

### 1. 选好执行角色

项目团队内置 6 个开箱即用的预设角色（不必自己创建）：

| 角色 | 职责 |
|------|------|
| `project-architect` | 系统架构设计、技术选型、方案文档 |
| `project-planner` | 任务拆解与依赖排期 |
| `project-implementer` | 编码实现、代码落地 |
| `project-reviewer` | 代码审查、质量把控 |
| `project-debugger` | 复现 bug、定位根因、出修复方案 |
| `project-qa` | 跑测试、检对验收标准 |

需要自定义角色时参考[案例二](create-agent.md) [[cases/create-agent|案例二]]。

### 2. 切换到 Plan 模式

在对话页面的模式切换中，选择 **「Plan」** 模式，并把角色指定写进任务描述。

### 3. 描述任务

```
帮我做一个全栈博客项目，技术栈 FastAPI + React + SQLite。
让 project-architect 先出设计方案，project-implementer 编码，
project-qa 写测试，project-reviewer 最后审查代码质量。
```

### 4. 确认计划后自动执行

主智能体会自动：

1. **拆解任务**：用 `plan` 工具把"全栈博客项目"拆成带依赖的步骤（方案 → 后端 API → 前端 → 测试 → 审查）
2. **分配角色**：每步指定 `assigned_agent` 与 `depends_on`
3. **你确认计划**：计划可修改，点「开始执行」后由 supervisor 按 DAG 派发
4. **监督进度**：每个子任务完成后检查结果再派下一个；失败时自动分析原因并调整

### 5. 查看结果

所有子任务完成后输出整合后的最终结果。你可以在任务中心看到完整的 DAG 工作流。

## 进阶：编排 + 智能体员工

如果任务需要长期值守（比如"持续开发新功能"），可以：

1. 用 Plan 模式跑通一次完整的开发流程
2. 把流程另存为工作流
3. 雇佣一个"项目管理员"员工，职责是"每周一运行项目开发应用，跟进开发进度"

这样 Plan 模式负责"编排"，员工负责"值班"——形成完整的生产力闭环。

## 与智能体员工的关系

| 维度 | Plan 模式多角色编排 | 智能体员工 |
|------|----------------|-----------|
| 本质 | 一次性的多角色任务编排 | 长期的定时值班岗位 |
| 触发 | 你说"开始"它就干 | 到点自动上班 |
| 角色 | 调度多个子智能体 | 单个岗位专注职责 |
| 产出 | 一次性交付物 | 持续检查 / 周期性报告 |
| 组合 | 跑通后存为应用 | 调度应用执行 |

## 要点

- 角色分工越清晰，编排产出质量越高——角色就是"专业的人干专业的事"
- 预设角色（`project-*` 系列）可以直接用，不必自己创建
- 跑通全流程后，别忘了「另存为工作流」——下次填参就能再造一个项目
- 如果任务不需要多角色协作，普通对话就够了，不必开 Plan 模式

## 关联文档

- [Plan 模式](../guides/chat/plan-mode.md) [[guides/chat/plan-mode|Plan 模式]]
- [预设角色与团队](../guides/chat/preset-roles.md) [[guides/chat/preset-roles|预设角色与团队]]
- [任务中心](../guides/tasks/task-center.md) [[guides/tasks/task-center|任务中心]]
- [应用中心](../guides/configuration/app-center.md) [[guides/configuration/app-center|应用中心]]
- [智能体员工](../guides/configuration/smart-employees.md) [[guides/configuration/smart-employees|智能体员工]]


---

## 相关阅读

- [[getting-started/product-overview|产品总览]] — 功能地图与典型路径
- [[explanation/smart-employees|智能体员工概念]] — 设计理念
- [[guides/chat/preset-roles|预设角色与团队]] — 项目团队配置
- [[tutorials/hire-first-smart-employee|雇佣教程]] — 10 分钟上手
