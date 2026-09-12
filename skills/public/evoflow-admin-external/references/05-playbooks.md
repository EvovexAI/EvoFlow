# 编排剧本（全覆盖）

概念：[`00-concept-routing.md`](00-concept-routing.md)。示例相对包根 `examples/`。

## 0. 冒烟

```bash
evoflow models list
evoflow agents list
evoflow employees list
evoflow items list --exclude-done
evoflow tasks list --limit 20
evoflow workflow list
```

## 1. 个人待办（items）

```bash
evoflow items create --file examples/item-create.json
evoflow items list --exclude-done
evoflow items update <item_id> --file examples/item-update.json
evoflow items get <item_id>
```

## 2. 待办 → 派给岗位员工

```bash
evoflow items create --file examples/item-create.json
evoflow items dispatch <item_id> --agent code-reviewer --goal "写本周选题简报"
evoflow employees worklog code-reviewer
evoflow tasks list --assignee code-reviewer
```

## 3. 建角色 → 雇岗 → 派活 / 唤醒

```bash
evoflow agents check code-reviewer
evoflow agents create --file examples/agent-create.json
evoflow employees hire --file examples/employees-hire.json
evoflow employees update code-reviewer --file examples/employees-update.json
evoflow employees dispatch code-reviewer --goal "核对 ESLint 是否仍为 0 error"
evoflow employees wake code-reviewer --goal "协助验收" --from main
evoflow employees list --status active
evoflow employees worklog code-reviewer
evoflow employees trail code-reviewer --round-id <id>
```

字段含义：[`employees-observe.md`](employees-observe.md)；输出形状见 `examples/employees-*.sample.json`。

## 4. 任务中心结案 / 进度

```bash
evoflow tasks create --name "修登录闪烁" --assignee code-reviewer --description "复现并修"
evoflow tasks progress <task_id> --progress 50
evoflow tasks state <task_id> --status completed --summary "已修；手动复现通过"
evoflow tasks list --status completed --limit 10
```

## 5. 审批

```bash
evoflow approvals list
evoflow approvals request <task_id> --note "请批方案"
evoflow approvals approve <task_id>
# 或
evoflow approvals reject <task_id> --reason "需补充验收标准"
```

## 6. 工作流 Apps

```bash
evoflow workflow list
evoflow workflow get App_xxx
evoflow workflow run App_xxx --file examples/workflow-run-params.json
evoflow workflow status <runId>
evoflow workflow stop <runId> --reason "取消"
```

创建/发布（HTTP）：

```bash
curl -s -X POST "$EVOFLOW_GATEWAY_URL/api/platform" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"action":"workflow.create","args":{"name":"日报","goal":"汇总昨日进展"},"confirm":true}'
```

全量 action：[`04-http-platform.md`](04-http-platform.md)。

## 7. 定时自动化

```bash
evoflow automation create --file examples/automation-daily-cron.json
evoflow automation create --file examples/automation-once.json
evoflow automation update <id> --file examples/automation-update.json
evoflow automation list
evoflow automation pause <id>
evoflow automation resume <id>
evoflow automation history <id>
```

## 8. 模型 / 技能 / MCP / 画像

```bash
evoflow models create --file examples/model-create.json
evoflow models primary set my-glm
evoflow models test --file examples/model-test.json
evoflow models invoke --file examples/model-invoke.json
evoflow skills list --enabled-only
evoflow skills install ./some-skill.zip
evoflow mcp set --file examples/mcp-set.json
evoflow mcp add fs -- npx -y @modelcontextprotocol/server-filesystem D:/work
evoflow mcp test fs
# 用户画像改走资产中心：#/assets → 画像，或 assets.update_profile
```

## 9. 知识 / 经验 / 记忆 / 会话

```bash
evoflow knowledge create --name "英语单词库"   # 平台自有库；遗留 Vault 加 --legacy-vault
evoflow knowledge remember --file examples/knowledge-remember.json
evoflow knowledge recall "MCP 配置"
evoflow experience save --file examples/experience-save.json
evoflow experience list --query "PATH"
evoflow memory show --agent main
evoflow sessions search -q "docker 端口" --titles
evoflow workspace memory bootstrap D:/path/to/project
```

## 10. 组织包 / 资产

```bash
evoflow org preflight ./packs/content-ops
evoflow org install ./packs/content-ops --workspace D:/ws/content-ops
evoflow org list
evoflow org export --employees code-reviewer -o ./my-pack --zip
evoflow assets init
evoflow assets export -o ./hub.evoflow-pack
```

## 11. 评测 / 排障

```bash
evoflow eval run --mode smoke
evoflow eval cases --category scenario
evoflow logs sources --hours 72
evoflow logs scan --hours 24 -s gateway
evoflow logs timeline --hours 24 --format markdown
```

综合诊断（仅 platform）：`{"action":"diagnostics.run","confirm":false}`
