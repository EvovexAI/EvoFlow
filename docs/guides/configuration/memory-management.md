# 记忆管理

## 适用场景
管理 Agent 的长期记忆，包括用户上下文、事实提取和记忆注入。使 Agent 能够在多轮对话中记住用户偏好和工作背景。

## 前置条件
- EvoFlow 已运行
- `config.yaml` 中 `memory.enabled: true`（默认开启）

## 系统概览

记忆系统包含以下组件：

| 组件 | 说明 |
|------|------|
| **用户上下文** | `workContext`、`personalContext`、`topOfMind` — 1-3 句摘要 |
| **历史上下文** | `recentMonths`、`earlierContext`、`longTermBackground` — 不同时间跨度的背景信息 |
| **事实库** | 离散事实条目，含 `id`、`content`、`category`、`confidence`（0-1）、`createdAt`、`source` |
| **分类体系** | 事实类别：`preference`、`knowledge`、`context`、`behavior`、`goal` |

### 存储位置

记忆数据存储在 `backend/.evo-flow/memory.json`（可通过 `memory.storage_path` 自定义）。

## 记忆更新机制

### 工作流程

1. `MemoryMiddleware` 过滤消息（用户输入 + 最终 AI 回复）并加入更新队列
2. 队列按线程去重，防抖等待（默认 30 秒）
3. 后台线程调用 LLM 提取上下文更新和事实
4. 原子写入（临时文件 + 重命名），避免并发冲突
5. 事实去重：比较 trimmed 内容，相同内容不重复存储

### 防抖与去重

- **防抖**：`debounce_seconds` 控制等待时间（默认 30s），避免频繁调用 LLM
- **去重**：同一线程的多次更新会被合并
- **事实去重**：新事实的内容与已有事实比较，重复则跳过

### 置信度阈值

```yaml
memory:
  fact_confidence_threshold: 0.7  # 低于此置信度的事实不存储
  max_facts: 100                   # 事实上限，超出时按置信度排序保留顶部
```

## 记忆注入系统提示

当 `injection_enabled: true` 时，记忆会在系统提示中以 `<memory>` 标签注入：
- 注入 Top 15 条事实（按置信度排序）
- 注入用户上下文摘要
- 总 token 数受 `max_injection_tokens` 限制（默认 2000）

## 在 EvoPanel 中管理记忆

EvoPanel 桌面端提供以下记忆管理功能：

- **查看记忆**：浏览当前记忆数据（用户上下文、事实列表）
- **编辑记忆**：手动修改或删除特定事实
- **清空记忆**：重置所有记忆数据
- **导入/导出**：导出 `memory.json` 文件备份，或导入外部记忆文件
- **按 Agent 管理**：每个自定义 Agent 有独立的记忆文件（`agents/{id}/memory.json`）

### API 接口

```bash
# 获取记忆数据
curl http://localhost:8001/api/memory

# 获取记忆配置
curl http://localhost:8001/api/memory/config

# 获取记忆状态（配置+数据）
curl http://localhost:8001/api/memory/status

# 强制重新加载记忆
curl -X POST http://localhost:8001/api/memory/reload
```

## 外部记忆插件（可选）

EvoFlow 支持外接记忆插件（如 Honcho），实现跨平台记忆同步：

```yaml
memory:
  external_provider: ""           # 插件标识（空=禁用，"echo"=测试模式）
  external_sync_enabled: false    # 内置记忆更新后同步到外部插件
  external_prefetch_enabled: false  # 模型调用前从外部插件预取记忆
```

## 导出/导入记忆文件

```bash
# 导出
cp backend/.evo-flow/memory.json ~/memory-backup.json

# 导入
cp ~/memory-backup.json backend/.evo-flow/memory.json

# 按 Agent 导出
cp backend/.evo-flow/agents/my-agent/memory.json ~/agent-memory-backup.json
```

## 验证是否生效

```bash
# 检查记忆状态
curl http://localhost:8001/api/memory/status

# 开始对话，询问 Agent "你记得关于我的什么？"
# Agent 应返回记忆中存储的事实
```

## 常见问题

**Q: 记忆没有更新？**
检查 `memory.enabled: true`。确认对话中包含用户消息和 AI 回复（仅有工具调用不会触发更新）。等待 `debounce_seconds` 后再检查。

**Q: 事实太多，想让 Agent 只记住重要的？**
提高 `fact_confidence_threshold`（如 0.8）或降低 `max_facts`。

**Q: 如何清除所有记忆？**
通过 EvoPanel 点击"清空记忆"，或执行：
```bash
echo '{"user":{"workContext":{},"personalContext":{},"topOfMind":{}},"history":{"recentMonths":{},"earlierContext":{},"longTermBackground":{}},"facts":[]}' > backend/.evo-flow/memory.json
```

**Q: 上传文件的信息被存入了记忆？**
系统会自动过滤包含文件上传描述的事实，避免跨会话残留临时文件引用。

## 相关文档
- [EvoPanel 桌面端使用指南](../configuration/evopanel-guide.md)
