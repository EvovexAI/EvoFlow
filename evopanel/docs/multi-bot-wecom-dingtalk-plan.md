# 方案评审：企微 / 钉钉多机器人名册改造

> 状态：**待评审**（用户审完再动手）
> 关联目标：修复「消息渠道页只有飞书有多机器人名册，企微/钉钉只有单 Bot 配置框」——让企微、钉钉也各自显示本平台的多机器人名册，对齐飞书。

---

## 1. 结论摘要（TL;DR）

- **这不是显示 bug，是后端能力缺失**。飞书通道支持「多账号（每岗位一个专属机器人）」，企微/钉钉通道目前是**单实例**（一个 bot / 一个连接），后端没有多账号模型，前端自然没有数据可列名册。
- 要满足「企微/钉钉也显示各自平台多机器人名册」，需**打通后端多账号模型**，是跨 3 层（后端通道 + proactive 绑定 API + 前端 UI）的工程，企微、钉钉各自是一块独立改造。
- **建议分平台实施**：先做企微（或先做钉钉），完成一个验收后再做下一个；不推荐一次性并行做两个（风险与工作量都大）。

---

## 2. 现状与目标

### 2.1 现状（已核对代码）

| 维度 | 飞书 | 企业微信 | 钉钉 |
|------|------|---------|------|
| 通道类 | `FeishuChannel` | `WecomChannel` | `DingtalkChannel` |
| 凭证 | `app_id/app_secret` | `bot_id/secret` | `client_id/client_secret` |
| 连接方式 | lark-oapi WS（每账号一 WS） | AI Bot WebSocket（单 WS） | dingtalk-stream SDK（单 client） |
| 多账号映射 | ✅ `channels.feishu.accounts[<agent_code>]` | ❌ 无 | ❌ 无 |
| 按岗位绑定 API | ✅ `apply_role_feishu_registration` / `unbind_role_feishu` | ❌ 无 | ❌ 无 |
| 岗位级凭证 | `role.config.feishu_app_id/secret/open_id/bound_at` | ❌ 无 | ❌ 无 |
| 入站按岗位路由 | ✅ `account_id` → `assistant_id` → 岗位 | ❌ 全局单入口 | ❌ 全局单入口 |
| 前端名册 | ✅ `feishu-bindings-panel`（仅飞书频道显示） | ❌ 只有单 Bot 配置框 | ❌ 只有单 Bot 配置框 |

### 2.2 目标

- **企业微信页面**：显示「上岗智能体 · 企微协作」名册，可对每个岗位「扫码绑定专属企微机器人 / 部署并绑 / 解绑」，绑定关系存 `role.config.wecom_binding` 并写入 `channels.wecom.accounts[<agent_code>]`。
- **钉钉页面**：同上，名册 + 绑定关系存 `role.config.dingtalk_binding` + `channels.dingtalk.accounts[<agent_code>]`。
- 入站消息按 `account_id`（岗位 code）路由到对应员工。

---

## 3. 飞书多账号模型剖析（改造范本）

飞书已实现完整的多账号模型，以下机制是我们要在企微/钉钉上复刻的：

### 3.1 凭证存储（双写）

1. **岗位级**：`role.config.feishu_app_id / feishu_app_secret / feishu_open_id / feishu_bound_at`
2. **通道级**：`channels.feishu.accounts[<agent_code>] = { app_id, app_secret, enabled, open_id, name, session: { assistant_id: code } }`

关键实现：`backend/packages/harness/evoflow/proactive/feishu_binding.py`

- `apply_registration_to_role(agent_code, app_id, app_secret, open_id)`：写岗位凭证 → `sync_role_account_to_channel` 写 accounts → `restart_feishu_channel_if_possible()` 重启通道让新 bot 生效 → 推送自我简介。
- `unbind_role_feishu(agent_code)`：清岗位凭证 + 移除 accounts + 重启。
- `sync_role_account_to_channel`：**绝不**把员工凭证写进全局 primary `app_id/app_secret`，避免员工 bot 伪装成个人助理主机器人。
- 重启通道通过 `ChannelService.restart_channel("feishu")`（内存 config 同步 + 磁盘持久化）。

