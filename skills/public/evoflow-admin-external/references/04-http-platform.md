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

### 全量 action（与代码 registry 对齐）

**knowledge：** `list` `search` `create` `enable` `ingest` `notes` `note_get` `note_delete`  
**workflow：** `list` `schema` `get` `create` `generate` `update` `duplicate` `publish` `unpublish` `delete` `revisions` `restore_revision` `run` `stop` `resume` `run_status` `list_runs`  
**settings：** `list_models` `get_default_model` `set_default_model` `get_model` `create_model` `delete_model` `get_web_search` `patch_web_search` `test_web_search`  
**assets：** `get_profile` `update_profile`（用户画像：basic-info / preferences / persona）
**appearance：** `get` `patch`  
**agents：** `list` `get` `create` `update` `delete`  
**employees：** `list` `get` `hire` `update` `pause` `resume` `stop` `archive` `worklog` `trail`  
**tasks：** `list` `get` `execution_trail` `create` `set_state` `delete`  
**items：** `list` `get` `create` `update` `delete` `dispatch`  
**skills：** `list` `get` `enable` `install` `delete`  
**mcp：** `get` `set`  
**automation：** `list` `get` `history` `create` `update` `set_status` `delete`  
**approvals：** `list` `approve` `reject`  
**memory：** `agents` `get` `clear` `delete_fact`  
**sessions：** `search`  
**experience：** `list` `get` `save` `delete`  
**diagnostics：** `sources` `scan` `timeline` `run`  
**verification：** `catalog` `start` `init` `list` `get` `step` `update` `conclude` `delete`

CLI 独有、无 platform：`org` `assets` `eval` `workspace memory`；employees 的 `wake`/`migrate`；mcp 的 add/remove/test/login；tasks 的 progress/cleanup/reclaim。

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

## 常用 REST（CLI 覆盖不全）

| 前缀 | 用途 |
|------|------|
| `/api/apps` | Apps CRUD、run、debug |
| `/api/tasks` | 任务中心细粒度、队列、save-as-app |
| `/api/proactive` | 员工仪表盘等（常 premium） |
| `/api/organizations` | 资源包 |
| `/api/assets` | Asset Hub |
| `/api/eval` | 评测 |
| `/api/langgraph` | Agent 运行时图 |
| `/api/skills/install-local` | 上传 `.zip` |
| `/api/chat/sessions` `/api/events` | 会话与 SSE/WS |

以运行时 `http://<gateway>/docs` 为准。
