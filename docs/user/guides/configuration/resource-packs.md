# 资源包与资源市场

> 想一次装好「员工 + 工作流 + 技能/Agent应用」整套场景，用 **资源包**。  
> 技术上资源包就是组织包（根文件 `evoflow.organization.json`）。

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
| **装什么** | 员工、工作流、技能、Agent应用、知识库、编排关系 | 画像 / 记忆 / 专长等 Markdown 资产 |
| **入口** | 设置 → 资源中心（市场 / 已装） | 设置 → 资源中心 → 我的 → 资产，或 `#/assets` 导出 |
| **用途** | 给别人一整套可跑的场景 | 备份或迁移「关于你/员工」的笔记本 |

两者都可「打包带走」，但 **不是同一种包**。

「我的」是选货打包台：勾选本机资源后在右侧导出；员工/工作流等仍存在各自模块，不另建总表。

---

## 原语参考（primitives）

`evoflow.organization.json` 的 `primitives` 里每个条目**独立安装、独立降级**（某项失败只记 warning，不阻塞其他项）；安装顺序由安装器决定（知识库 → 技能 → Agent → 员工 → 应用 → Agent应用）。

### knowledge（知识库）

```json
{
  "ref": "reports",
  "name": "视频拆解报告库",
  "description": "可选",
  "import_folder": "./data/reports",
  "upsert": true,
  "prune_missing": false,
  "folder_prefix": ""
}
```

- 按 `name` 幂等：已存在同名库则复用，不重复建。
- `import_folder` 支持包内相对路径（便携，推荐）或绝对路径（仅本机自用）。
- 文档导入为同步拷贝 + 异步索引，重复导入按内容哈希去重（unchanged 不重索引）。

### skills（技能）

```json
[
  { "path": "./skills/my-skill" },
  { "path": "./skills/my-skill", "link": true }
]
```

- 默认（或不写 `link` / `"link": false`）：**复制**到生效根的 `skills/custom/<name>/`（zip 分发、便携安装用这个）。
- `"link": true`：在 `skills/custom/<name>` 建**目录挂载**（symlink / Windows junction）指向包内源目录，**不拷贝内容**；改源码即生效。适合本机 monorepo / 演示仓。卸载只摘挂载，不删源目录。非便携（换机器路径会断）。
- 也可用 HTTP：`POST /api/skills/install-from-path`，body `{ "path": "...", "link": true }`。

`slug` 形态（从技能市场装）暂未支持（Phase 2）；市场安装始终为 copy。

### agents / 员工 / 应用

- `agents[]`: `{from: "./agents/xxx.yaml"}`（YAML，`system_prompt_file` 支持包内相对路径）
- `team.employees[]`: `{from: "./employees/xxx.json"}`
- `pipelines.apps[]`: `{from: "./apps/xxx.json"}`

### extensions（Agent应用）

```json
[
  { "from": "./extensions/my-ext" },
  { "path": "D:/dev/my-project", "link": true },
  { "manifest": { "…": "…" }, "install_path": "https://example.com" }
]
```

- `from`：包内目录（含 `evoflow.extension.json`）→ 复制安装，**便携**；
- `path`：本机目录 → 默认 folder-link 只登记路径（**非便携**，适合本机自用 / monorepo）；
- `manifest` + `install_path`：远程入口直登；
- 老格式 `{id: "…"}` 仅记录不安装（旧版导出兼容）。

### 占位符：把员工绑到包内知识库

知识库 id 是安装时生成的，员工 JSON 里用 `${KB_REF:ref}` 逻辑引用，安装器会替换成真实 kb id：

```json
{ "config": { "knowledge_vault_ids": ["${KB_REF:reports}"] } }
```

其他占位符：`${ORG_WORKSPACE}`（工作区）、`${ORG_ROOT}`（包根）、`${EVOFLOW_HOME}`。导出器会把员工绑定的、且已包含在导出范围内的知识库 id 自动改写成 `${KB_REF:ref}`。

### 组合示例（知识库 + 员工 + 技能 + Agent应用）

```json
{
  "schema": 1, "kind": "team", "id": "my-scenario", "name": "我的场景包", "version": "1.0.0",
  "workspace": { "path": "${ORG_ROOT}/workspace", "create_if_missing": true },
  "primitives": {
    "knowledge": [{ "ref": "reports", "name": "报告库", "import_folder": "./data/reports" }],
    "skills": [{ "path": "./skills/my-skill" }],
    "agents": [{ "from": "./agents/analyst.yaml" }],
    "extensions": [{ "from": "./extensions/my-ext" }]
  },
  "team": { "employees": [{ "from": "./employees/analyst.json" }] }
}
```

安装入口：**设置 → 资源中心 → 市场 → 导入本地**（选 zip 或文件夹），或 CLI `evoflow org install`。

---

## 装别人的包

1. 打开 **设置 → 资源中心 → 市场**。  
2. **市场目录**：默认读取公开索引（无需配置）  
   `https://raw.githubusercontent.com/EvovexAI/evoflow-resource-market/main/catalog.json`  
   点卡片「安装」即可从 GitHub 拉取并安装。高级场景可用环境变量 `EVOFLOW_RESOURCE_MARKET_CATALOG_URL` 指向其它 raw `catalog.json`（仅非空值生效，空值仍用默认）。  
3. 或 **导入本地**：选 zip / 文件夹（根目录要有 `evoflow.organization.json`）→ 预检 → 安装。  
4. 装完后：「资源中心 → 已装」能看到记录。

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

字段见资源市场 catalog schema（私有设计文档，不在本仓）。

---

## 相关阅读

- [[guides/configuration/smart-employees|智能体员工]]  
- [[guides/configuration/asset-center|资产中心]]（实体资产导出，不是资源包）  
- [[explanation/skill-system|技能系统]]
