# EvoPanel UI 摸底报告

> 产品经理 · 2026-07-22 08:00 UTC+8
> 任务：`Task_20260721164218_614943`

## 一、摸底结论

**已完成摸底。** 对比了 evopanel 源码（`sidebar.js`、`router.js`、`settings/meta.js`）与现有文档（`docs/user/guides/configuration/evopanel-guide.md`），发现以下差异：

### 1.1 导航栏差异（sidebar.js → 文档）

| 源码中实际导航 | 文档中描述 | 差异 |
|---|---|---|
| **概览 → 实时聊天** `/chat` | ✅ 一致 | 无差异 |
| **配置 → 模型配置** `/models` | ✅ 一致 | 无差异 |
| **配置 → 智能体** `/expert`（路由 `/agents`） | 文档写「Agent 管理」/agents | ✅ 标签名「智能体」vs「Agent 管理」—— 可接受，功能一致 |
| **配置 → 消息渠道** `/channels` | ✅ 一致 | 无差异 |
| **数据 → 上传文档** `/knowledge` | ❌ **文档未提及** | 源码有 `/knowledge` 入口，文档未列 |
| **数据 → 知识库** `/knowledge/vaults` | ❌ **文档未提及** | 源码有 `/knowledge/vaults` 入口，文档未列 |
| **数据 → 记忆文件** `/memory` | ✅ 一致 | 无差异 |
| **数据 → 自动化** `/cron` | ✅ 一致 | 无差异 |
| **扩展 → 应用中心** `/apps` | ❌ **文档未提及** | 源码有 `/apps` 入口，文档未列 |
| **扩展 → 任务中心** `/tasks` | ✅ 一致 | 无差异 |
| **运维 → 会话调试** `/observability` | ✅ 一致 | 无差异 |
| **底部 → 面板设置** `/settings` | ✅ 一致 | 无差异 |

### 1.2 设置弹窗差异（settings/meta.js → 文档）

| 源码中实际 Tab | 文档中描述 | 差异 |
|---|---|---|
| 通用 `general` | ✅ 一致 | 无差异 |
| 模型 `models` | ✅ 一致 | 无差异 |
| 环境变量 `env` | ❌ **文档缺失** | 源码有 `settings/env.js`，文档未列 |
| IM 通信 `im` | ✅ 一致 | 无差异 |
| 安全中心 `security` | ❌ **文档缺失** | 源码有 `settings/security.js`，文档未列 |
| 记忆 `memory` | ✅ 一致 | 无差异 |
| 快捷键 `shortcuts` | ✅ 一致 | 无差异 |
| 远程访问 `api` | ❌ **文档缺失** | 源码有 `settings/remote.js`，文档未列 |
| 授权 `license` | ❌ **文档缺失** | 源码有 `settings/license.js`，文档未列 |
| 关于 `about` | ✅ 一致 | 无差异 |

### 1.3 隐藏路由差异（router.js → 文档）

| 源码中实际路由 | 文档中描述 | 差异 |
|---|---|---|
| `/task/:id` | ✅ 一致 | 无差异 |
| `/project/:id` | ✅ 一致 | 无差异 |
| `/workflow/:id` | ❌ **文档未提及** | 源码有，文档未列 |
| `/agents/team/:code` | ✅ 一致 | 无差异 |
| `/chat-react` | ✅ 一致 | 无差异 |
| `/knowledge/:id` | ❌ **文档未提及** | 源码有知识库详情路由 |
| `/knowledge/vaults` | ❌ **文档未提及** | 源码有知识库列表路由 |
| `/apps/:id`、`/apps/:id/run`、`/apps/:id/history` | ❌ **文档未提及** | 源码有应用中心详情/运行/历史路由 |
| `/proactive/:code`、`/proactive/board` 等 | ❌ **文档未提及** | 源码有智能体员工路由 |

### 1.4 技能管理入口变化

文档中「Skills」和「工具管理」作为独立导航项描述，但**源码 sidebar.js 中已无独立「Skills」和「工具管理」导航入口**——它们被整合到了「扩展 → 应用中心」或「智能体」配置中。需要确认实际 UI 行为。

## 二、产出物

### 已有产出
1. **`docs/user/guides/configuration/evopanel-guide.md`** — 现有的 EvoPanel 使用指南，包含菜单与面板速查表
2. **本报告** — `docs/roles/product-manager/20260722-08/evopanel-ui-survey-report.md`

### 未完成事项（需更新文档）
- 文档缺少：**上传文档**、**知识库**、**应用中心** 三个导航入口
- 设置弹窗缺少：**环境变量**、**安全中心**、**远程访问**、**授权** 四个 Tab
- 隐藏路由缺少：**知识库详情**、**应用中心系列路由**、**智能体员工路由**
- 技能管理 / 工具管理入口已从独立导航移除，文档需同步

## 三、验收标准

1. ✅ 源码 sidebar.js 与 router.js 已读取，确认当前真实 UI 布局
2. ✅ 现有文档 `evopanel-guide.md` 已逐项对比，差异已标注
3. ❌ 文档尚未更新（需另建 Task 派给文档维护）

## 四、建议下一步

1. 建 Task 更新 `docs/user/guides/configuration/evopanel-guide.md`，补充缺失的导航入口和设置 Tab
2. 确认技能管理 / 工具管理入口的实际交互方式（已被整合到何处）
