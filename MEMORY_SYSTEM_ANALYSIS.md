# EvoFlow 记忆体系架构分析

## 📋 总览

EvoFlow 现有记忆体系采用 **多层级、多维度** 的设计，将对话记忆、人格记忆、工作流记忆、项目知识整合到统一的原子化存储中。该系统处于 **混合迁移状态**：旧的文件系统 JSON 记忆逐步迁移到新的 SQLite 原子化存储。

---

## 🏗️ 架构全景

### 1. 存储层（Storage Layer）

#### A. 旧系统：文件系统 JSON（legacy，正在退役）
```
位置：内存中或 .evoflow/agents/{agent_name}/memory.json
结构：
{
  "version": "1.0",
  "lastUpdated": "2024-11-06T...",
  "user": {
    "workContext": { "summary": "...", "updatedAt": "..." },
    "personalContext": { ... },
    "topOfMind": { ... }
  },
  "history": {
    "recentMonths": { ... },
    "earlierContext": { ... },
    "longTermBackground": { ... }
  },
  "project": {
    "overview": { ... },
    "architecture": { ... },
    "entryPoints": { ... },
    "conventions": { ... },
    "gotchas": { ... }
  },
  "facts": [
    { "id": "...", "content": "...", "category": "...", "confidence": 0.9, ... }
  ]
}
```
- **弃用原因**：难以扩展、难以去重、难以版本管理
- **迁移对象**：`memory_repositories.py` 负责迁移逻辑

---

#### B. 新系统：原子化 SQLite（mem_* 表）
**位置**：`backend/packages/harness/evoflow/knowledge/owned/` → `owned.sqlite`

**核心表结构**：
```sql
-- 命名空间（隔离不同作用域的记忆）
CREATE TABLE mem_namespaces (
  id INTEGER PRIMARY KEY,
  kind TEXT,              -- "user" | "agent" | "person" | "workspace"
  owner_ref TEXT,        -- agent_code / workspace_key / user_id
  created_at TIMESTAMP
);

-- 原子化记忆条目
CREATE TABLE mem_atoms (
  id TEXT PRIMARY KEY,   -- UUID，全局唯一
  namespace_id INTEGER,  -- FK → mem_namespaces
  content TEXT,          -- 记忆内容（中文）
  layer TEXT,            -- "episodic" | "semantic" | "procedural" | "journal"
  kind TEXT,             -- "fact" | "section:*" | "howto" | "negative" | ...
  summary TEXT,          -- 短标题 / 总结
  importance REAL,       -- [0.0, 1.0]，记忆重要性
  confidence REAL,       -- [0.0, 1.0]，记忆可信度
  vitality REAL,         -- [0.0, 1.0]，衰减速率
  subject_key TEXT,      -- "section.user.workContext" | "fact:id" | "person:code"
  evidence JSON,         -- 证据和元数据
  tags TEXT[],           -- 标签数组
  source TEXT,           -- "wrap_up" | "migrate" | "user" | "manual"
  pin BOOL,              -- 核心记忆（不自动衰减）
  embedding_vec BLOB,    -- 向量化表示（可选）
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  deleted_at TIMESTAMP   -- 软删除
);
```

---

### 2. 命名空间隔离（Namespace Isolation）

**目的**：不同类型的记忆体需隔离，避免混污。

```python
# backend/packages/harness/evoflow/memory/namespaces.py

user_ns(user_id="default")
  ├─ 存储全局对话记忆（无特定 Agent）
  └─ 返回：user:default

agent_ns(agent_code)
  ├─ 存储 Agent 配置相关的对话记忆（注：已弃用，改用 user_ns）
  └─ 返回：agent:{code}

person_ns(agent_code)
  ├─ 存储 AI Agent 的人格记忆（自传体 + 程序性）
  └─ 返回：person:{code}
  └─ 核心场景：wrap_up 中记录 Agent 学到的工作流、用户偏好

workspace_ns(workspace_key)
  ├─ 存储工作空间级别的项目知识（技术栈、架构、规范）
  └─ 返回：workspace:{key}
```

---

### 3. 内存层次（Memory Layers）

#### L0: 旧遗留层（已弃用）
- SQLite 表：`evoflow_memory`、`evoflow_memory_sections`、`evoflow_memory_facts`
- 迁移到 L1 后不再写入

