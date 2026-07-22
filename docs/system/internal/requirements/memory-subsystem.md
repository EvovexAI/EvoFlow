# Hermes Agent：记忆（Memory）子系统说明

本文档描述 Hermes Agent 仓库中与「记忆」相关的实现与配置，便于开发与排障。

> **放在本仓库时的说明（EvoFlow）**  
> 正文以 **Hermes Agent** 源码为准（路径如 `run_agent.py`、`plugins/memory/`）。  
> **EvoFlow** 中与「外部记忆插件」对齐的实现见同目录 **[external-memory-plugins.md](external-memory-plugins.md)**（`evoflow/agents/memory_plugins/`、`MemoryUpdater` 同步、`ExternalMemoryPluginMiddleware` 预取等）。EvoFlow 的 **内置长期记忆** 为 `memory.json` + 队列 LLM 摘要，与 Hermes 的 `MEMORY.md`/`USER.md` + `memory` 工具 **不是同一套文件**，但可与外部插件层 **叠加** 使用。


## 1. 设计目标与边界

记忆子系统用于：**在跨会话、跨平台使用时，将少量值得长期保留的事实稳定提供给模型**，同时：

- **不破坏提示缓存（prompt caching）**：系统提示在会话内保持稳定前缀；
- **区分「事实记忆」与「历史对话」**：任务进度、临时状态不走 `memory` 工具，而走 `session_search` 等机制；
- **可选叠加云端/向量等外部后端**：通过 **单一外部 MemoryProvider 插件** 扩展，避免工具名冲突与 schema 膨胀。


## 2. 三层结构（概念模型）

| 层级 | 作用 | 典型实现 |
|------|------|----------|
| **A. 内置文件记忆** | 用户/代理可编辑的「精选笔记」：`MEMORY.md`（代理笔记）与 `USER.md`（用户画像） | `tools/memory_tool.py` 的 `MemoryStore` |
| **B. 外部记忆插件（可选）** | Honcho、Mem0、Hindsight 等：预取、同步、额外工具 | `plugins/memory/<name>/` + `MemoryProvider` |
| **C. 会话级长期召回** | 搜索历史会话全文（FTS5）并摘要 | `tools/session_search_tool.py`（**不是** `memory` 工具） |

三者关系：**A 始终可配置开启；B 最多一个；C 依赖 SQLite 会话库**，与 A/B 互补而非替代。


## 3. 内置文件记忆（核心机制）

### 3.1 存储位置与 Profile

- 目录：`get_hermes_home() / "memories"`（随 `HERMES_HOME` / profile 隔离，见 `tools/memory_tool.py` 中 `get_memory_dir()`）。
- 文件：
  - `MEMORY.md`：`target="memory"` — 环境事实、项目约定、工具怪癖等；
  - `USER.md`：`target="user"` — 用户偏好、沟通方式等。

### 3.2 条目格式与容量

- 条目之间用分隔符 **`§`**（常量 `ENTRY_DELIMITER = "\n§\n"`）拼接；切分按完整分隔符进行，避免正文中的单个 `§` 误切。
- 上限为 **字符数**（非 token），默认约 **memory 2200 / user 1375**（`hermes_cli/config.py` 中 `memory` 段）。

### 3.3 「冻结快照」与提示缓存（关键）

`MemoryStore` 维护两套状态：

1. **`_system_prompt_snapshot`**：在 `load_from_disk()` 时从磁盘载入后 **拍一次快照**，仅供 **系统提示** 使用；
2. **内存中的 `memory_entries` / `user_entries`**：`add/replace/remove` 时更新，并 **立即写回磁盘**，工具返回反映 **最新现场状态**。

因此：

- **会话中途** 模型调用 `memory` 写入后：磁盘与工具结果已更新，但 **注入 system prompt 的快照不变**，从而 **整个会话内 system 前缀稳定**，有利于 Anthropic 等 **prefix cache**。
- **下次新会话启动** 重新 `load_from_disk()` 时，快照与磁盘一致，新会话的 system prompt 才会带上新内容。
- **例外**：`_invalidate_system_prompt()`（例如在 **上下文压缩完成后**）也会对该会话 **`_memory_store.load_from_disk()`**，**刷新快照** 后再 `_build_system_prompt()`，使 **本会话内已落盘、尚未反映进旧快照** 的写入进入 **新的** system 前缀（详见 §11.8）。

`run_agent.py` 在组装系统提示时对 `_memory_store` 调用 `format_for_system_prompt("memory"|"user")`，使用冻结快照。

### 3.4 并发与持久化

- 写操作在 **单独的 `.lock` 文件** 上使用 `fcntl.flock` 做互斥；**正文文件**用 **临时文件 + `os.replace` 原子替换**，避免读者看到截断空文件。
- **注意**：标准库 `fcntl` 在 **原生 Windows** 上不可用；官方推荐在 **WSL** 下使用。纯 Windows Python 环境可能无法使用内置文件记忆的锁与写入路径。

