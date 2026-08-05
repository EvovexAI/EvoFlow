# 组织包（Organization Pack）需求与目标

> **文档类型**：产品需求 / 目标定义（PRD）  
> **状态**：草案 v0.1（待评审）  
> **设计稿**：[组织包技术设计](../../design/organization-pack-design.md)  
> **Schema**：[organization-pack.schema.json](../../design/organization-pack.schema.json)  
> **关联**：[战略方向](../../战略方向.md) · [UI 扩展标准 v1](../../design/ui-extension-standard-v1.md) · [应用设计方案 v2](../../design/app-design.md) · [智能体员工缺口路线图](../../design/smart-employee-gaps-roadmap.md)

---

## 0. 一句话

**组织包 = 可插拔的顶层业务单元**：一次安装，把智能体团队（组织树）、工作流（流水线）、扩展应用、知识库、MCP、技能等能力原子按协作关系装好；卸载时可按组织边界干净拆除。

---

## 1. 背景与问题

### 1.1 现状

EvoFlow 已在各层实现插拔能力，但彼此独立：

| 能力层 | 现状 | 用户痛点 |
|--------|------|----------|
| 智能体角色 | SQLite + 内置模板，可单独配置 | 雇一个「部门」要逐个配 Agent |
| 智能体员工 | `reports_to` 组织树、排班、工作区 | 组织关系需手工搭建 |
| 工作流（应用） | 画布 DAG，`assigned_agent` 引用角色 | 流程与员工、工具割裂 |
| MCP / 技能 | 各自市场/安装器 | 扩展装了，Agent 不会自动连上 |
| UI 扩展 | `evoflow.extension.json` + 套件 | 套件只装 UI，不管 Agent/员工 |
| 知识库 | Vault 独立连接 | 无法随组织一起分发 |

**结果**：用户要跑通一个垂直场景（如「内容运营部」「研发团队」），需要在 5+ 个页面手工拼装，学习成本高，难以复用和商业化。

### 1.2 战略对齐

[战略方向](../../战略方向.md) 已明确：

- **节点即独立智能体**：工作流节点不是死规则，而是可思考、可调工具的岗位 Agent。
- **组织化分工**：管控层 / 执行层 / 后勤层，对标真实公司。
- **复用单位是岗位节点**：一次打磨，多条流程受益。
- **商业化**：「垂直场景智能体套装」「行业工作流模板」是核心变现品类。

组织包是把上述战略**产品化、可分发、可安装**的承载形态。

### 1.3 核心洞察

> **组织不是新能力，而是现有能力的编排层。**

- **智能体团队**（`reports_to` 组织树）与 **工作流**（`depends_on` 流水线）是同一批 Agent 的两种协作视图。
- 底层 **能力原子**（Agent / Skill / MCP / Vault / Extension）保持独立插拔。
- 组织包负责：**装什么 + 谁向谁汇报 + 哪些流程可复跑 + 共享什么工作区/知识库**。

---

## 2. 目标

### 2.1 产品目标

| # | 目标 | 说明 |
|---|------|------|
| G1 | **一键装部门** | 用户导入一个组织包 zip/文件夹，≤3 分钟完成：员工上岗、工作流可见、扩展可用 |
| G2 | **可插拔、可拆卸** | 组织可整体卸载；原子能力可单独保留或移除；不污染其他组织 |
| G3 | **两种协作形态统一** | 同一组织包可同时声明「团队视图」与「流水线视图」，共享 Agent 定义 |
| G4 | **商业化就绪** | 支持官方/第三方组织包分发；manifest 含版本、依赖、许可元数据 |
| G5 | **与现有系统兼容** | 复用现有安装器，不推翻 SQLite / 扩展 / MCP / Vault 存储模型 |

### 2.2 用户目标

| 用户 | 想要什么 | 组织包如何满足 |
|------|----------|----------------|
| 副业创业者 | 开箱即用的「抖音内容团队」 | 装 `content-ops-org`，3 个员工 + 拆解扩展 + 运营知识库 |
| 个人开发者 | 可复用的研发流水线 | 装 `dev-pipeline`，工作流 + Agent，填参即跑 |
| 内容贡献者 | 卖一套岗位模板 | 打包 Agent + Skill + 工作流，上架组织市场 |
| 平台运营 | 降低 onboarding 流失 | 飞书/抖音落地页链到「一键装第一个组织」 |