#### L1: 原子层（Active）
```
episodic (Journal)        → 具体事件、对话片段、日志
semantic (Fact)           → 抽象知识、规则、背景信息
procedural (How-to)       → 工作流、步骤、最佳实践
journal                   → 别名 → episodic
semantic_self             → 别名 → semantic
```

**分布特性**：
- **Episodic**：最新最热，衰减快（半衰期 7 天）
- **Semantic**：稳定基础，衰减慢
- **Procedural**：工作流型，带状态机（proposed → corrected → graduated → retired）

#### L2: 记忆注入层（System Prompt Injection）
**触发点**：`backend/packages/harness/evoflow/agents/memory/prompt.py`

- **对话记忆注入**：用户 memory 文档（sections + facts）
- **人格记忆注入**：Agent procedural 学到的工作流
- **项目记忆注入**：Workspace 架构、规范文档
- **检索策略**：多轴评分（recency × importance × relevance）

---

### 4. 记忆生命周期（Memory Lifecycle）

#### 生成阶段（Genesis）
```
对话完成 → wrap_up Agent 拆解 → insert_person_memory()
  ├─ 按层级分类（episodic / semantic / procedural）
  ├─ 计算 importance / confidence / vitality
  └─ 存入 mem_atoms（status = "proposed"）
```

**关键文件**：
- `backend/packages/harness/evoflow/agents/memory/updater.py`：记忆更新逻辑
- `backend/packages/harness/evoflow/persistence/person_memory_repositories.py`：持久化接口

#### 演进阶段（Evolution）
```
定期合并（consolidate）→ 相似记忆去重（fuzzy merge）
  ├─ 使用向量相似性（embedding cosine）
  ├─ 使用文本重叠度（token Jaccard / char bigram）
  └─ 衰减（vitality decay）
```

**关键文件**：
- `backend/packages/harness/evoflow/memory/consolidate.py`：合并、衰减、GC 逻辑

#### 提升阶段（Graduation）
```
Procedural 工作流评估
  ├─ 自动：hit_count 达到阈值 + importance 高 → graduated
  ├─ 手动：用户修正 → corrected → graduated
  └─ 效果：graduated 工作流获得核心地位 + 高优先级注入
```

#### 衰减阶段（Decay）
```
根据 vitality 和 recency 衰减
  └─ vitality 决定半衰期（0.5^(days/7) 模式）
  └─ pin=true 的记忆不衰减（核心记忆）
```

---

## 📐 核心操作接口

### 1. 记忆写入（Remember）
```python
# backend/packages/harness/evoflow/memory/facade.py

remember(
  namespace: str,           # "user:default" | "person:main" | "workspace:ws-abc"
  content: str,             # 记忆内容（中文）
  layer: str = "semantic",  # episodic / semantic / procedural
  kind: str = "fact",       # 记忆类型标签
  summary: str = "",        # 短标题
  importance: float = 0.5,  # [0.0, 1.0]
  confidence: float = 0.7,  # [0.0, 1.0]
  vitality: float = 1.0,    # 衰减参数
  subject_key: str = "",    # 主题（用于去重）
  pin: bool = False,        # 是否核心
  atom_id: str = None,      # 指定原子 ID（可选）
  embedding: list[float] = None  # 向量（可选）
) → str | None              # 返回 atom_id 或 None（低置信度被拒）
```

**置信度过滤**：
- `confidence < 0.55 && !pin && !subject_key && source != "user/manual"` → 拒绝写入
- 防止垃圾记忆

---

### 2. 记忆检索（Retrieve）
```python
# backend/packages/harness/evoflow/persistence/person_memory_repositories.py

retrieve_for_query(
  agent_code: str,
  query: str,
  limit: int = 8,
  include_procedural: bool = True,
  bump_hits: bool = True  # 检中即 hit++
) → list[dict]
```

**三轴评分**：
```
score = α·recency + β·importance + γ·relevance
where α=0.3, β=0.3, γ=0.4

recency = 0.5 ^ (days_since_update / 7)      # 半衰期 7 天
importance = base + boost_if_negative + ...   # 见 L620 业务逻辑
relevance = 0.6·cosine(embedding) + 0.4·overlap
           （如无 embedding，仅用 overlap）
```

**关键优化**：
- 向量化检索（embedding + cosine）
- 关键字重叠后备（token / char bigram Jaccard）
- 启发式标签提升（negative 工作流 +0.1 importance）

---