### 3.5 安全：写入前扫描

`_scan_memory_content` 对将注入 system prompt 的文本做轻量规则检测（提示注入、敏感外泄模式、不可见 Unicode 等），命中则 **拒绝写入**。

### 3.6 `memory` 工具契约

- 在 `model_tools` 中与 `todo`、`session_search`、`delegate_task` 同属 **agent 层工具**，由 `run_agent` 直接派发。
- Schema 与 `agent/prompt_builder.py` 中的 `MEMORY_GUIDANCE` 约定：**不要把任务进度、已完成工作日志、临时 TODO** 写入 memory，应使用 **`session_search`** 查历史；可复用流程应用 **skill** 工具沉淀。


## 4. MemoryManager 与外部插件

### 4.1 抽象接口 `MemoryProvider`（`agent/memory_provider.py`）

每个提供者需实现：`is_available`、`initialize`、`get_tool_schemas`、`handle_tool_call`、`sync_turn` 等；可选实现：

- `prefetch` / `queue_prefetch`：为下一 turn 准备上下文；
- `on_pre_compress`：压缩前从即将丢弃的消息里抽洞察；
- `on_memory_write`：当 **内置** `memory` 工具写入时，**镜像到外部后端**；
- `on_delegation`：父代理在子代理完成委派任务后的观察；
- `on_session_end` / `shutdown`：会话结束与清理。

`initialize` 的 kwargs 中会注入 **`hermes_home`、`platform`、`session_id`**，以及网关下的 **`user_id`**、profile 名等。

### 4.2 `MemoryManager`（`agent/memory_manager.py`）

- 内置文件记忆由 **`MemoryStore` + `memory` 工具** 承担；`MemoryManager` 主要编排 **外部插件**。
- **同一时间只允许一个外部 provider**（`memory.provider` 配置）；第二个会被拒绝并记录日志。
- **工具路由**：`handle_tool_call` 按工具名映射到对应 provider。
- **预取围栏**：`build_memory_context_block()` 将预取文本包在 `<memory-context>...</memory-context>` 中，并注明「非用户新输入」；`sanitize_context` 会去掉误输出的 fence 逃逸序列。

### 4.3 与 `run_agent` 的集成要点

1. **初始化**：读取 `memory.provider`；若为空可尝试 **Honcho 自动迁移**（检测到全局 Honcho 启用且有密钥时写回配置并加载 `honcho` 插件）。
2. **工具 schema**：外部 provider 的 schema 追加到 `self.tools` 与 `valid_tool_names`。
3. **系统提示**：`build_system_prompt()` 追加在 **内置 MEMORY/USER 块之后**。
4. **每轮对话**：对 **原始用户消息** `original_user_message` 调用 `prefetch_all`，结果缓存，**同一 turn 内多轮 tool 调用复用**，避免重复预取。
5. **注入位置**：预取内容 **不写入持久化 `messages`**，仅在构建 **`api_messages`** 时拼到 **当前 turn 的 user 消息末尾**（与 `pre_llm_call` 钩子注入行为一致）。
6. **回合结束**：`sync_all` + `queue_prefetch_all`。
7. **内置 `memory` 写入桥接**：`add`/`replace` 成功后调用 `on_memory_write`。

### 4.4 仓库内置插件

`plugins/memory/` 下可见：`honcho`、`mem0`、`hindsight`、`holographic`、`retaindb`、`byterover`、`openviking`、`supermemory` 等（以 `plugin.yaml` 为准）。启用：`config.yaml` 中 `memory.provider: "<name>"`，可使用 **`hermes memory setup`**（`hermes_cli/memory_setup.py`）配置依赖与密钥。


## 5. 与「会话搜索」的分工

| 能力 | 工具 | 机制 |
|------|------|------|
| **长期、短、稳定事实** | `memory` | 文件 + 可选外部后端 |
| **「以前聊过什么」** | `session_search` | SQLite **FTS5** → 辅助模型摘要 |

`SESSION_SEARCH_GUIDANCE` 与 `MEMORY_GUIDANCE`（`agent/prompt_builder.py`）共同约束：**跨会话回忆优先 `session_search`**，**持久偏好与环境事实优先 `memory`**。


## 6. 压缩、退出与「冲洗」记忆

### 6.1 `flush_memories`（`run_agent.py`）

在上下文压缩前等场景，可插入 flush 用户消息，用 **仅含 `memory` 工具** 的 LLM 调用（优先 auxiliary 模型）促使模型写入值得保留的内容。压缩路径会先 `flush_memories(..., min_turns=0)`，再调用外部 provider 的 `on_pre_compress`。

### 6.2 `flush_min_turns` / `nudge_interval`

代码默认值包括 **`nudge_interval` 10**、**`flush_min_turns` 6**（可从 `memory` 配置覆盖）。


## 7. 周期性「轻推」（Nudge）与后台回顾