### 2.3 非目标（v1 明确不做）

| 项 | 原因 |
|----|------|
| 组织包代码签名 / 自动更新 | 与 UI 扩展 v1 一致，后续版本 |
| 跨设备组织同步 | 依赖现有 Gateway / 云能力，非本包范围 |
| 多租户 / 企业强隔离 | P3，见 smart-employee-gaps-roadmap |
| 组织内实时协作编辑 | 非 MVP |
| 替代现有单独安装各 lane 的能力 | 组织包是**编排层**，不废除原子安装 |
| 纯原子包（无组织编排） | 只想分发几个 Agent/Skill 不建组织树时，直接用 Expert Pack / Suite 即可；v1 不新增 `kind: primitives` |
| Vault 快照公开分发 | 含用户私有知识库内容的 zip 不得在组织市场公开流通；v1 仅支持本地安装，市场分发需内容审查（Phase 3）|

---

## 3. 用户故事

### 3.1 安装

| ID | 作为… | 我想要… | 以便… | 验收 |
|----|-------|---------|-------|------|
| US-01 | 新用户 | 从「组织市场」或本地 zip 安装「内容运营部」 | 不用逐个配 Agent/MCP/扩展 | 安装后名册有 3 员工、侧栏有扩展、应用中心有 1 工作流 |
| US-02 | 用户 | 安装前看到依赖检查（平台版本、Node、模型） | 避免装到一半失败 | 缺依赖时阻断并给出修复指引 |
| US-03 | 用户 | 安装时选择「仅装团队」或「团队+流水线」 | 按需裁剪 | `kind: team` / `pipeline` / `full` 生效 |
| US-04 | 用户 | 安装后自动创建工作区目录 | 员工有地方写汇报 | `workspace.template` 展开到用户指定路径 |

### 3.2 使用

| ID | 作为… | 我想要… | 以便… | 验收 |
|----|-------|---------|-------|------|
| US-10 | 运营者 | 员工按组织树交工、wake | 流水线协作 | `reports_to` 与现有 proactive 行为一致 |
| US-11 | 运营者 | 从应用中心跑组织内工作流 | 标准化 SOP 复用 | `assigned_agent` 解析到已装 Agent |
| US-12 | 运营者 | 扩展侧车与 MCP 自动就绪 | 员工能调扩展能力 | 扩展 MCP 随包装注册 |
| US-13 | 开发者 | 单独升级组织内某个 Agent | 单点进化，全组织受益 | 改 Agent 后员工+工作流步骤同步 |

### 3.3 包作者 / 贡献者

| ID | 作为… | 我想要… | 以便… | 验收 |
|----|-------|---------|-------|------|
| US-30 | 组织包作者 | 按目录规范打包，验证 manifest 合法 | 确认打出的包在别人机器能装 | `evoflow org preflight` 无报错 |
| US-31 | 包作者 | 声明依赖（平台版本、Node）后安装前自动检查 | 用户装包时有明确的失败原因 | 缺依赖时报出人类可读提示 |
| US-32 | 包作者 | 把现有已配置的员工 + 应用「另存为组织包」 | 把调试好的配置分发给他人 | Phase 2：`evoflow org export` 输出合法目录 |

### 3.4 卸载与升级

| ID | 作为… | 我想要… | 以便… | 验收 |
|----|-------|---------|-------|------|
| US-20 | 用户 | 卸载整个组织包 | 不留垃圾配置 | 员工解雇、工作流删除、扩展卸载（可选保留 Agent） |
| US-21 | 用户 | 升级组织包到新版本 | 获得新岗位/流程 | 增量合并，不覆盖用户自定义 |
| US-22 | 用户 | 两个组织包共存 | 内容部 + 研发部并行 | 按 `organization_id` 隔离 registry |
| US-23 | 用户 | 安装中途失败后自动回滚 | 不留下半装状态 | 失败后系统恢复到安装前状态，rollback 成功率 100% |

