# 资源包与资源市场

> 想一次装好「员工 + 工作流 + 技能/Agent应用」整套场景，用 **资源包**。  
> 技术上资源包就是组织包（根文件 `evoflow.organization.json`）。

---

## 入口在哪

都在 **设置 → 数据与资源 → 资源中心**（不占侧栏主入口；页内「获取资源 / 已装资源 / 打包分享」三个分区切换，默认落在「获取资源」）：

| 分区 | 路径 | 做什么 |
|------|------|--------|
| **获取资源** | `#/settings?tab=resources`（或 `&panel=market`） | 从市场一键安装，或导入本地 zip / 文件夹；浏览 GitHub catalog |
| **已装资源** | `#/settings?tab=resources&panel=installed` | 已装资源包实例、卸载；有新版本时一键升级 |
| **打包分享** | `#/settings?tab=resources&panel=mine` | 勾选本机资源，打包导出给他人 |

旧链接 `#/settings?tab=my-resources` / `resource-market` 会自动落到「资源中心」。

日常干活仍用侧栏「智能体员工」「工作流」；设置只做获取与盘点。

---

## 和「资产中心 Pack」有什么不同

| | 资源包（本文） | 资产中心 `.evoflow-pack` |
|--|----------------|---------------------------|
| **装什么** | 员工、工作流、技能、Agent应用、知识库、编排关系 | 画像 / 记忆 / 专长等 Markdown 资产 |
| **入口** | 设置 → 资源中心（获取资源 / 已装资源） | 设置 → 资源中心 → 打包分享，或 `#/assets` 导出 |
| **用途** | 给别人一整套可跑的场景 | 备份或迁移「关于你/员工」的笔记本 |

两者都可「打包带走」，但 **不是同一种包**。

「打包分享」是选货打包台：勾选本机资源后导出；员工/工作流等仍存在各自模块，不另建总表。

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
  { "path": "./skills/my-skill", "mode": "bound" },
  { "path": "./skills/my-skill", "link": true }
]
```

- 默认（或不写 `mode` / `link`）：**复制**到生效根的 `skills/custom/<name>/`（zip 分发、便携安装用这个）。
- `"mode": "bound"`（或旧字段 `"link": true`）：**原地登记**——技能目录留在原路径，只在 SQLite `evoflow_skills` 写入绝对 `source_path`；改源码即生效，卸载只取消登记、不删源目录。脚本用 **`bash`**：`bash(command="python skill:<name>/scripts/foo.py")`（宿主改写路径）。非便携（换机器路径会断）。
- 也可用 HTTP：`POST /api/skills/install-from-path`，body `{ "path": "D:/…/my-skill", "mode": "bound" }`（文件夹导入默认即为 `bound`）。

`slug` 形态（从技能市场装）暂未支持（Phase 2）；市场安装始终为 copy。

### mcp（MCP 服务定义）

```json
[
  { "from": "./mcp/selfmedia-live-workbench.json" }
]
```

- 安装顺序在 Agent **之前**（`create_agent` 会校验 `mcp_servers` 已注册）。
- 面板「打包分享」会根据 Agent 的 `mcp_servers` **自动导出**对应本机 MCP 配置；疑似密钥的 env 值会清空，只保留键名。
- 只写 Agent 里的名字、不打 `primitives.mcp` 时：对方装完会看到名字但 MCP 服务本身缺失（这是以前分享丢 MCP 的主因）。

### agents / 员工 / 应用

- `agents[]`: `{from: "./agents/xxx.yaml"}`（YAML，`system_prompt_file` 支持包内相对路径；含 `tools` / `mcp_servers` / `skills`）
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

安装入口：**设置 → 资源中心 → 获取资源 → 导入本地**（选 zip 或文件夹），或 CLI `evoflow org install`。

---

## 装别人的包

1. 打开 **设置 → 资源中心 → 获取资源**。  
2. **市场目录**：默认合并「官方 GitHub 市场」+ 你添加的自定义源。官方索引：  
   `https://raw.githubusercontent.com/EvovexAI/evoflow-resource-market/main/catalog.json`  
   高级场景可用环境变量 `EVOFLOW_RESOURCE_MARKET_CATALOG_URL` 覆盖官方 URL（仅非空值生效）。  
3. **自定义 / 内网源**：在「市场源」里粘贴同事分享的 catalog 地址（可带 `?token=`），例如  
   `http://192.168.1.17:8382/api/resource-market/catalog.json`。  
   带 `download.zip_url`（或卡片「直链」）的条目会走 HTTP zip 安装；官方包仍可走 GitHub 目录安装。  
4. 或 **导入本地**：选 zip / 文件夹（根目录要有 `evoflow.organization.json`）→ 预检 → 安装。  
5. 装完后：「资源中心 → 已装」能看到记录。

---

## 导出自己的包

1. **设置 → 资源中心 → 打包分享**。  
2. 勾选员工 / 工作流 / 技能 / **Agent 应用**等（可只勾 Agent 应用，kind=`extensions`）。  
3. 选导出目录 → **导出资源包**，或 **导出并发布到本机市场**（自动 zip + 写入本机 Host）。  
4. 得到与安装同结构的目录 / zip，可发给别人、发到本机内网市场，或 PR 上架公网市场。

CLI：`evoflow org export --employees a,b --apps app_xxx -o ./my-pack --zip`  
市场：`evoflow org market install packs/foo`（或带 `zip_url`）  
已有目录发布：`evoflow org publish-local <pack目录>`  

### 包目录 vs 运行态（防漂移）

Showcase / monorepo 包常见模式：扩展与技能 `link` 指回目录（改源码即生效），但 **Agent SOUL / 员工 JSON 在安装时拷进运行库**。包升级后若未重装，就会出现「包里一套、面板里另一套」。