- 按 turn 计数，若达到 `nudge_interval` 且存在 `memory` 与 `_memory_store`，可在回合结束后触发 **`_spawn_background_review`**。
- 后台回顾会再起一个 **`AIAgent` 子实例**（quiet、短迭代），在副本对话中用固定提示检查是否写入 memory/skill，**共享同一 `_memory_store`**，不修改主会话；成功时可打印 `💾` 摘要。


## 8. 子代理与 `skip_memory`

子代理常设 **`skip_memory=True`**，避免非主对话上下文污染用户表征；`MemoryProvider.initialize` 文档说明 **`agent_context` 非 `primary` 时宜跳过写入**。父代理可通过 `on_delegation` 接收子任务结果（若插件实现）。


## 9. 配置速查（`config.yaml` 中 `memory` 段）

| 键 | 含义 |
|----|------|
| `memory_enabled` | 是否将 `MEMORY.md` 快照注入系统提示 |
| `user_profile_enabled` | 是否将 `USER.md` 快照注入系统提示 |
| `memory_char_limit` / `user_char_limit` | 两路存储字符上限 |
| `provider` | 外部插件名；空字符串表示仅内置文件记忆 |


## 10. 相关源码索引

| 模块 | 路径 |
|------|------|
| 内置存储与工具 | `tools/memory_tool.py` |
| 管理器与围栏 | `agent/memory_manager.py` |
| 提供者抽象 | `agent/memory_provider.py` |
| 插件发现/加载 | `plugins/memory/__init__.py` |
| 主循环集成 | `run_agent.py` |
| 默认配置 | `hermes_cli/config.py`（`memory` 键） |
| 提示词引导 | `agent/prompt_builder.py`（`MEMORY_GUIDANCE` 等） |
| 会话搜索 | `tools/session_search_tool.py` |
| 交互配置 | `hermes_cli/memory_setup.py` |

官方用户文档另见：`website/docs/user-guide/features/memory.md`、`website/docs/user-guide/features/memory-providers.md`、`website/docs/developer-guide/memory-provider-plugin.md`。


## 11. 生命周期详解：何时产生、何时使用、更新与删除

本节按 **时间顺序** 与 **数据形态** 说明三类能力（内置文件记忆、外部插件、`session_search`），并单独说明 **增删改** 各自落在什么 API 上。

### 11.1 总览：两条「读路径」与一条「写路径」

内置 `MEMORY.md` / `USER.md` 在实现里对应 **两种读取方式**，容易混淆：

| 读路径 | 数据版本 | 何时发生 | 模型侧体验 |
|--------|----------|----------|------------|
| **A. System 注入** | **`load_from_disk()` 当时的冻结快照** | 组装 `_cached_system_prompt` / `_build_system_prompt()` 时 | 本会话内 **不随中途写入而变**（保前缀缓存） |
| **B. 工具返回 JSON** | **当前内存列表 + 磁盘**（`add/replace/remove` 后立即一致） | 每次调用 `memory` 工具后 | 模型 **总能看到刚写入后的全文条目列表**（在 tool 结果里） |

**写路径** 只有一类：通过 `memory` 工具的 **`add` / `replace` / `remove`**（或 flush / 后台回顾 **间接** 再调同一工具），成功则落盘；`replace`/`remove` 用 `old_text` **子串匹配**定位条目（多条匹配且内容不同时会报错要求写得更具体）。


### 11.2 阶段 0：`AIAgent` 初始化（进程/会话对象创建）

| 事项 | 行为 |
|------|------|
| 配置读取 | 读取 `memory.memory_enabled`、`user_profile_enabled`、字符上限、`memory.provider` 等。 |
| `MemoryStore` | 若开启任一路，构造 `MemoryStore`，调用 **`load_from_disk()`**：从 `memories/MEMORY.md`、`USER.md` 读入条目，**生成 `_system_prompt_snapshot`**，并填充运行中的 `memory_entries` / `user_entries`。 |
| 外部插件 | 若 `memory.provider` 非空且插件 `is_available()`，创建 `MemoryManager`，`add_provider` 后 **`initialize_all(session_id=..., platform=..., hermes_home=..., user_id=..., ...)`**。 |
| 工具表 | 外部插件返回的 **额外** 工具 schema 被 **append** 到本轮可用工具列表。 |

**产生**：此时尚无新用户消息；仅 **加载已有磁盘内容** 为「本会话的 system 快照基底」。

**使用**：后续第一次 `_build_system_prompt()` 会把 **快照** 拼进 system（若对应 `*_enabled` 为真）。


### 11.3 阶段 1：用户每轮对话开始（`run_conversation` 入口）

| 顺序 | 事项 | 说明 |
|------|------|------|
| 1 | `original_user_message` | 保留 **未混入 skill 注入等** 的原文，供预取、同步使用。 |
| 2 | `_user_turn_count` 自增 | 用于 flush 等逻辑。 |
| 3 | **Nudge 判定** | 若配置了 `nudge_interval`、存在 `memory` 工具与 `_memory_store`，则 `_turns_since_memory` 累加；达到阈值则在本轮结束后标记 **`_should_review_memory`**（见 11.7）。 |
| 4 | 用户消息写入 `messages` | 标准对话历史；**不包含** 外部预取文本（预取只进 API 副本）。 |

