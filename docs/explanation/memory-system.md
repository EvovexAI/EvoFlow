# 记忆系统原理

## 背景

传统的 LLM 对话是无状态的，每次对话都需要重新注入上下文。当用户与 Agent 长期协作时，重复输入相同信息会降低效率。记忆系统解决了这个问题：从对话中自动提取事实，持久化存储，并在后续对话中自动注入相关上下文。

## 设计理念

记忆系统的核心设计原则是**异步提取、防抖合并、按需注入**：

1. **异步提取**：不阻塞对话流，后台处理记忆更新
2. **防抖合并**：避免频繁调用 LLM 进行事实提取
3. **按需注入**：只注入最相关的事实，控制 token 消耗

## 核心组件

### MemoryMiddleware（中间件）

在每次对话完成后，MemoryMiddleware 过滤消息（用户输入 + 最终 AI 回复），将对话内容推入更新队列。这是记忆系统的入口。

### UpdateQueue（更新队列）

- 按线程去重，同一线程的多次更新合并
- 防抖等待（默认 30 秒），避免频繁触发
- 后台线程处理，不阻塞主对话

### MemoryUpdater（更新器）

Updater 是记忆系统的核心处理逻辑：

1. 接收队列中的对话批次
2. 调用 LLM 提取上下文更新和离散事实
3. 事实去重：修剪首尾空白后比较内容
4. 原子写入：临时文件 + rename 保证一致性
5. 缓存失效：更新后通知 Gateway 重新加载

### 记忆数据结构

```json
{
  "workContext": "用户的工作背景",
  "personalContext": "个人偏好信息",
  "topOfMind": "最近关注的点（1-3句）",
  "facts": [
    {
      "id": "uuid",
      "content": "用户偏好使用 Python 而非 JavaScript",
      "category": "preference",
      "confidence": 0.85,
      "createdAt": "2024-01-15T10:30:00Z",
      "source": "thread-abc123"
    }
  ],
  "history": {
    "recentMonths": "近几个月的上下文",
    "earlierContext": "更早的上下文",
    "longTermBackground": "长期背景"
  }
}
```

事实的 category 包括：
- `preference`：用户偏好
- `knowledge`：知识性事实
- `context`：上下文信息
- `behavior`：行为模式
- `goal`：目标/意图

## 记忆注入

在系统提示中，记忆通过 `<memory>` 标签注入：

```xml
<memory>
<user_context>
workContext: 用户是后端工程师...
personalContext: 偏好 Python，使用 VS Code...
topOfMind: 正在优化 Agent 系统...
</user_context>

<recent_facts>
- 用户偏好使用 Python 而非 JavaScript (confidence: 0.85)
- 项目部署在 Kubernetes 上 (confidence: 0.92)
...
</recent_facts>
</memory>
```

注入策略：
- 最多注入 15 条最近的事实
- 总 token 数不超过 `max_injection_tokens`（默认 2000）
- 如果记忆被禁用（`injection_enabled: false`），不注入任何内容

## 外部记忆插件

EvoFlow 支持可选的外部记忆插件（`external_provider`），扩展记忆存储能力：

- `external_sync_enabled: true`：在内置记忆保存后，同步最近一轮对话到外部插件
- `external_prefetch_enabled: true`：在模型调用前，从外部插件获取记忆上下文并注入

## 为什么选择防抖机制？

如果不防抖，每次对话结束都会触发 LLM 调用提取记忆，这会导致：
1. 高频 API 调用，增加成本
2. 碎片化的事实提取，质量下降
3. 可能的竞态条件（并发写入 memory.json）

防抖机制将短时间内的多次更新合并为一次处理，既节省成本又提高质量。

## 为什么选择原子写入？

记忆文件可能被 Gateway 和 LangGraph 同时读取。直接覆写可能导致读取到不完整的数据。使用临时文件 + rename 保证：
- 写入过程中读者看到的是旧数据
- rename 后读者看到的是完整的新数据
- 不会出现半写入的中间状态

## 配置参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `enabled` | `true` | 总开关 |
| `injection_enabled` | `true` | 是否注入到系统提示 |
| `storage_path` | `memory.json` | 存储路径 |
| `debounce_seconds` | `30` | 防抖等待时间 |
| `model_name` | `null` | 提取记忆用的模型 |
| `max_facts` | `100` | 最大事实数量 |
| `fact_confidence_threshold` | `0.7` | 最小置信度 |
| `max_injection_tokens` | `2000` | 注入上限 |

## 延伸阅读

- [memory-management.md](../guides/memory-management.md) - 记忆管理指南
- [middleware-chain.md](./middleware-chain.md) - 中间件执行链（MemoryMiddleware 的位置）
