# 旧记忆表清理方案（更正版）

## 📋 清理范围

基于**资产中心已是磁盘存储真实源**的事实，清理范围非常清晰：

### 删除对象
仅删除 **SQLite 数据库层的冗余**，保留资产中心磁盘文件：

```
❌ 删除：evoflow.db 中的 evoflow_memory* 表定义
❌ 删除：memory_repositories.py（仅操作旧表）
❌ 删除：migrate_legacy.py（迁移已完成）

✅ 保留：~/.evoflow/assets/users/*/memory/*.md（磁盘文件）
✅ 保留：资产中心各模块（hub.py, phase2.py, paths.py 等）
✅ 保留：mem_* 表（可选索引层，留给未来优化）
```

---

## 🔧 具体改动

### 1. `backend/packages/harness/evoflow/persistence/schema.py`

**删除**（第 916-944 行及相关索引）：
```python
# ❌ 删除这三个 CREATE TABLE
CREATE TABLE IF NOT EXISTS "evoflow_memory" (
    agent_key TEXT PRIMARY KEY,
    version TEXT NOT NULL DEFAULT '1.0',
    last_updated TEXT NOT NULL,
    UNIQUE (agent_key)
);

CREATE TABLE IF NOT EXISTS evoflow_memory_facts (
    agent_key TEXT NOT NULL,
    fact_id TEXT NOT NULL PRIMARY KEY,
    content TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general',
    ...
);

CREATE TABLE IF NOT EXISTS evoflow_memory_sections (
    agent_key TEXT NOT NULL,
    section_group TEXT NOT NULL,
    section_kind TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    section_updated_at TEXT,
    PRIMARY KEY (agent_key, section_group, section_kind)
);
```

**查找命令**：
```bash
rg "CREATE TABLE.*evoflow_memory" backend/packages/harness/evoflow/persistence/schema.py -A 10
```

---

### 2. 完全删除 `backend/packages/harness/evoflow/persistence/memory_repositories.py`

**整个文件删除**，包括：
- `memory_to_rows()` - 旧表导出
- `rows_to_memory()` - 旧表导入
- `save_memory()` - 已被资产中心替代
- `load_memory()` - 已被资产中心替代
- `agent_keys_with_memory_content()` - 仅用于诊断旧表

**验证无调用**：
```bash
rg "from evoflow.persistence.memory_repositories import" --type py
# 预期：仅在 migrate_legacy.py（也要删除）和自身定义处
```

---

### 3. 完全删除 `backend/packages/harness/evoflow/memory/migrate_legacy.py`

**整个文件删除**，包括：
- `ensure_legacy_migrated()` - 一次性迁移
- `_read_legacy_memory()` - 读旧表
- 迁移逻辑

**为什么安全删除**：
- ✅ 迁移已发生在历史数据库中
- ✅ 新安装的数据库从不创建旧表
- ✅ 超旧用户可通过数据库备份恢复

**验证无调用**：
```bash
rg "from evoflow.memory.migrate_legacy import|ensure_legacy_migrated" --type py
# 预期：仅在 memory/store.py 的初始化代码
```

---

### 4. `backend/packages/harness/evoflow/memory/store.py`

**移除对 migrate_legacy 的调用**：

```python
# ❌ 旧版本（第 ~30 行）
def get_atom(atom_id: str) -> dict[str, Any] | None:
    from evoflow.memory.migrate_legacy import ensure_legacy_migrated  # 删除导入
    ensure_legacy_migrated()  # 删除调用
    ...

# ✅ 新版本
def get_atom(atom_id: str) -> dict[str, Any] | None:
    # 直接调用（无需迁移）
    ...
```

**全局搜索并删除**：
```bash
rg "ensure_legacy_migrated" --type py
# 应该没有调用处（除了定义）
```

---

### 5. `backend/packages/harness/evoflow/agents/memory/updater.py`

**已依赖的函数替换**（第 44-47 行）：

目前调用 `agent_keys_with_memory_content()` 来检测哪些 Agent 有记忆。

**选项 A：直接查询资产中心**（推荐）
```python
# ❌ 旧版本
def list_memory_agent_slots() -> list[dict[str, Any]]:
    from evoflow.persistence.memory_repositories import agent_keys_with_memory_content
    try:
        content_keys = agent_keys_with_memory_content()
    except Exception:
        content_keys = set()

# ✅ 新版本
def list_memory_agent_slots() -> list[dict[str, Any]]:
    """List memory scopes: check which agents have asset center memory/standing.md."""
    content_keys: set[str] = set()
    try:
        # 扫描 ~/.evoflow/assets/agents/*/memory/standing.md
        assets_root = assets_root_path()  # from evoflow.assets.paths
        agents_dir = assets_root / "agents"
        if agents_dir.exists():
            for agent_dir in agents_dir.iterdir():
                if agent_dir.is_dir():
                    standing = agent_dir / "memory" / "standing.md"
                    if standing.exists():
                        content_keys.add(agent_dir.name)
        
        # 用户记忆
        users_dir = assets_root / "users"
        if users_dir.exists():
            for user_dir in users_dir.iterdir():
                if user_dir.is_dir():
                    standing = user_dir / "memory" / "standing.md"
                    if standing.exists():
                        content_keys.add("" if user_dir.name == "user" else user_dir.name)
    except Exception:
        logger.debug("list_memory_agent_slots: asset scan failed", exc_info=True)
```

**或选项 B：保留诊断函数**（如需向后兼容）