**使用（外部记忆）**：在进入 tool/API 循环 **之前**，对 `original_user_message` 调用 **`MemoryManager.prefetch_all`**，结果存入 **`_ext_prefetch_cache`**，**整轮内多次 API 调用复用**，避免每条 tool 再预取一次。


### 11.4 阶段 2：单次 API 调用前（`api_messages` 组装）

| 事项 | 行为 |
|------|------|
| System | 使用已缓存的 system prompt（含 **内置记忆快照**、外部 `build_system_prompt()` 块、技能/平台提示等）。 |
| User 消息 | 对 **当前轮** 的 user 消息，在 **发往 API 的副本** 末尾 **追加**：`<memory-context>` 围栏包裹的 **`prefetch_all` 结果**（若有），以及 `pre_llm_call` 钩子注入的 user 侧上下文（若有）。 |
| 持久化 | **`messages` 列表本身不追加预取内容**，故会话落库、轨迹里 **看不到** 预取块，避免污染历史与重复计费语义。 |

**使用**：外部记忆的「召回」在此阶段被 **消费**；内置文件的 **system 快照** 也在此轮每条 API 请求中作为 system 的一部分被 **消费**（内容仍是不变的快照）。


### 11.5 阶段 3：工具循环中 — `memory` 工具（内置增删改）

模型发起 `memory` 调用时，由 `run_agent` 的 `_invoke_tool` 分支处理（与 `todo`、`session_search` 一样属 agent 层）。

| `action` | 语义 | 是否落盘 | 是否改 system 快照 |
|----------|------|----------|---------------------|
| **`add`** | 新条目 | 是（锁 + 原子写） | **否**（本会话） |
| **`replace`** | 用 `old_text` 定位一条，整段替换为 `content` | 是 | **否** |
| **`remove`** | 用 `old_text` 定位一条并删除 | 是 | **否** |

写入前经 **`_scan_memory_content`**，不通过则 **不产生任何变更**。

**成功后的副作用**：

- 若存在外部 `MemoryManager` 且动作为 **`add` 或 `replace`**，会调用 **`on_memory_write(action, target, content)`**，便于云端 **镜像** 内置库内容。
- 返回值中带 **`entries`**、**`usage`** 等，供模型 **立即** 看到最新全集（弥补 system 快照未更新）。

**注意**：Schema 中 **没有** 单独的 `read` action；「读」通过 **每次写操作返回的 `entries`** 或 **下一会话的 system 快照** 完成。


### 11.6 阶段 4：外部插件自有工具

若插件在 `get_tool_schemas()` 中暴露了额外工具，则通过 **`MemoryManager.handle_tool_call`** 转发到对应 **`handle_tool_call`**。**是否支持删除、如何更新** 完全由该插件定义（例如向量库删除、标签更新等），与内置 `memory` 的 `replace`/`remove` **不是**同一套参数。


### 11.7 阶段 5：本轮对话正常结束（得到 `final_response` 后）

| 顺序 | 事项 |
|------|------|
| 1 | **`MemoryManager.sync_all(original_user_message, final_response)`** — 把本回合用户话 + 助手最终答复 **同步** 到外部后端（各插件自行定义写入策略）。 |
| 2 | **`queue_prefetch_all(original_user_message)`** — 为 **下一轮** 用户输入准备后台预取（若插件实现）。 |
| 3 | **后台回顾**（可选）：若 `_should_review_memory` 或技能 nudge 满足，且未中断，则 **`_spawn_background_review`**：再起一个 **quiet 的 `AIAgent`**，带着 `messages_snapshot` 跑一小段对话，**仅** 为触发 `memory` / `skill_manage`；与主线程 **共享 `_memory_store`**，**不修改主 `messages`**。成功时可能打印 `💾` 摘要。 |

**产生**：外部记忆的后端更新主要发生在 **sync**；内置文件也可能在步骤 3 中间接 **再次写入**。


### 11.8 阶段 6：上下文压缩（`/compress` 或自动压缩）

顺序（概念上）：

1. **`flush_memories(..., min_turns=0)`**（压缩路径）：向消息列表临时追加一条 **系统口吻的 flush user 消息**，用 **仅开放 `memory` 工具** 的一次 LLM 调用（优先 auxiliary），促使模型把 **即将被摘要掉** 的对话里值得记的内容写入文件；然后 **从列表中移除 flush 相关痕迹**。
2. **`on_pre_compress(messages)`**：外部插件可返回要拼进 **压缩摘要提示** 的文本，减少「压缩即丢光」的风险。
3. 执行 **`ContextCompressor.compress`**，替换/缩短 `messages`。
4. **`_invalidate_system_prompt()`**：除清空 `_cached_system_prompt` 外，若存在 **`_memory_store`**，会调用 **`load_from_disk()`** —— **重新从磁盘载入并刷新 `_system_prompt_snapshot`**。随后 **`_build_system_prompt()`** 重建的 system 会包含 **截至此刻磁盘上的** `MEMORY.md` / `USER.md` 内容。因此：**压缩/使 system 失效这条路径** 会让「本会话内已写入磁盘、但先前未进快照」的记忆 **进入新的 system 前缀**（与「普通多轮对话中途不写快照」形成对照）。

