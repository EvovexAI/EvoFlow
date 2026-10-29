# Gateway：platform 全量 + 常用 REST

## Platform 总线

```http
GET  /api/platform/catalog?domain=&detailed=
POST /api/platform
Authorization: Bearer <org_admin>
Content-Type: application/json

{"action":"<name>","args":{},"confirm":false}
```

写/破坏性操作：`"confirm": true`。也可用 `args_json` 字符串。

`catalog` 过滤：工具参数 `domain` **或** `args_json` 里的 `{"domain":"mcp"}`；摘要模式 `{"summary":true}`（仅 name/risk）。

### 全量 action（与代码 registry 对齐）

> 计数：`len(get_registry())` = **179**（24 域）。已退役不计：`experience.*`(4)、`memory.*`(4)、`verification.list`、`appearance.get`。

**knowledge：** `list` `search` `create` `enable` `ingest` `notes` `note_get` `note_delete` `delete` `requeue` `reindex`  
**workflow：** `list` `schema` `get` `create` `generate` `update` `duplicate` `publish` `unpublish` `delete` `revisions` `restore_revision` `run` `stop` `resume` `run_status` `list_runs`  
**settings：** `list_models` `get_default_model` `set_default_model` `get_model` `create_model` `update_model` `delete_model` `invoke_model` `get_web_search` `patch_web_search` `test_web_search`  
**openai：** `models` `chat` `vision`（对齐 `evoflow openai …` / 单次文本·视觉分析）  
**media：** `catalog` `status` `generate_image` `generate_video` `task_wait`（生图/生视频）  
**assets：** `get_profile` `update_profile` `init` `migrate` `export` `import`（画像 + Asset Hub pack）  
**appearance：** `patch`（读外观走面板 HTTP，非 platform）  
**agents：** `list` `get` `bindings` `create` `update` `delete`（绑工具/技能/MCP/知识库前先 `bindings`；省略 `tools`/`knowledge_vault_ids`→空，勿默认全开）  
**employees：** `list` `get` `hire` `create` `update` `pause` `resume` `stop` `delete` `worklog` `trail` `wake` `migrate`  
**tasks：** `list` `get` `execution_trail` `create` `set_state` `delete` `progress` `cleanup_noise` `reclaim_zombies`  
**items：** `list` `get` `create` `update` `delete` `dispatch`  
**skills：** `list` `get` `enable` `install` `delete`  
**extensions：** `list` `get` `install` `enable` `uninstall`（Agent应用 / 侧栏 `#/extensions`；远程 `id+url` 或本地 `path`）  
**plugins：** `overview` `list` `describe` `install` `enable` `update` `restore` `uninstall` `marketplace_add` `marketplace_remove` `marketplace_refresh`  
**mcp：** `get` `list` `add` `remove` `test` `login` `logout` `set`  
**org：** `preflight` `install` `list` `get` `uninstall` `export` `market_catalog` `market_install`  
**channels：** `list` `get` `set_config` `enable` `restart` `push_targets` `registration_begin` `registration_poll` `registration_apply`  
**automation：** `list` `get` `history` `create` `update` `set_status` `delete`  
**approvals：** `list` `approve` `reject`  
**sessions：** `search`  
**diagnostics：** `sources` `scan` `timeline` `run`  
**verification：** `catalog` `start` `init` `get` `step` `update` `conclude` `delete`  
**eval：** `cases` `run` `runs` `get` `progress`

> 已退役：`experience.*`、`memory.*`（长期记忆改走 Asset Hub / `assets` 工具 / evoflow-admin 资产契约）、`verification.list`、`appearance.get`。  
> 删除岗位用 `employees.delete`（可选 `delete_agent`）；停巡检用 `pause`/`stop`，不是 archive。  
> 易混：`workflow`=可运行工作流 App；`extensions`=侧栏 Agent应用网页；`plugins`=插件市场；`skills`=技能包；`org`=整包资源；`channels`=IM 渠道；`assets`=画像/实体资产 pack；`eval`=评测中心。

CLI 独有、无 platform：`workspace memory`（刻意不对齐）。extensions / plugins / channels / appearance / verification 暂无 CLI（或仅部分），用 platform 或对应 `/api/*`。

### 联网搜索（仅 platform）

```json
{"action":"settings.get_web_search","confirm":false}
{"action":"settings.patch_web_search","args":{"preferredBackend":"doubao","doubaoApiKey":"…"},"confirm":true}
{"action":"settings.test_web_search","args":{"engines":["doubao"],"query":"今天 AI 新闻","adopt_recommended":true},"confirm":true}
```

### 工作流创建示例

```json
{"action":"workflow.create","args":{"name":"日报","goal":"汇总昨日进展","steps":["收集","总结"]},"confirm":true}
{"action":"workflow.publish","args":{"appId":"App_xxx"},"confirm":true}
{"action":"workflow.run","args":{"appId":"App_xxx","parameters":{}},"confirm":true}
```

## 常用 REST（CLI 覆盖不全时）

| 前缀 | 用途 |
|------|------|
| `/api/apps` | Apps CRUD、run、debug（platform：`workflow.*`） |
| `/api/ui-extensions` | Agent应用登记/启停/卸载（platform：`extensions.*`） |
| `/api/plugins` | 插件市场总览/安装/启停（platform：`plugins.*`） |
| `/api/organizations` | 资源包（platform：`org.*`） |
| `/api/channels` | IM 渠道启停/扫码注册（platform：`channels.*`） |
| `/api/tasks` | 任务中心细粒度、队列、save-as-app |
| `/api/proactive` | 员工仪表盘等（常 premium） |
| `/api/assets` | Asset Hub（platform：`assets.*`） |
| `/api/eval` | 评测（platform：`eval.*`） |
| `/api/langgraph` | Agent 运行时图 |
| `/api/skills/install-local` | 上传 `.zip` |
| `/api/chat/sessions` `/api/events` | 会话与 SSE/WS |

以运行时 `http://<gateway>/docs` 为准。
