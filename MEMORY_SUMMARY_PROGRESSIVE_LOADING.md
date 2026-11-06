# 记忆摘要问题分析 & 渐进式加载方案

## 🔴 当前问题

### 症状
- 记忆摘要被**全量前置注入**系统提示
- 摘要太长，分散模型注意力
- 每轮都要加载，即使可能不需要
- Duty 模式: 第 298 行 `mem_summary = _memory_brief_without_work_log_echo(...)`
- Chat 模式: 被注入 `memory_context`

### 代价
```
当前流程:
  prompt 组装
    └─ 全量注入记忆摘要（~400-600 字）
       └─ 模型处理（浪费 token）
       └─ 分散注意力
       └─ 影响输出质量
```

### 数据点
- `TIER1_PERSON_MEMORY_CHARS = 400`（人员记忆）
- `TIER0_STANDING_CORE_CHARS = 2000`（整体预算）
- `TIER1_RECALL_MAX_CHARS = 600`（每轮召回）

---

## ✨ 渐进式加载方案

### 核心想法

**当前**：
```
系统提示 = SOUL + 记忆摘要 + 工作日志 + ...
           ↓ 全量前置
          模型调用
```

**改为**：
```
系统提示 = SOUL + [记忆摘要：仅关键索引] + 工作日志 + ...
           ↓
          模型判断
           ├─ 需要详细记忆？→ 调用 `memory_retrieve` 工具
           │  └─ 返回完整摘要或详情
           └─ 不需要？→ 继续推进
```

### 分层方案

#### 第 0 层（系统提示中）- 轻量级

**不放完整摘要，只放索引**：

```markdown
## 记忆摘要可用

你有长期记忆可用。如需参考，使用 `memory_retrieve` 工具检索。
可用类别：
  - 工作心得（craft）
  - 用户偏好（preferences）
  - 过往成功案例（episodic）
```

或者更简洁：
```
[提示：你可以通过 memory_retrieve 工具访问长期记忆]
```

#### 第 1 层（工具调用）- 按需加载

**新增工具** `memory_retrieve`：

```python
class MemoryRetrieveTool:
    """按需加载长期记忆的详细内容。"""
    
    def invoke(self, query: str = "", category: str = "all") -> str:
        """
        Args:
            query: 可选查询词（用于搜索相关记忆）
            category: 记忆类别 [all, craft, episodic, preferences]
        
        Returns:
            完整的记忆摘要（最多 ~1000 字）
        """
        # 从磁盘加载完整记忆
        # 如果有 query，则搜索相关片段
        # 返回人类可读的摘要
```

#### 第 2 层（后台自动判断）- 智能前置

**可选**：根据任务类型或历史自动判断是否需要前置记忆：

```python
def should_inject_memory_upfront(
    query: str,
    role: ProactiveRole,
    context: str,
) -> bool:
    """判断是否应提前注入记忆（不走工具调用）。"""
    
    # 规则 1: 关键词匹配 → 前置
    if any(kw in query for kw in ["复审", "反思", "总结"]):
        return True
    
    # 规则 2: 无工作日志 → 前置（防止完全无上下文）
    if "暂无历史" in context:
        return True
    
    # 规则 3: 频繁调用记忆工具 → 前置（学习历史）
    if tool_call_count("memory_retrieve") > 3:
        return True
    
    # 默认不前置
    return False
```

---

## 🛠️ 实施计划

### Phase 1: 最小化摘要（快速修复）

**文件**：`backend/packages/harness/evoflow/proactive/prompt.py:272`

```python
# 当前：完整摘要
mem_summary = _memory_brief_without_work_log_echo(memory.summary(max_items=8), log)

# 改为：仅摘要索引（更激进裁剪）
MEMORY_INDEX_CHARS = 200  # 而非现在的 400+
mem_summary = _memory_brief_without_work_log_echo(
    memory.summary(max_items=3),  # 而非 max_items=8
    log
)
# 然后手动截断到 200 字
from evoflow.assets.injection_budget import cap_text_chars
mem_summary = cap_text_chars(mem_summary, 200)
```

**优点**：
- ✅ 立即生效
- ✅ 0 代码复杂度
- ❌ 牺牲信息量

### Phase 2: 资产工具按需加载（完整方案）

**使用现有**：`assets` 工具已支持全部操作

模型需要完整记忆时，直接调用资产工具：

```python
# 模型需要详细心得时
assets(action="read", path="agent:xxx/memory/craft")

# 模型需要搜索相关记忆
assets(action="search", query="用户偏好", limit=5)

# 模型需要列出可用资产
assets(action="list", path="agent:xxx/memory")
```

**无需新建工具** ✅
- 资产工具已支持 read/search/list 操作
- 模型可按需调用
- Token 动态分配
- 完整信息始终可得

### Phase 3: 智能判断（可选）

在系统提示中添加 `should_inject_memory_upfront()` 逻辑

---

## 📊 效果对比

| 方案 | 系统提示大小 | 模型调用 | 信息丢失 | 复杂度 |
|------|-----------|--------|---------|------|
| **当前** | +400字 | 0 | 0% | 低 |
| **Phase 1** | +200字 | 0 | 中等 | 极低 |
| **Phase 2** | +50字 | 1-2x | 0% | 中 |
| **Phase 3** | +50字 | 1-2x | 0% | 高 |

---

## 🎯 推荐路径

### 立即做：Phase 1（快速修复）

只需改两行，摘要从 400+ 字→ 200 字：

```python
# prompt.py:272
mem_summary = cap_text_chars(
    _memory_brief_without_work_log_echo(memory.summary(max_items=3), log),
    200  # 从现在的无限制→ 200 字
)
```

**效果**：
- ✅ 立即缓解问题
- ✅ token 节省 50%
- ✅ 保留核心信息

### 后续：Phase 2（渐进式加载）

- [ ] 新增 `memory_retrieve` 工具
- [ ] 系统提示改为索引提示
- [ ] 模型需要时自行调用工具

---

## 💡 额外优化

### 1. 分类记忆注入

不是全放，而是按优先级：

```
优先级高（前置）：
  - 用户偏好 / 禁忌
  - 关键决策记录

优先级低（工具按需）：
  - 完整 episodic（过往故事）
  - 详细 craft（完整心得）
```

### 2. 上下文感知

根据当前任务类型选择：

```python
if "计划" in query or "设计" in query:
    # 规划任务 → 注入 craft（过往心得）
    inject_memory_category = "craft"
elif "反思" in query or "总结" in query:
    # 反思任务 → 注入 episodic（过往经验）
    inject_memory_category = "episodic"
else:
    # 常规任务 → 不前置，改用工具
    inject_memory_category = None
```

### 3. 工具调用计数

学习：如果某个用户/任务经常调用 `memory_retrieve`，下次自动前置该类记忆

---

## 📝 总结

| 问题 | 原因 | 解决方案 |
|------|------|--------|
| 记忆摘要太长 | 全量前置注入 | **Phase 1**：裁剪到 200 字 |
| 模型分散注意力 | 无关信息混入 | **Phase 2**：改工具调用 |
| 无法按需加载 | 架构不支持 | **Phase 3**：智能判断 |

**即刻行动**：Phase 1（改 2 行，效果立竿见影）