**产生**：flush 可能 **新增** `memory` 条目；压缩摘要本身 **不写** 入 `MEMORY.md`（除非模型在 flush 中调了工具）。


### 11.9 阶段 7：会话结束 / 进程退出（并非常规每轮）

`MemoryProvider.on_session_end` / `shutdown` **不会**在每次 `run_conversation` 返回时自动调用（多轮 CLI 会话里每用户消息都会调一次 `run_conversation`）。实际 **会话边界** 由 CLI 退出、`/reset`、网关会话过期等路径处理；具体见 `run_agent.py` 中注释。

**子代理**：常 **`skip_memory=True`**，一般不初始化完整记忆栈；父代理侧可用 **`on_delegation`** 接收子任务结果（插件可选实现）。


### 11.10 `session_search`：产生、使用、能否删改

| 维度 | 说明 |
|------|------|
| **数据何时产生** | 会话消息 **写入 SQLite**（含 FTS 索引）时，随对话持续 **追加**；不是 `memory` 工具写的。 |
| **何时使用** | 模型调用 **`session_search`**，传入 `query`；实现中 **FTS 检索 → 选会话 → 截断 → 辅助 LLM 摘要**，结果以 **工具返回** 形式给主模型。 |
| **更新 / 删除** | 工具本身不提供「编辑某条记忆」的接口；**历史消息的变更** 来自会话存储策略（例如压缩 **替换** 早期消息为摘要、或清理策略）。与 `MEMORY.md` 的 **`replace`/`remove`** 无关。 |


### 11.11 小结表：三类对比

| 类型 | 主要「产生」时机 | 主要「使用」时机 | 更新 | 删除 |
|------|------------------|------------------|------|------|
| **内置文件记忆** | `memory` 的 add/replace/remove；flush；后台回顾 | System **快照**（会话加载）；**工具返回**（当轮最新） | **`replace`** | **`remove`** |
| **外部插件** | `sync_turn`、自有工具、`on_memory_write` 镜像 | `prefetch`→API 用户消息围栏；`build_system_prompt` 静态块；可选工具 | 依插件 | 依插件 |
| **session_search** | 对话 **落库** | 调用 **`session_search`** | 不写用户编辑接口 | 不写用户删除接口；库层面随会话策略变 |


## 12. 储存结构与字段说明

### 12.1 磁盘布局（Profile 下）

| 路径（相对 `HERMES_HOME`） | 用途 |
|----------------------------|------|
| `memories/MEMORY.md` | 内置「代理笔记」条目持久化 |
| `memories/USER.md` | 内置「用户画像」条目持久化 |
| `memories/*.lock`（如 `MEMORY.md.lock`） | **锁文件**，配合 `fcntl.flock`，非正文内容 |
| `state.db` | SQLite：**会话元数据 + 消息行**；`session_search` 的 FTS5 索引基于此库 |

正文 **无独立 JSON schema**：就是 UTF-8 文本，逻辑结构见下节。


### 12.2 `MEMORY.md` / `USER.md` 文件体结构

- **物理格式**：多个「条目」用固定分隔符拼接写入磁盘：  
  **`ENTRY_DELIMITER = "\n§\n"`**（换行 + § + 换行）。  
  读入时按该 **完整分隔符** `split`，每一段 `strip` 后非空即一条目。
- **单条内容**：**任意多行纯文本**（一条记忆一个字符串）；条目中若出现 **单独的 `§` 字符** 可能与分隔符混淆，实现上以 **完整 `\n§\n`** 为界。
- **去重**：`load_from_disk` 后对条目列表做 **`dict.fromkeys` 保序去重**。
- **无 ID 字段**：定位条目靠 **`replace` / `remove` 时的 `old_text` 子串匹配**（唯一命中或「多条内容相同」时操作第一条）。


### 12.3 运行时对象 `MemoryStore`（`tools/memory_tool.py`）

| 字段 / 属性 | 类型 | 作用 |
|-------------|------|------|
| `memory_entries` | `List[str]` | 当前 **memory** 路在内存中的条目列表（与磁盘同步于每次变更后） |
| `user_entries` | `List[str]` | 当前 **user** 路在内存中的条目列表 |
| `memory_char_limit` | `int` | **MEMORY** 路总字符上限（默认 2200，可由配置覆盖） |
| `user_char_limit` | `int` | **USER** 路总字符上限（默认 1375） |
| `_system_prompt_snapshot` | `Dict[str, str]` | 键 **`"memory"`**、**`"user"`**，值为 **`_render_block(...)`** 生成的 **整段** 文本；在 **`load_from_disk()`** 结束时刷新，供 **`format_for_system_prompt`** 使用（冻结快照语义） |