### 3.2 通道多账号启动

`backend/app/channels/feishu.py` 的 `start()`：

- `accounts = self._normalized_accounts()`（读 `channels.feishu.accounts`）
- 若**只有员工账号、没有 primary 凭证**：取第一个 account 作为 `bootstrap_account_id` 引导 WS，标记该连接归属该岗位，保证入站路由正确。
- 每个 account 建一个 WS client，维护 `self._account_clients[account_id] = api_client`。
- 入站消息带 `account_id`，路由时按 `session.assistant_id` 找到对应岗位。

### 3.3 入站路由

`ChannelManager._channel_store_topic` 按 `account_id` 生成 `acct:{code}` 存储 topic，隔离不同岗位的会话上下文。这是「同事 @ 不同岗位机器人各聊各的」的核心。

### 3.4 前端名册渲染

`evopanel/src/pages/channels.js` 的 `refreshFeishuBindingsUi(channelName)`：

- 数据源：`proactiveListRoles()`（岗位列表）+ `getChannelConfig('feishu')`（accounts + primary app_id）+ `listAgents()`（可部署的未雇佣智能体）。
- `feishuBindingOf(role)` 读 `role.config.feishu_binding` 判断绑定状态。
- 渲染 4 类行：`employee`（已雇佣岗位）、`hireable`（可部署并绑）、`bound`/`unbound`、`orphan`（仅通道账号，无对应岗位）。
- 诊断：主机器人 App ID、专属/与主相同提示、未配置主机器人警告。

绑定/解绑操作在 `evopanel/src/lib/feishu-employee-bind.js`：`startFeishuEmployeeScan`（begin→poll→apply_role_feishu_registration）、`hireAndBindFeishu`（先建角色再绑）、`unbindFeishuEmployee`。

---

## 4. 企微 / 钉钉改造差距

### 4.1 企业微信（WeCom）

当前 `WecomChannel`：
- `__init__` 只读单 `bot_id/secret`；`start()` 只建一条 WS；无 `accounts` 读取、无 `_account_clients`。
- 入站无 `account_id` 概念，全部走全局路由。

**协议可行性**：企微 AI Bot WebSocket 的 `aibot_subscribe` 以 `bot_id/secret/device_id` 鉴权——**一个进程可以起多条 WS（每个 bot 一条）**，与飞书多账号同构。✅ 技术上可行。

### 4.2 钉钉（DingTalk）

当前 `DingtalkChannel`：
- 单 `client_id/client_secret`，dingtalk-stream 单 client。
- 入站用 `session_webhook` 回复，无多账号。

**协议可行性**：钉钉 Stream 可起多个 client（每应用一个）。✅ 技术上可行。但钉钉的回复依赖 `session_webhook`（入站消息携带），需为每个 client 维护自己的 webhook 上下文。

---

## 5. 后端改造设计

> 目标：为企微/钉钉复刻飞书的「账号注册 + 岗位绑定 + 多连接 + 按账号路由」，同时**不破坏现有全局单 bot 用法**（右上角主机器人扫码仍可用）。

### 5.1 新增通用抽象（建议，降低重复）

新增 `backend/packages/harness/evoflow/proactive/binding_base.py`，抽取飞书已有的逻辑为通用基类：

- `PersistRoleBinding(config_keys)`：负责岗位级凭证的写/清 + 通道 accounts 同步 + 通道重启。
- `sync_role_account_to_channel(channel_name, agent_code, creds)`（泛化现有飞书版本，`feishu_binding.py` 改为继承或复用）。

> 若不想引入基类，也可各平台写独立 `wecom_binding.py` / `dingtalk_binding.py`（复制飞书模式）。**倾向基类**，因为三平台模式高度一致。

### 5.2 新增按岗位绑定的 registration 变体