---

## 4. 范围定义

### 4.1 组织包三种形态（`kind`）

| kind | 包含 | 典型商品名 |
|------|------|------------|
| `team` | 员工名册 + 组织树 + 工作区 + 能力原子 | 「内容运营团队」 |
| `pipeline` | 工作流应用 + Agent 引用 + 能力原子 | 「短视频生产流水线」 |
| `full` | team + pipeline + 全部能力原子 | 「内容运营部（完整版）」 |

### 4.2 能力原子（primitives）

组织包可声明、安装时编排的底层单元：

| 原子 | manifest 字段 | 复用现有安装器 |
|------|---------------|----------------|
| 智能体角色 | `primitives.agents[]` | `save_agent_config` + SOUL |
| 技能 | `primitives.skills[]` | `skills/installer.py` |
| MCP | `primitives.mcp[]` | `mcp/config_io` + SQLite |
| 知识库 | `primitives.vaults[]` | vault import + kb-mcp |
| UI 扩展 | `primitives.extensions[]` | Tauri `ui_extension_install_*` |

### 4.3 协作编排（orchestration）

| 编排 | manifest 字段 | 运行时 |
|------|---------------|--------|
| 组织树 | `team.employees[]` | `ProactiveRole` + `reports_to` |
| 工作流 | `pipelines.apps[]` | `evoflow_apps` + AppRunner |
| 工作区 | `workspace` | `workspace_path` 模板展开 |
| 组织边界 | `workspace` + `organization_id` | `proactive/org.py` 同 workspace 划分 |

---

## 5. 成功指标

### 5.1 MVP 验收（Phase 1）

| 指标 | 目标 |
|------|------|
| 官方示例包 `content-ops-org` 可一键安装 | 100% 步骤自动化 |
| 安装耗时（不含模型配置） | ≤ 3 分钟 |
| 安装后员工可「现在开始工作」 | 首轮值班成功 |
| 安装后工作流可填参运行 | 至少 1 步执行成功 |
| 卸载后无残留 registry 记录 | `org_registry` 清空 |
| 安装中途失败回滚成功率 | 100%（无半装状态残留）|
| 依赖缺失时给出可读错误信息 | 用户能自行修复（不需要看日志）|

### 5.2 商业化指标（Phase 2+）

| 指标 | 目标 |
|------|------|
| 组织包安装转化率（落地页 → 装成） | ≥ 40% |
| 第三方贡献组织包数 | ≥ 5 个/季度 |
| 用户自定义组织包导出 | 支持「另存为组织包」 |

---

## 6. 分期路线图

### Phase 0：设计冻结（当前）

- [x] 需求与目标文档（本文）
- [x] 技术设计文档
- [x] Manifest JSON Schema
- [ ] 评审通过

### Phase 1：MVP — 编排层 + 官方示例包

| 项 | 交付 |
|----|------|
| `evoflow.organization.json` 解析与校验 | Gateway / CLI |
| `org_registry` 安装记录 | SQLite 表 |
| 安装编排器 `install_organization()` | 调用现有 primitive 安装器 |
| Extension → MCP 自动注册 | 消费 `mcp.template.json` |
| 官方包 `content-ops-org` | 团队 + 1 工作流 + 2 扩展 |
| EvoPanel 入口 | 设置 → 组织 → 安装本地包 |

**不做**：远程市场、签名、自动更新、增量升级、卸载 UI 弹窗（CLI 先行）。

### Phase 2：体验与商业化

| 项 | 交付 |
|----|------|
| 组织市场 UI（本地索引 + 远程 URL） | `#/organizations` |
| 卸载确认弹窗 UI | 勾选保留选项 |
| 依赖检查与预检报告（可视化） | 安装前 UI |
| 「另存为组织包」 | 从现有员工+应用导出（`evoflow org export`） |
| 岗位模板 → 组织包升级 | 打通 smart-employee 模板 |
| 增量升级合并策略 | semver + `merge_policy` |

