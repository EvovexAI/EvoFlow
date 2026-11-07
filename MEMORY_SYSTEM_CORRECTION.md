# ⚠️ 记忆系统核正：资产中心 vs 数据库存储

## 关键发现

**你完全正确**。资产中心的记忆 **已经完全迁移到磁盘文件系统**，而不是数据库。

---

## 📊 现状梳理

### 资产中心（Asset Hub）—— 磁盘存储 ✅
**存储位置**：`${EVOFLOW_HOME}/assets/`

```
~/.evoflow/assets/
├── users/
│   └── <user_id>/
│       ├── profile/          # 用户背景 (USER.md)
│       ├── memory/
│       │   ├── standing.md           # v1: 长期记忆（4 类 block）
│       │   ├── MEMORY.md             # Task Group 格式
│       │   ├── episodic/             # 事件日志
│       │   ├── journal/              # 日记
│       │   ├── facts/                # 离散事实（*.md）
│       │   ├── craft/                # 可重用工作流（*.md）
│       │   └── _inbox/
│       │       ├── raw_memories.md   # 原始待处理
│       │       ├── notes/            # 用户笔记
│       │       └── phase2_workspace_diff.md
│       └── craft/
├── agents/
│   └── <agent_code>/
│       ├── profile/          # Agent SOUL (SOUL.md, identity.md)
│       └── memory/           # Agent 人格记忆（同上结构）
├── employees/
│   └── <emp_id>/
│       └── ... (同用户结构)
└── workspaces/
    └── <ws_id>/             # 或绑定项目的 <workspace>/.evoflow/
        ├── profile/
        └── memory/
```

**特性**：
- **原始 Markdown**：人类可读、可直接编辑
- **分层文件结构**：standing / MEMORY / episodic / journal / craft / facts
- **版本化**：standing.md 以 `v1` 开头
- **手动可编辑**：用户可直接在编辑器中修改 `memory/standing.md`

---

### 旧记忆表（evoflow_memory*）—— SQLite 数据库 ❌ 已弃用

**存储位置**：`.evoflow/evoflow.db`

```sql
evoflow_memory           -- 头信息 (agent_key, version, last_updated)
evoflow_memory_sections  -- 分节 (user/history/project → workContext/recentMonths/...)
evoflow_memory_facts     -- 事实数组
```

**问题**：
- 不再写入（`save_memory()` 已被 `OwnedMemoryStorage` 替代）
- 仅用于**迁移兼容**（`ensure_legacy_migrated()` 一次性读取转换）
- **重复存储**：同一份记忆既在磁盘 `.md` 又在数据库，浪费空间

---

### 新原子化层（mem_* 表）—— Owned KB 数据库 ⏳ 过渡中

**存储位置**：`.evoflow/owned.sqlite` 或网络 KB

```sql
mem_namespaces    -- 隔离命名空间 (user/agent/person/workspace)
mem_atoms         -- 原子化记忆 (id, content, layer, importance, embedding, ...)
```

**特性**：
- 细粒度、可搜索、支持向量相似性
- **仍在完成中**：用于内部检索和向量化
- **非主要存储**：应该只是资产中心的*索引层*

---

## 🗂️ 三层记忆体系的真实关系

```
┌─────────────────────────────────────────────────────────┐
│         资产中心（Asset Hub）— 磁盘文件系统 ✅           │
│    ~/.evoflow/assets/users/<id>/memory/                 │
│    - standing.md, MEMORY.md, episodic/, craft/, ...     │
│    - 手动可编辑，人类友好                                 │
│    - 真实存储源 (Source of Truth)                        │
└─────────────────────────────────────────────────────────┘
         ▲                           ▲
         │ 读/写（Phase 2）         │ 读（提示词注入）
         │                           │
    ┌────┴─────────────────┐   ┌────┴─────────────────┐
    │   新原子层 mem_*      │   │   旧表 evoflow_*      │
    │   (owned.sqlite)     │   │   (evoflow.db)       │
    │   - 向量化/搜索      │   │   - 已弃用            │
    │   - 索引层          │   │   - 迁移兼容         │
    │   - 过渡中          │   │   - 应删除            │
    └────────────────────┘   └────────────────────┘
        ▲                           ▲
        │ 存储                      │ 读（迁移）
        │                           │
    Phase 2 LLM 处理            ensure_legacy_migrated()
    (consolidation)
```