- **权威**：仓库里的资源包目录（`evoflow.organization.json` + agents/employees…）  
- **核对**：`evoflow org drift <pack目录>`  
- **对齐**：`evoflow org sync <pack目录>`（等价于 `install --conflict replace`，用包覆盖运行态配置；不打包聊天/记忆）  
- **内网分享**：直接 `publish-local` 该目录，不必再从面板勾选反导出  

遗留的旧员工文件（如已退役的 `*.SOUL.md`）不会自动删除运行态旧实例；sync/replace 以当前 manifest 为准，旧 org instance 可在「已装资源」卸载。

---

## 本机资源市场（内网分享）

在 **获取资源 → 本机资源市场**：

1. **开启内网分享**（Gateway 需能被局域网访问，例如已开 WebUI 远程或绑定 `0.0.0.0`）。  
2. 可选 **生成 token**：分享链接会自动带 `?token=`；不设则目录公开可读。  
3. **复制** share URL 发给同事 → 对方在「市场源」里添加。  
4. 用「打包分享 → 导出并发布到本机市场」上架包；同事刷新市场目录即可安装。

本机数据目录：`~/.evoflow/resource-market/`（`catalog.json` + `packs/<id>.zip`）。  
公开接口：`GET /api/resource-market/catalog.json`、`GET /api/resource-market/packs/<id>.zip`。

### 发布 zip 排除规则（默认）

`publish-local` / 本机市场上架打 zip 时**不会**打进：

| 类别 | 默认排除（任意深度目录名 / 后缀） |
|------|----------------------------------|
| 依赖与环境 | `node_modules`、`.venv`、`venv`、`site-packages`、`__pycache__`、`.tox`、各类 cache |
| 运行产物 | `remakes`、`deliverables`、`work`、`generated`、`uploads`、`out`/`output`/`outputs`、`sessions`、`trash`、`videos`、`downloads`、`productions` |
| 媒体 / 嵌套包 | `.mp4` `.mov` `.webm` `.wav` `.mp3` …、`.zip`、`.exe`、`.whl`；文件名含 `.bak` |
| 本机状态 | `.git`、`.git-embedded-backup`、`.codex-tmp`、`.chrome-profile`、包内 `.evoflow` |

需要额外排除时，在包根放 `.evoflowpackignore`（一行一个模式，`#` 注释；支持目录名或 `fnmatch` 路径）。  
分享包只应含 manifest / agents / skills / 扩展 UI / 文档等可安装源码，不要夹带录音、成片、模型环境。

### 同事安装后落在哪、为何能打开

从市场 / zip 安装时：

1. 包会**持久化**到 `~/.evoflow/org-packs/<pack_id>/`（不再链到临时解压目录）。  
2. Agent 应用**强制复制**到 `~/.evoflow/ui-extensions/<id>/`（忽略作者本机的 `link: true`）。  
3. 「已装资源」详情展示包目录与扩展 `install_path`，可一键打开文件夹。  
4. 首次打开 Agent 应用时，桌面端会按 `service.setup`（或自动检测）准备运行环境，并写 `.evoflow-setup-ok`：  
   - 有 `package.json` 且无 `node_modules` → `npm install`  
   - 有 `scripts.build` 且无 `dist/` → **`npm run build`**（否则 Vite 应用会「能开但没样式」）  
   - 有 `requirements.txt` 且无 `.venv` → 建 venv + `pip install -r`  
5. 分享 zip **故意不含** `node_modules` / `.venv`；同事机器需要本机已装 Node / Python，首次打开会自动装依赖与构建产物。

作者本机用文件夹 `link` 开发不受影响；只有 zip / zip_url / market 安装走便携复制。

若同事是**旧版**装的（扩展指到已删临时目录），请在「已装资源」卸载后重新从市场安装一次。

---

## 版本检测与一键升级

资源包用 `evoflow.organization.json` 的 **`version`**（以及 catalog 条目的同名字段）做比较，**不是**桌面端热更新。

| 场景 | 怎么做 |
|------|--------|
| 作者发新版 | 改包内 `version`（如 `1.0.0` → `1.1.0`）→ 再 `publish-local` / 更新市场 zip |
| 同事看是否有更新 | **获取资源**刷新市场：卡片出现「可更新」；或 **已装资源** 列表/详情出现「可更新 → vX」 |
| 一键升级 | 点「升级」→ 按市场 zip/path **replace 重装**，覆盖同名 Agent / 员工 / 扩展；默认保留工作区与知识库数据，并清理旧实例记录 |

API（供排障）：`GET /api/organizations/market/catalog`（包上附 `_updateAvailable`）、`GET /api/organizations/market/updates`、`POST /api/organizations/upgrade`（body：`{ "pack_id": "…" }`）。

注意：升级会重跑扩展 `setup`/`build`；大版本若改了员工 code / 扩展 id，仍可能要人工核对。本地文件夹开发用 `evoflow org sync` 对齐运行态，与市场上的「升级」是两条路径。

---

## 发布到公开资源市场（GitHub）

```text
catalog.json
packs/<你的包-id>/
  evoflow.organization.json
  README.md
  agents/ employees/ apps/ …
```

1. 本地预检通过。  
2. Fork 市场仓库 → 放入 `packs/<id>/`。  
3. 改 `catalog.json` 加一行（可选 `download.zip_url` 指向 Release / CDN）。  
4. 开 PR；合并后别人刷新市场即可看到。

字段见资源市场 catalog schema（私有设计文档，不在本仓）；内网 Host 生成的条目会带 `download.type=zip_url`。

---

## 相关阅读

- [[guides/configuration/smart-employees|智能体员工]]  
- [[guides/configuration/asset-center|资产中心]]（实体资产导出，不是资源包）  
- [[explanation/skill-system|技能系统]]