> **说明**：`uninstall_organization()` 后端逻辑在 **Phase 1** 交付（CLI 可用）；Phase 2 补全 EvoPanel 卸载 UI。

### Phase 3：生态

| 项 | 交付 |
|----|------|
| 第三方发布规范 | 贡献指南 |
| 版本升级 / 增量合并策略 | semver + 冲突解决 |
| 组织包签名（可选） | 信任链 |

---

## 7. 约束与依赖

### 7.1 技术约束

- 必须复用现有 SQLite 存储，不引入新数据库。
- Manifest 路径占位符与 UI 扩展一致（`${ORG_ROOT}`、`${PLUGIN_ROOT}`）。
- 组织包装在 zip 或文件夹，单包建议 ≤ 50MB（不含大模型）。
- 与 `require_premium` 策略对齐：组织安装是否需授权，产品另定。

### 7.2 依赖的现有模块

| 模块 | 用途 |
|------|------|
| `admin/employees.py` | 雇佣员工 |
| `admin/agents.py` | 保存 Agent |
| `admin/skills.py` | 安装技能 |
| `admin/mcp.py` | 注册 MCP |
| `knowledge/vault/service.py` | 导入 Vault |
| `app/gateway/routers/apps.py` | 注册工作流 |
| `evopanel/.../ui_extensions.rs` | 安装扩展 |
| `proactive/org.py` | 组织边界 |
| `agents/expert_pack_installer.py` | 参考：skill+agent 编排 |

### 7.3 风险

| 风险 | 缓解 |
|------|------|
| 安装中途失败留下半装状态 | 事务性安装 + rollback |
| Agent code 与用户已有冲突 | 安装前冲突检测，支持 `id_prefix` |
| 扩展端口冲突 | 沿用现有 port 检测 |
| 卸载误删用户数据 | 卸载前确认；vault/workspace 可选保留 |

---

## 8. 开放问题（待评审）

| # | 问题 | 建议 |
|---|------|------|
| Q1 | 组织包是否默认需要 premium？ | MVP 跟随现有员工/应用策略 |
| Q2 | 多组织共享同一 Agent 如何引用？ | primitives 全局安装，orchestration 仅引用 |
| Q3 | 用户修改 Agent 后升级包如何合并？ | Phase 2：`merge_policy: skip_user_modified` |
| Q4 | 组织市场放 EvoPanel 还是独立站点？ | Phase 2 先 Panel 本地索引 |
| Q5 | `department` 字段是否升级为组织树层级？ | v1 保持 `reports_to` 为主，`department` 展示 |
| Q6 | Vault 快照随组织包分发是否允许？ | 默认仅本地安装可含 vault；市场分发需用户明确勾选「允许分发知识库内容」 + Phase 3 内容审查 |
| Q7 | 组织包内 Agent 与用户已有同名 Agent 如何区分所有权？ | 靠 `org_artifacts` 记录：同名 agent 若已在 artifacts 中注册为「系统/其他 org 所有」则阻止覆盖；用户自建的永不被覆盖 |

---

## 9. 文档索引

| 文档 | 路径 |
|------|------|
| 技术设计 | [organization-pack-design.md](../../design/organization-pack-design.md) |
| JSON Schema | [organization-pack.schema.json](../../design/organization-pack.schema.json) |
| UI 扩展标准 | [ui-extension-standard-v1.md](../../design/ui-extension-standard-v1.md) |
| 应用设计 | [app-design.md](../../design/app-design.md) |
| 智能体员工机制 | [smart-employees.md](../../../user/explanation/smart-employees.md) |
| 战略方向 | [战略方向.md](../../战略方向.md) |

---

**变更记录**

| 日期 | 版本 | 说明 |
|------|------|------|
| 2026-08-05 | v0.1 | 初稿：需求、目标、范围、路线图 |
| 2026-08-05 | v0.2 | 推敲补丁：补「包作者」用户故事、补非目标（primitives-only / Vault 分发）、补成功指标（rollback 率）、Phase 对齐（卸载 UI 归 Phase 2）、补开放问题 Q6/Q7 |