字符统计方式：该路所有条目用 **`ENTRY_DELIMITER.join(entries)`** 后的 **字符串长度**，与 token 无关。


### 12.4 注入 System 时的展示块（非磁盘格式）

`_render_block(target, entries)` 在 **快照** 与 **刚 load 后** 一致时生成，结构为：

1. 一行 **`═` × 46** 分隔线  
2. 一行 **标题**：  
   - `user` → `USER PROFILE (who the user is) [百分比 — 当前/上限 chars]`  
   - `memory` → `MEMORY (your personal notes) [百分比 — 当前/上限 chars]`  
3. 再一行 **`═` × 46**  
4. **正文**：`ENTRY_DELIMITER.join(entries)`（**无** 再包一层额外标题）

这是 **发给模型的 system 片段**，与裸 `.md` 磁盘文件（仅分隔条目）**排版不同**。


### 12.5 `memory` 工具：调用参数（OpenAI function 入参）

| 参数 | 类型 | 必填 | 作用 |
|------|------|------|------|
| `action` | string，枚举 | 是 | **`add`** 新增；**`replace`** 替换；**`remove`** 删除 |
| `target` | string，枚举 | 是 | **`memory`** → `MEMORY.md`；**`user`** → `USER.md` |
| `content` | string | `add` / `replace` 需要 | 新条目全文，或替换后的全文 |
| `old_text` | string | `replace` / `remove` 需要 | 用于在某一 **整条目** 内做 **子串匹配** 以定位要改/删的那一条 |

无 **`read`** action；读列表靠 **成功响应里的 `entries`**。


### 12.6 `memory` 工具：返回 JSON 字段

成功时（`_success_response`）：

| 字段 | 含义 |
|------|------|
| `success` | `true` |
| `target` | `"memory"` 或 `"user"` |
| `entries` | 当前该路 **全部条目** 字符串列表 |
| `usage` | 人类可读用量，如 `68% — 1,500/2,200 chars` |
| `entry_count` | 条目条数 |
| `message` | 可选，如 `Entry added.`、`Entry replaced.` |

失败时常见字段：

| 字段 | 含义 |
|------|------|
| `success` | `false` |
| `error` | 原因说明（含容量超限、未匹配、多匹配、安全扫描拦截等） |
| `current_entries` | 部分错误（如超限）时附带当前列表 |
| `usage` | 部分错误时附带 `"当前/上限"` 形式 |
| `matches` | 多条目匹配 `old_text` 且内容不同时，若干条目的 **前 80 字预览** |

（工具最外层由 `json.dumps` 序列化；与 `registry.tool_error` 的失败格式以实际返回为准。）


### 12.7 外部预取：注入用户消息时的围栏（非持久化）

| 结构 | 作用 |
|------|------|
| `<memory-context>` … `</memory-context>` | 包裹 **`MemoryManager.prefetch_all`** 合并后的文本 |
| 内嵌系统说明 | 标明此为 **回忆上下文、非用户新输入**（见 `build_memory_context_block`） |

**不写入** `messages` 持久化列表，仅存在于 **发往 API 的副本**。


### 12.8 `config.yaml` → `memory` 段字段

| 键 | 作用 |
|----|------|
| `memory_enabled` | 为真且存在 store 时，把 **MEMORY** 快照块拼进 system |
| `user_profile_enabled` | 为真时把 **USER** 快照块拼进 system |
| `memory_char_limit` | **MEMORY** 路字符上限 |
| `user_char_limit` | **USER** 路字符上限 |
| `provider` | 外部插件名；空 = 仅内置文件记忆 |
| `nudge_interval` / `flush_min_turns` | 可选；控制轻推与 flush 门槛（见 §6、§7、§11） |


### 12.9 `session_search` 相关：`state.db` 表结构（摘要）

会话与消息由 `hermes_state.py` 中 **`SCHEMA_SQL`** 定义，与 **`memory` 文件** 是 **另一套存储**。

**`sessions` 表**（与检索展示相关的字段含义）：

| 列 | 含义 |
|----|------|
| `id` | 会话主键 |
| `source` | 来源，如 `cli`、`telegram` |
| `user_id` | 网关等多用户场景下的用户标识 |
| `model` / `model_config` | 模型与配置快照 |
| `system_prompt` | 当时缓存的 system（可能很长） |
| `parent_session_id` | 压缩/委派等产生的 **父会话链** |
| `started_at` / `ended_at` / `end_reason` | 时间线与结束原因 |
| `message_count` 等 | 统计与计费相关列 |
| `title` | 会话标题（展示用） |

**`messages` 表**（FTS 索引 **`content`**）：