现有 `wecom_registration.py` / `dingtalk_registration.py` 的 `begin/poll` 与全局版相同（扫码获取 bot_id/secret 或 client_id/client_secret），**只需新增 `apply` 的 role 变体**：

- `apply_role_wecom_registration(agent_code, session_id)`：
  1. `poll(session_id)` 拿 `bot_id/secret`
  2. 写 `role.config.wecom_bot_id/wecom_secret/wecom_bound_at`
  3. `sync_role_account_to_channel("wecom", agent_code, {bot_id, secret, name})`
  4. `restart_channel("wecom")`
  5. 返回 UI 安全快照（不含 secret）
- `apply_role_dingtalk_registration(agent_code, session_id)`：同理（client_id/client_secret）。
- `unbind_role_wecom(agent_code)` / `unbind_role_dingtalk(agent_code)`：清凭证 + 移账号 + 重启。

**挂在哪个 router？** 对齐飞书：飞书挂在 `packages/harness/evoflow/proactive/router.py`（`apply_role_feishu_registration`）。企微/钉钉也加到同一 router（`POST /roles/{code}/wecom/bind` 等）或独立 router，评审时定。

### 5.3 通道多账号化（最大改动）

**WecomChannel**：
- `__init__`/`start()` 增加 `accounts` 读取（`channels.wecom.accounts`），维护 `self._account_clients[account_id]`。
- 单 WS 逻辑抽成 `_WecomBotSession`（bot_id/secret/ws/心跳/重连/媒体），每个 account 一个实例。
- 入站 `InboundMessage` 增加 `metadata["account_id"]`，路由到对应岗位。
- 保留全局单 bot 路径（无 accounts 时的 primary bot）。

**DingtalkChannel**：
- 同理，单 client 抽成 `_DingtalkBotSession`，维护 `session_webhook` 上下文按账号隔离。
- 入站路由按 `account_id`。

> ⚠️ **这是重构性改动**，会动到企微/钉钉通道核心。需保证现有「全局单 bot + 右上角扫码」不回归，建议配回归测试。

### 5.4 入站路由

复用飞书 `ChannelManager` 的 `_channel_store_topic` 机制（`acct:{code}`），或在企微/钉钉通道里自行按 `account_id` 标记入站消息。需要确认 `ChannelManager` 是否已对企微/钉钉做账号级 topic 处理（若无，需在 manager 补上）。

---

## 6. 前端改造设计

### 6.1 泛化名册渲染

`channels.js` 的 `refreshFeishuBindingsUi` 泛化为 `refreshBindingsUi(channelName)`：

- 按 `channelName` 读取对应平台的绑定：`getChannelConfig(name)` 拿 `accounts`，`feishuBindingOf` 换成通用 `bindingOf(role, platform)`（读 `role.config.{platform}_binding`）。
- 名册容器从硬编码 `feishu-bindings-panel` 改为按频道动态命名（或共用一个容器，按当前频道填充）。
- 标题/文案按平台切换：如「上岗智能体 · 企微协作」。

### 6.2 泛化绑定/解绑逻辑

`feishu-employee-bind.js` 泛化为 `employee-bind.js`：

- `startEmployeeScan(channel, agentCode)`：调 `begin{Channel}Registration` → poll → `applyRole{Channel}Registration`。
- `hireAndBind(channel, agentCode)`、`unbindEmployee(channel, agentCode)` 同理。
- 二维码弹窗、轮询复用现有实现，仅替换 API 调用与标题文案。

### 6.3 tauri-api.js

新增 `applyRoleWecomRegistration` / `applyRoleDingtalkRegistration` / `unbindRoleWecom` / `unbindRoleDingtalk`。

---

## 7. 文件改动清单

### 后端（EvoFlow/backend/）