### 3. 记忆列表（List）
```python
list_person_memory(
  agent_code: str,
  limit: int = 20,
  layer: str | None = None   # 按层过滤
) → list[dict]

list_core_memory(
  agent_code: str,
  limit: int = 12  # 仅返回 access_tier="core" 的记忆
) → list[dict]

list_craft(
  agent_code: str,
  limit: int = 40,
  statuses: list[str] | None = ["graduated"],  # 过滤工作流状态
  kind: str | None = None
) → list[dict]
```

---

### 4. 记忆编辑（Update & Bump）
```python
update_craft_entry(
  entry_id: str,
  status: str | None = None,     # proposed → corrected → graduated → retired
  content: str | None = None,
  hit_count: int | None = None,
  importance: float | None = None,
  ...
) → bool

bump_craft_hit(
  entry_id: str,
  delta: int = 1  # 命中计数 +delta
) → int           # 返回新的 hit_count
```

---

## 🧠 特化记忆层

### A. 人格记忆（Person Memory）
**存储位置**：`person_ns(agent_code)`

**主要用途**：
- Agent 学到的工作流（procedural）
- 用户偏好（semantic）
- 交互习惯（journal 中的观察）

**四层架构**：
```
Layer          类型              生命周期              示例
─────────────────────────────────────────────────────────
episodic      事件/日志          衰减快(7d)           "用户报告 XXX 问题"
semantic      知识/规则          衰减慢(30d+)         "用户倾向深度讨论"
procedural    工作流/方法        自管理(graduated)    "当 A 时执行 B"
```

**状态机（Procedural Only）**：
```
          propose
             ↓
        ┌────────┐
        │proposed│ (验证阶段)
        └────┬───┘
             │ (用户反馈 / 验证)
             ↓
        ┌─────────┐
        │corrected│ (修正阶段)
        └────┬────┘
             │ (达到阈值)
             ↓
        ┌──────────┐
        │graduated │ (毕业，核心状态)
        └────┬─────┘
             │ (用户标记或衰减)
             ↓
        ┌────────┐
        │ retired │ (退休，不再使用)
        └────────┘
```

---

### B. 对话记忆（User Dialogue Memory）
**存储位置**：`user_ns("default")`

**结构**（遗留兼容，尚在文档编码中）：
```
user:
  workContext       → 工作背景（职位、项目、技术栈）
  personalContext   → 个人背景（语言、兴趣、沟通风格）
  topOfMind         → 本周优先级（4 句以内，避免长冗余）

history:
  recentMonths      → 最近 1-3 个月的活动详情
  earlierContext    → 3-12 个月前的活动和模式
  longTermBackground → 长期基础事实

facts:
  [{ "id", "content", "category", "confidence", "tags", ... }]
```

**分节点更新策略**：
- 每次对话后，wrap_up Agent 拆解对话内容
- 提取候选 facts（有置信度和 category）
- 更新各 section 的 summary（如有重大变化）

---

### C. 项目知识（Workspace Memory）
**存储位置**：`workspace_ns(workspace_key)`

**用途**：
- 项目架构、设计决策
- 编码规范、最佳实践
- API 接口定义、数据模型

**写入方式**：
- 用户手动上传 Markdown 文档 → 解析为 facts
- API 集成（待扩展）

---

## 🔄 关键流程

### 流程 1：对话记忆更新（After Wrap-up）
```
User Message → LLM Wrap-up Agent
  ├─ 拆解对话内容
  ├─ 提取 facts（category / confidence）
  ├─ 按优先级选择（置信度 > 0.7）
  └─ insert_person_memory() for each fact
     ├─ 分配 layer（episodic / semantic）
     ├─ 计算 importance（基于 confidence）
     ├─ source = "wrap_up"
     └─ 写入 person_ns(agent_code)

后续：记忆合并
  ├─ 周期性触发 consolidate()
  ├─ 相似性评分（embedding + text overlap）
  ├─ 衰减和 GC
  └─ 更新 access_tier（core / archival）
```

---

### 流程 2：系统提示词注入（Before LLM Call）
```
Gateway 准备 Prompt
  ├─ 读取 memory 配置（记忆容量、优先级权重）
  ├─ 调用 retrieve_for_query(user_query, ...)
  │  ├─ 三轴评分（recency / importance / relevance）
  │  └─ 返回 Top-K 原子化记忆
  ├─ 从各命名空间抽取记忆
  │  ├─ user_ns("default") → 对话历史和背景
  │  ├─ person_ns(agent_code) → 工作流模式
  │  └─ workspace_ns(ws_key) → 项目规范
  └─ 组合成 system prompt 文本
     └─ 注入 LLM 上下文
```