| 列 | 含义 |
|----|------|
| `id` | 自增主键 |
| `session_id` | 外键 → `sessions.id` |
| `role` | `user` / `assistant` / `tool` 等 |
| `content` | 正文；**FTS5 只索引此列**（见 `FTS_SQL`） |
| `tool_call_id` / `tool_calls` / `tool_name` | 工具调用相关 |
| `timestamp` | 时间戳 |
| `token_count` / `finish_reason` / `reasoning` 等 | 扩展字段 |

**`session_search` 返回 JSON**（随模式变化）：常见顶层键 **`success`**、**`query`**、**`results`**（内含 `session_id`、`summary` 等，以 `session_search_tool.py` 为准）、**`mode`**（如 `recent`）、**`count`**、**`message`**。


### 12.10 外部记忆插件

**完整机制、数据边界与插件差异见 §13。** 配置入口：`memory.provider` 与各插件 `plugin.yaml` / `get_config_schema()`。


## 13. 外部记忆插件：处理方式与实现细节

本节说明 Hermes **如何调用** 插件、**同步与预取各传什么**、**下一轮模型实际看到什么**，并点出 **Mem0 / Honcho** 等典型实现差异（以当前仓库代码为准）。

### 13.1 在整体架构中的位置

| 要点 | 说明 |
|------|------|
| **与内置记忆的关系** | 内置 **`MEMORY.md` / `USER.md`** 由 **`MemoryStore` + `memory` 工具** 管理，**不**注册在 `MemoryManager` 里。外部插件是 **叠加**：启用后仍可同时使用内置文件记忆（若配置开启）。 |
| **数量限制** | `MemoryManager.add_provider` 只允许 **一个非 builtin 插件**；第二个会被拒绝并打 warning，避免工具名冲突与多套后端打架。 |
| **发现与加载** | `plugins/memory/<name>/__init__.py`，经 `load_memory_provider(name)` 实例化；`memory.provider` 与包目录名一致。 |
| **工具表** | 插件 `get_tool_schemas()` 返回的函数在 **Agent 初始化时 append 到 `self.tools`**，并加入 `valid_tool_names`，与内置工具同一套调用链（除 `memory` 仍走 agent 特判外，插件工具走 `MemoryManager.handle_tool_call`）。 |

### 13.2 `initialize`：会话级上下文注入

在 `run_agent` 激活插件后调用 **`MemoryManager.initialize_all(session_id=..., **kwargs)`**，各插件 **`initialize`** 会收到（至少）：

- **`hermes_home`**：当前 profile 根目录，用于落盘配置或缓存；
- **`platform`**：如 `cli`、`telegram`；
- **`session_id`**：本会话 ID；
- **`user_id`**（网关等多用户场景）：用于按用户隔离记忆；
- **`agent_identity` / `agent_workspace`**：profile 名与 workspace 名（若可解析）；
- **`agent_context`**：如 `primary`；**非主对话**（子代理、cron、flush 等）时插件应 **避免污染用户表征**（接口文档见 `agent/memory_provider.py`）。

### 13.3 `sync_turn`：**同步给插件的不是「整段带工具的对话」**

`run_agent` 在每轮 **`run_conversation` 正常结束** 且存在 `final_response` 时调用：

```text
sync_all(original_user_message, final_response)
```

即传给插件的是：

| 参数 | 含义 |
|------|------|
| **用户侧** | **`original_user_message`**：本轮用户输入的「干净」文本（避免 skill 等注入污染检索/同步）。 |
| **助手侧** | **`final_response`**：本轮对话结束时 **返回给用户的最终助手正文**。 |

**不会**自动打包：

- 本轮内 **每一次** assistant 中间回复；
- **全部 tool 调用与 tool 返回**；
- 多轮 API 的完整 reasoning 轨迹。

这些内容仍在 Hermes 本地 **`messages` / `state.db`** 中；外部插件若需要，须 **自行** 通过工具或其它 API 拉取，而不是默认由 `sync_turn` 送达。

各插件在 **`sync_turn` 内部** 再决定：是 **原样写入会话**、还是交给 **服务端抽事实**（见下节）。

### 13.4 典型插件：`sync` 之后后端「存」的是什么

以下为 **实现层面** 举例，便于理解「不是逐字回放整段剧本」：

| 插件 | `sync_turn` 行为（摘要） |
|------|---------------------------|
| **Mem0** | 后台线程里调用 `client.add([{user},{assistant}], ...)`；注释标明由 **Mem0 服务端做 fact extraction**，即后端通常形成 **记忆条目**，而非仅堆原始对话。 |
| **Honcho** | 后台线程里将 **user** 与 **assistant** 文本 **按长度上限切块** 后 `session.add_message`，再 flush；即在 Honcho 侧累积的是 **轮次级 user/assistant 消息**，仍 **不含** Hermes 侧每条 tool 消息。 |

其它 `plugins/memory/*` 需读各自 `sync_turn` 实现；**契约输入**仍是上述 **一对字符串**。