| 文件 | 改动 |
|------|------|
| `app/channels/wecom.py` | 多账号化：抽 `_WecomBotSession`，`accounts` 读取，入站 `account_id` |
| `app/channels/dingtalk.py` | 多账号化：抽 `_DingtalkBotSession`，`accounts` 读取，按账号隔离 webhook |
| `app/channels/wecom_registration.py` | 复用 begin/poll，无改动或加 role apply 辅助 |
| `app/channels/dingtalk_registration.py` | 同上 |
| `packages/harness/evoflow/proactive/binding_base.py` | 新增：通用岗位绑定/账号同步/重启基类 |
| `packages/harness/evoflow/proactive/wecom_binding.py` | 新增：企微岗位绑定（继承基类） |
| `packages/harness/evoflow/proactive/dingtalk_binding.py` | 新增：钉钉岗位绑定（继承基类） |
| `packages/harness/evoflow/proactive/router.py` | 新增企微/钉钉按岗位 bind/unbind 端点 |
| `app/channels/manager.py`（如涉及） | 企微/钉钉账号级 topic 路由 |

### 前端（EvoFlow/evopanel/）

| 文件 | 改动 |
|------|------|
| `src/pages/channels.js` | 名册渲染泛化：`refreshFeishuBindingsUi` → 按平台 |
| `src/lib/feishu-employee-bind.js` | 泛化为通用绑定逻辑（或新增 sibling） |
| `src/lib/tauri-api.js` | 新增 applyRoleWecom/Dingtalk、unbindRoleWecom/Dingtalk |

---

## 8. 风险与注意点

1. **通道重构回归风险**：企微/钉钉多账号化会重写连接管理核心。必须保留全局单 bot 路径，建议补回归测试（现有单 bot 扫码、收发、媒体）。
2. **风控**：企微 AI Bot 扫码创建的 bot 若由员工凭证冒充 primary，会串扰路由——必须沿用飞书「绝不写入 primary app_id/app_secret」的约束。
3. **钉钉 webhook 隔离**：钉钉回复依赖入站 `session_webhook`，多账号时需按账号隔离上下文，否则回复串台。
4. **重启成本**：绑定新岗位需重启通道（飞书同款）。多个岗位连续绑定会频繁重启，飞书已用「绑定后询问继续」缓解，企微/钉钉沿用。
5. **前端一次性渲染**：名册数据来自 3 个异步接口，加载中/失败态需沿用飞书现有处理。
6. **配置持久化**：`update_channels_section_and_save` 双写（磁盘 + 内存 ChannelService）需在泛化基类中正确复现。

---

## 9. 分阶段实施建议

> 每个平台独立成阶段，避免两个大重构并行叠加风险。

### Phase 1（建议先做）：企业微信
1. 后端：`binding_base.py` + `wecom_binding.py` + `router.py` 端点 + `WecomChannel` 多账号化。
2. 前端：tauri-api + `channels.js` 名册泛化（先接企微）+ 绑定逻辑泛化。
3. 自测：单 bot 回归 + 绑定 1 个岗位 → 名册显示 → 入站路由到该岗位。
4. 交付验收。

### Phase 2：钉钉
- 复用 Phase 1 的通用基类与前端泛化，仅换钉钉协议实现 + `DingtalkChannel` 多账号化 + `dingtalk_binding.py`。

### Phase 3（可选）：收尾
- 文档、config 示例、`add-channel.md` 补充多账号说明。

---

## 10. 待用户拍板的问题

1. **先后顺序**：Phase 1 先做**企微**还是**钉钉**？
2. **后端抽象**：倾向「通用 binding_base 基类」统一三平台，还是「各平台独立绑定模块」（少抽象、多复制）？
3. **前端实现**：倾向把 `feishu-employee-bind.js` 就地泛化，还是保留飞书专用文件 + 新增通用文件？（避免动飞书已验证逻辑）
4. **名册容器**：企微/钉钉用**同一个**名册容器按频道切换填充，还是各自独立容器？（影响 DOM 结构，前者更省）
5. **范围确认**：企微/钉钉是否需要「部署并绑」（hire-bind，即未雇佣智能体一键建岗并绑）？还是只做「已雇佣岗位的扫码绑定/解绑」？（飞书两者都有，建议对齐）