---

### 流程 3：工作流学习和提升（Procedural Graduation）
```
wrap_up 中检测工作流

if step_count(steps) >= 5 and success_rate >= 0.8:
  ├─ 抽取工作流（if_then_that 规则）
  ├─ insert_person_memory(..., layer="procedural", status="proposed")
  └─ 开始收集 hit_count

定期评估（consolidate）
  ├─ if hit_count >= threshold and importance >= 0.75:
  │   └─ status: proposed → graduated （自动提升）
  ├─ elif 用户手动修正:
  │   └─ status: proposed → corrected （用户确认）
  └─ 后续检索时 graduated 工作流优先级 +0.05

衰退机制
  ├─ if 使用频率下降:
  │   └─ status: graduated → retired （标记过时）
  └─ retired 工作流在检索中排除（除非 include_retired=true）
```

---

## 📊 数据布局和性能

### 1. 表索引策略
```sql
-- 快速命名空间查询
CREATE INDEX idx_mem_atoms_ns ON mem_atoms(namespace_id, deleted_at)

-- 向量/文本检索优化
CREATE INDEX idx_mem_atoms_embedding ON mem_atoms(namespace_id, embedding_vec IS NOT NULL)

-- 时间范围查询
CREATE INDEX idx_mem_atoms_updated ON mem_atoms(namespace_id, updated_at DESC)

-- 全文搜索（SQLite FTS5，可选）
CREATE VIRTUAL TABLE mem_atoms_fts USING fts5(content, summary)
```

### 2. 存储成本
- **单条记忆**：~200-500 字节（包含 JSON 元数据）
- **向量存储**：384-1536 维 × 4 字节 = 1.5-6 KB（可选）
- **容量建议**：单用户 5000-10000 原子 = ~2-5 MB

### 3. 查询性能
- **关键字检索**：O(log N)（索引覆盖）
- **向量相似性**：O(N)（暴力搜索或 ANN 待扩展）
- **建议批次**：限制检索 K ≤ 50；注入提示词时取 Top-8

---

## 🔧 配置和扩展点

### 配置文件
```python
# backend/packages/harness/evoflow/config/memory_config.py

consolidate:
  archive_vitality: 0.15  # 衰减阈值
  merge_similarity: 0.85  # 去重相似度阈值
  batch_size: 100         # 合并批次大小

injection:
  max_atoms_per_namespace: 8   # 检索时 Top-K
  importance_weight: 0.3
  recency_weight: 0.3
  relevance_weight: 0.4

embedding:
  enabled: true
  model: "text-embedding-3-small"
  dimensions: 384
```

### 扩展点
```python
# 自定义记忆更新策略
# backend/packages/harness/evoflow/agents/memory/updater.py
def update_memory_custom(...) → dict:
    """用户可自定义记忆更新逻辑"""
    pass

# 自定义检索策略
# backend/packages/harness/evoflow/memory/facade.py
def retrieve_custom(...) → list[dict]:
    """支持自定义三轴评分权重"""
    pass

# 自定义合并算法
# backend/packages/harness/evoflow/memory/consolidate.py
def merge_strategy_custom(...) → dict:
    """支持业界算法（SimHash、MinHash 等）"""
    pass
```

---

## ⚠️ 已知问题和优化方向

### 1. 迁移状态混杂
- **问题**：旧 JSON 文件和新 SQLite 表并存，导致代码维护成本高
- **方案**：
  - ✅ `ensure_legacy_migrated()` 在启动时自动转换
  - ⏳ 计划全量清理废弃旧接口（v2.0）

### 2. 向量化不完全
- **问题**：记忆写入时向量计算是异步后台任务，可能延迟
- **方案**：
  - 关键记忆（pin=true / high importance）优先向量化
  - 支持离线批量嵌入

### 3. 记忆注入冗长
- **问题**：大量原子化记忆拼接成文本后，prompt 膨胀 > 2000 tokens
- **方案**：
  - 聚类 + 摘要（同类记忆合并总结）
  - 动态预算分配（重要场景多分配）

### 4. 工作流学习阈值硬编码
- **问题**：`step_count >= 5 && importance >= 0.75` 对不同业务场景不适配
- **方案**：
  - 支持 Agent 级配置
  - A/B 测试最优阈值