### 13.5 `prefetch` / `queue_prefetch`：**下一轮「自动」看到什么**

| 步骤 | 行为 |
|------|------|
| **上轮结束** | `queue_prefetch_all(original_user_message)`：各插件在 **`queue_prefetch`** 里启动 **后台工作**（常见为 daemon 线程），为 **下一轮** 准备文本。 |
| **本轮开始** | 进入 tool 循环 **之前** `prefetch_all(query)`：取 **上轮排队结果**（或同步计算），合并后由 `build_memory_context_block` 包进 **`<memory-context>`**，拼到 **发往 API 的 user 消息副本** 末尾。 |
| **同轮多轮 tool** | `_ext_prefetch_cache` **只算一次**，避免 10 次 tool 调 10 次远端检索。 |

**重要**：预取内容一般是 **与当前用户 query 相关的检索 TopK、或方言/综合摘要**，**不是**「把前几轮完整 transcript 自动贴回上下文」。需要 **长对话原文级** 回忆时，应使用 **`session_search`** 或插件提供的 **`mem0_search` / `honcho_search`** 等工具。

**Mem0（`queue_prefetch`）**：对 **上一轮用户话** 做 `client.search(..., top_k=5)`，将命中条目的 **`memory` 字段** 拼成若干行，写入 `_prefetch_result`；`prefetch` 取出后格式化为 `## Mem0 Memory\n...`。可带 **熔断**（连续失败暂停同步/预取）。

**Honcho（`queue_prefetch`）**：后台调用 **`dialectic_query(session_key, query, peer="user")`**，将返回写入 `_prefetch_result`；`prefetch` 中可 **`_truncate_to_budget`**（按 `context_tokens` 粗算字符上限截断）。  

**Honcho 额外行为（须读配置）**：

- **`recall_mode == "tools"`**：**不**做自动预取注入（`prefetch` / `queue_prefetch` 早退），只能靠 **Honcho 系列工具** 取记忆。
- **`injection_frequency == "first-turn"`**：首 turn 之后 `prefetch` 可返回空，避免每轮注入。
- **`dialectic_cadence > 1`**：控制方言预取 **隔几轮** 才触发一次。

`system_prompt_block()` 会说明当前是 **tools / hybrid** 等模式，并可能带 **首 turn** 附加块（见 `honcho/__init__.py`）。

### 13.6 `build_system_prompt()`：静态说明块

除预取外，插件还可通过 **`system_prompt_block()`** 往 **system** 里追加 **固定说明**（例如「已启用 Mem0，可用 mem0_search」）。这与 **`<memory-context>`** 不同：后者是 **按轮、按查询** 的召回片段，且 **不进持久化 messages**。

### 13.7 与内置 `memory` 的桥接：`on_memory_write`

当主循环里内置 **`memory` 工具** 执行 **`add` 或 `replace` 成功** 后，`run_agent` 调用 **`MemoryManager.on_memory_write(action, target, content)`**（builtin 自身不再接收）。

- **Honcho 示例**：仅当 **`add` 且 `target == "user"`** 时，后台线程 **`create_conclusion`**，把内置用户画像写入 **镜像到 Honcho**。  
- 其它插件可按需实现，用于 **双写** 或 **审计**。

**`remove` 一般不触发** `on_memory_write`（当前 `run_agent` 只桥接 add/replace）。

### 13.8 其它钩子（简述）

| 钩子 | 调用时机 | 用途 |
|------|----------|------|
| **`on_pre_compress`** | 上下文压缩前，`MemoryManager` 聚合各插件返回值拼进压缩提示 | 在丢弃旧消息前抽取要点 |
| **`on_delegation`** | 父代理上子代理 **委派结束** | 可选记录子任务与结果 |
| **`on_session_end` / `shutdown`** | **真实会话结束**（CLI 退出、`/reset`、网关会话过期等），**不是**每次 `run_conversation` 返回 | flush 连接、落盘队列 |

### 13.9 线程与顺序（实现细节）

Mem0、Honcho 等普遍采用 **后台 daemon 线程** 执行 `sync_turn` / `queue_prefetch`，避免阻塞主对话。常见模式：**新 sync 开始前 `join` 上一轮 sync 线程（带超时）**，降低并发写入顺序错乱风险。具体超时与熔断策略以各插件为准。

### 13.10 与「独特性」相关的工程取舍（小结）

- **单一外部 provider + 统一生命周期**（initialize → prefetch/sync → hooks）便于 **网关多会话** 与 **配置一致**。  
- **`sync` 只传「用户一句 + 最终助手一句」** 控制 **带宽与隐私面**，并把「全量对话检索」留给 **`session_search` 与插件工具**。  
- **预取进 user 副本、不进持久化 history**，避免 **污染会话存储与缓存键**，并与 **内置 system 快照策略** 分工。


*文档生成自 hermes-agent 源码梳理，若实现变更请以代码为准。*
