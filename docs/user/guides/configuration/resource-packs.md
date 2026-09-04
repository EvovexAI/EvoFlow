# 资源包与资源市场

> 想一次装好「员工 + 工作流 + 技能/扩展」整套场景，用 **资源包**。  
> 技术上资源包就是组织包（根文件 `evoflow.organization.json`）。  
> 设计细节：[资源市场契约](../../../system/design/resource-marketplace.md) · [组织包设计 / API](../../../system/design/organization-pack-design.md)

---

## 入口在哪

都在 **设置 → 资源中心**（不占侧栏主入口；页内「我的 / 已装 / 市场」切换）：

| 分区 | 路径 | 做什么 |
|------|------|--------|
| **我的** | `#/settings?tab=resources`（或 `&panel=mine`） | 左栏搜选本机资源；右栏打资源包并导出 |
| **已装** | `#/settings?tab=resources&panel=installed` | 已装资源包实例、卸载 |
| **市场** | `#/settings?tab=resources&panel=market` | 导入本地 zip/文件夹；浏览 GitHub catalog |

旧链接 `#/settings?tab=my-resources` / `resource-market` 会自动落到「资源中心」。

日常干活仍用侧栏「智能体员工」「工作流」；设置只做盘点与获取。

---

## 和「资产中心 Pack」有什么不同

| | 资源包（本文） | 资产中心 `.evoflow-pack` |
|--|----------------|---------------------------|
| **装什么** | 员工、工作流、技能、扩展、编排关系 | 画像 / 记忆 / 专长等 Markdown 资产 |
| **入口** | 设置 → 资源中心（市场 / 已装） | 设置 → 资源中心 → 我的 → 资产，或 `#/assets` 导出 |
| **用途** | 给别人一整套可跑的场景 | 备份或迁移「关于你/员工」的笔记本 |

两者都可「打包带走」，但 **不是同一种包**。

「我的」是选货打包台：勾选本机资源后在右侧导出；员工/工作流等仍存在各自模块，不另建总表。

---

## 装别人的包

1. 打开 **设置 → 资源市场**。  
2. **市场目录**：若已配置 `EVOFLOW_RESOURCE_MARKET_CATALOG_URL`，点卡片「安装」即可从 GitHub 拉取并安装。  
3. 或 **导入本地**：选 zip / 文件夹（根目录要有 `evoflow.organization.json`）→ 预检 → 安装。  
4. 装完后：「我的资源 → 已装资源包」能看到记录。

---

## 导出自己的包

1. **设置 → 我的资源 → 另存为资源包**。  
2. 「填入当前员工」或手填 `agent_code` / 工作流 id。  
3. 选导出目录 → 导出（可同时打 zip）。  
4. 得到与安装同结构的目录，可发给别人或 PR 上架。

CLI：`evoflow org export --employees a,b --apps app_xxx -o ./my-pack --zip`  
市场：`evoflow org market install packs/foo`
---

## 发布到资源市场

```text
catalog.json
packs/<你的包-id>/
  evoflow.organization.json
  README.md
  agents/ employees/ apps/ …
```

1. 本地预检通过。  
2. Fork 市场仓库 → 放入 `packs/<id>/`。  
3. 改 `catalog.json` 加一行。  
4. 开 PR；合并后别人刷新市场即可看到。

字段见 [catalog schema](../../../system/design/resource-marketplace-catalog.schema.json)。

---

## 相关阅读

- [[guides/configuration/smart-employees|智能体员工]]  
- [[guides/configuration/asset-center|资产中心]]（实体资产导出，不是资源包）  
- [[explanation/skill-system|技能系统]]