### 5. 缺乏删除补偿
- **问题**：用户要求删除某条记忆时，相似的"孪生记忆"可能遗漏
- **方案**：
  - 显式删除时触发相似度搜索 + 级联删除选项
  - 记忆版本管理（如 git 风格的 cherry-pick）

---

## 📚 核心文件导航

| 路径 | 职责 |
|------|------|
| `backend/packages/harness/evoflow/memory/store.py` | 低层 SQLite 操作（CRUD） |
| `backend/packages/harness/evoflow/memory/facade.py` | 高层 API（remember / recall） |
| `backend/packages/harness/evoflow/memory/consolidate.py` | 合并、衰减、GC |
| `backend/packages/harness/evoflow/memory/namespaces.py` | 命名空间隔离 |
| `backend/packages/harness/evoflow/memory/document_codec.py` | 旧文档 ↔ 新原子互转 |
| `backend/packages/harness/evoflow/persistence/person_memory_repositories.py` | 人格记忆业务接口 |
| `backend/packages/harness/evoflow/agents/memory/updater.py` | 对话后记忆更新 |
| `backend/packages/harness/evoflow/agents/memory/prompt.py` | 系统提示词组装 |
| `backend/packages/harness/evoflow/persistence/memory_repositories.py` | 旧接口（兼容层） |

---

## 🎯 典型使用场景

### 场景 1：记录 wrap_up 后的学习成果
```python
from evoflow.memory.facade import remember
from evoflow.memory.namespaces import person_ns

# wrap_up Agent 检测到工作流模式
remember(
  namespace=person_ns("main"),
  content="当用户提问代码问题时，先问环境 → 查看报错 → 提供修复方案",
  layer="procedural",
  kind="howto",
  summary="代码调试工作流",
  importance=0.85,
  confidence=0.9,
  source="wrap_up",
  status="proposed"
)
```

### 场景 2：在提示词中注入相关记忆
```python
from evoflow.persistence.person_memory_repositories import retrieve_for_query

memories = retrieve_for_query("main", "怎样处理数据库连接错误", limit=5)
for mem in memories:
  system_prompt += f"\n- {mem['content']}"
```

### 场景 3：手动编辑工作流
```python
from evoflow.persistence.person_memory_repositories import update_craft_entry

# 用户改正了建议的工作流
update_craft_entry(
  entry_id="pm_abc123",
  status="corrected",
  content="修正后的流程..."
)
```

---

## 🔐 安全和隐私

### 1. 命名空间隔离
- 用户内存不与 Agent 内存混淆
- Workspace 知识可单独审计

### 2. 置信度过滤
- 低置信度噪声被自动拒绝
- 敏感信息可标记 confidence < 0.5 排除

### 3. 访问控制（未来扩展）
- `access_tier: core | archival` 支持权限扩展
- 可实现"只读"、"仅修正"等角色

---

## 📈 监控和调试

### 查看记忆统计
```python
from evoflow.persistence.person_memory_repositories import count_person_memory, list_core_memory

total = count_person_memory("main")  # 总计数
core = list_core_memory("main")      # 核心记忆（8+ 条）
```

### 查看记忆检索日志
```bash
# 启用调试日志
export EVOFLOW_LOG_LEVEL=DEBUG
# 搜索 "retrieve_for_query" 日志查看评分过程
```

### 性能分析
```python
# 在 console 中运行
from evoflow.memory import store as mem_store
from evoflow.memory.namespaces import person_ns

atoms = mem_store.list_namespace_atoms(person_ns("main"), limit=100)
print(f"Total atoms: {len(atoms)}")
print(f"Has embedding: {sum(1 for a in atoms if a.get('embedding_vec'))}")
print(f"Avg importance: {sum(a.get('importance', 0.5) for a in atoms) / len(atoms)}")
```

---

## 总结

EvoFlow 的记忆体系是一个**渐进式演化、多维度隔离、自适应衰减**的系统：

1. **原子化设计**：消除记忆块状结构，支持细粒度更新
2. **多轴评分**：时间 × 重要性 × 相关性三维平衡检索
3. **工作流学习**：自动识别 Agent 工作模式，逐级提升（proposed → graduated）
4. **向量增强**：向量化表示支持语义相似性搜索
5. **命名空间隔离**：用户 / Agent / Workspace 记忆独立管理，交叉污染风险低

**下一阶段重点**：
- 完成旧系统清理，加速 SQLite 迁移
- 大规模测试记忆注入对响应质量的影响
- 实现向量 ANN 索引加速相似度搜索
- 工作流阈值 A/B 测试优化