在 `memory/store.py` 中新增：
```python
def list_agents_with_memory() -> set[str]:
    """List agents that have memory.md files in asset center."""
    from evoflow.assets.paths import assets_root
    
    keys: set[str] = set()
    try:
        root = assets_root()
        # 扫描 agents/ 和 users/ 下的 memory/ 目录
        for subdir in ["agents", "users"]:
            dir_path = root / subdir
            if dir_path.exists():
                for entity_dir in dir_path.iterdir():
                    if entity_dir.is_dir() and (entity_dir / "memory").exists():
                        keys.add(entity_dir.name)
    except Exception:
        pass
    return keys
```

然后 `updater.py` 改为：
```python
from evoflow.memory.store import list_agents_with_memory
content_keys = list_agents_with_memory()
```

---

### 6. 删除过时注释

**更新文档注释**：
```bash
rg "evoflow_memory|legacy.*memory" --type py
```

删除或更新以下注释/错误信息：
```python
# ❌ 删除
"""Legacy path hint; memory is stored in :attr:`evoflow_db` table ``evoflow_memory``."""

# ❌ 删除
has_memory_file means the agent has non-empty chat memory in ``evoflow_memory`` (facts or section summaries)
```

**改为**：
```python
# ✅ 新
"""Memory is stored in asset center as .md files under ~/.evoflow/assets/"""

# ✅ 新
has_memory_file means the agent has memory files in asset center (standing.md, MEMORY.md, craft/*)
```

---

## 🧪 清理验证清单

### 代码检查
```bash
# 1. 确认没有调用旧 API
rg "from evoflow.persistence.memory_repositories" --type py
rg "from evoflow.memory.migrate_legacy" --type py
rg "ensure_legacy_migrated" --type py

# 2. 确认 schema 中已删除旧表
rg "CREATE TABLE.*evoflow_memory" backend/packages/harness/evoflow/persistence/schema.py

# 3. 确认文件已删除
ls backend/packages/harness/evoflow/persistence/memory_repositories.py  # 应报错
ls backend/packages/harness/evoflow/memory/migrate_legacy.py           # 应报错
```

### 功能测试
```python
# 1. 记忆写入仍正常
from evoflow.assets.hub import write_text_file
write_text_file(user_entity, "memory/standing.md", content)  # ✅

# 2. 记忆读取仍正常
from evoflow.assets.catalog import read_standing_memory
standing = read_standing_memory(user_entity)  # ✅

# 3. 列出有记忆的 Agent 仍正常
from evoflow.agents.memory.updater import list_memory_agent_slots
slots = list_memory_agent_slots()  # ✅

# 4. 新数据库不包含旧表
from evoflow.persistence.db import get_db
with get_db() as conn:
    try:
        conn.execute("SELECT 1 FROM evoflow_memory LIMIT 1")
        raise AssertionError("旧表不应存在")  # ❌
    except sqlite3.OperationalError:
        pass  # ✅
```

### 集成测试
```bash
cd backend
uv run pytest tests/ -k memory -v

# 关键测试：
# - test_memory_consolidate.py (Phase 2 仍正常)
# - test_entity_memory_inject_catalog.py (注入仍正常)
# - 任何使用 list_memory_agent_slots() 的测试
```

---

## 📊 变更统计

```
删除行数：
  - schema.py: ~28 行（evoflow_memory* 表 DDL）
  - memory_repositories.py: ~198 行（整文件）
  - migrate_legacy.py: ~130 行（整文件）
  - updater.py: ~5 行（旧导入）
  - store.py: ~3 行（旧调用）

总计删除：~364 行

新增行数：
  - updater.py 或 store.py: ~30 行（资产中心扫描或替代函数）

净效果：删除 ~334 行冗余代码 ✨
```

---

## 🚀 清理顺序

1. **第一步**：修改 `updater.py` / 新增替代函数（确保有替代才删旧）
2. **第二步**：删除 `schema.py` 中的表定义
3. **第三步**：删除 `memory_repositories.py` 文件
4. **第四步**：删除 `migrate_legacy.py` 文件
5. **第五步**：清理 `store.py` 中的旧调用
6. **第六步**：运行完整测试

---

## ⚠️ 向后兼容性

### 旧数据库升级
如用户拥有包含 `evoflow_memory*` 表的旧数据库：
1. **首次启动新版本**：旧表被忽略（无声删除或报告为过时）
2. **资产中心**：如之前已迁移，数据在磁盘 `.md` 中，完全可用
3. **未迁移的旧数据**：建议用户手动备份后升级（极少见）

### 测试场景
```python
# 模拟旧数据库（仅为测试）
# 方案：在测试数据库中保留一份旧表
# 升级后验证：旧表被忽略，资产中心数据仍可用
```

---

## 发布说明

```markdown
## 记忆系统简化：移除过时数据库表

✅ **用户影响**：无
- 资产中心（磁盘文件）是真实存储源，完全不受影响
- 所有记忆操作（读写）继续正常

🔧 **内部改进**：
- 删除 SQLite 冗余表 `evoflow_memory*`（已被资产中心替代）
- 删除迁移代码 (~300 行)
- 架构简化：磁盘文件 = 唯一真源
- 维护成本下降，代码清晰度提升

💡 **技术细节**：
- 资产中心 (Markdown 文件) 继续作为记忆存储源
- Phase 2 Consolidation 继续管理 standing/MEMORY/craft 更新
- 可选的 mem_* 索引层保留用于未来加速检索
```