---

## 核正后的数据流

### 写入路径
```
用户输入 / 对话
  ↓
wrap_up Agent
  ↓
资产中心 write_text_file()
  ├─ memory/_inbox/raw_memories.md（待处理）
  └─ memory/standing.md（定期通过 Phase 2 合并）

↓ Phase 2 Consolidation（定期）

资产中心 Phase 2 更新
  ├─ memory/standing.md（v1 格式，LLM 重写）
  ├─ memory/MEMORY.md（Task Group 格式）
  ├─ memory/episodic/（日志）
  ├─ memory/craft/（工作流）
  └─ memory/facts/（事实）

✅ 磁盘文件（真实源）
```

### 读取路径（提示词注入）
```
LLM 需要上下文
  ↓
从资产中心读取
  ├─ memory/standing.md
  ├─ memory/MEMORY.md
  ├─ memory/facts/
  └─ memory/craft/

↓ 可选：通过 mem_* 表加速搜索（未来优化）

注入提示词
```

---

## ❌ 为什么要删旧表

### 现状问题
1. **三层存储重复**：磁盘 .md + SQLite 旧表 + SQLite 新表 = 存储浪费、同步复杂
2. **旧表已不再写**：`memory_repositories.save_memory()` 已被替代，仅是死代码
3. **迁移代码混乱**：`ensure_legacy_migrated()` 给新维护者造成困惑
4. **架构不清**：代码中充斥"兼容层"，不知道真实源是哪里

### 清理方案
```
前：  磁盘(.md) ← → SQLite 旧表 ← → SQLite 新表 ← → 迁移代码混乱
             ↓
后：  磁盘(.md) ← 真实源 ← 清晰 ✨
```

**删除**：
- `schema.py` 中的 `evoflow_memory*` 表定义
- `memory_repositories.py` 整文件（仅用于旧表操作）
- `migrate_legacy.py` 整文件（迁移已完成）

**保留**：
- 资产中心磁盘文件结构（`.md` 文件）
- Phase 2 LLM consolidation 逻辑
- 可选的 `mem_*` 索引层（用于加速检索，但不是主存储）

---

## 🎯 最终架构

```
应用层
  ↓
资产中心 API (hub.py, paths.py, hub_recall.py)
  ↓
磁盘文件系统（真实源）
  ├─ memory/standing.md
  ├─ memory/MEMORY.md
  ├─ memory/episodic/
  ├─ memory/craft/
  └─ memory/facts/
  ↓
可选：mem_* 索引层（加速搜索，不重复存储）
```

**核心特征**：
- ✅ 单一真源（磁盘文件）
- ✅ 人类可读可编辑
- ✅ 简单的写入流程（Phase 2 consolidation）
- ✅ 清晰的读取流程（资产中心 read）
- ✅ 可选的加速层（mem_* 索引）

---

## 修正后的清理方案

### 立即删除
```python
# ❌ 删除
schema.py: evoflow_memory* 表 DDL
memory_repositories.py: 整文件
migrate_legacy.py: 整文件
```

### 无需修改
```python
# ✅ 保持
assets/hub.py, hub_recall.py, paths.py, phase2.py
# 这些已经是正确的资产中心实现
```

### 验证检查
```bash
# 确认没有代码仍在调用旧 API
rg "from evoflow.persistence.memory_repositories import" --type py
rg "from evoflow.memory.migrate_legacy import" --type py
```

---

## 📝 总结

**之前分析的问题**：
- ❌ 误认为 `mem_*` 表是主存储 → 实际上是可选索引层
- ❌ 忽视了资产中心的磁盘文件 → 这才是真实源

**正确理解**：
```
磁盘文件系统（.md）= 真实存储源
    ↓ 可选
SQLite mem_* = 加速检索索引
    ↓ 已弃用
SQLite evoflow_memory* = 应删除
```

**行动**：
- 删除旧表 + 迁移代码（~350 行）
- 保留资产中心实现（已正确）
- 可选完善 mem_* 索引层

