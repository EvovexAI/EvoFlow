# 记忆系统清理方案：移除旧表，统一资产中心

## 现状分析

### ✅ 已完成
- **资产中心基础**：`owned.sqlite` 中的 `mem_*` 表已完全建立
- **新读写层**：`OwnedMemoryStorage` 完全接管记忆读写
- **迁移机制**：`ensure_legacy_migrated()` 一次性转换旧数据

### ❌ 问题
**旧表仍然存在于 schema 中，但已不再写入**：
- `evoflow_memory`（头信息）
- `evoflow_memory_sections`（分节内容）
- `evoflow_memory_facts`（事实）

**冗余的兼容层**：
- `memory_repositories.py` 中 `memory_to_rows()` / `rows_to_memory()` 仅用于迁移
- `save_memory()` / `load_memory()` 已被 `OwnedMemoryStorage` 替代
- 删除逻辑只清理旧表，不影响新系统

---

## 清理步骤

### Step 1：删除旧表的创建语句（schema.py）

**现状**：第 916-944 行
```sql
CREATE TABLE IF NOT EXISTS "evoflow_memory" (...)
CREATE TABLE IF NOT EXISTS evoflow_memory_facts (...)
CREATE TABLE IF NOT EXISTS evoflow_memory_sections (...)
```

**操作**：
```bash
# 删除这三个 CREATE TABLE 语句
# 同时删除相关索引
```

### Step 2：删除迁移代码（migrate_legacy.py）

**整个文件可以删除**，因为：
- ✅ 已运行过 `ensure_legacy_migrated()` 的数据库已转换
- ✅ 新数据库不再创建旧表，无需迁移
- ❓ 极端情况（用户手工恢复超旧备份）无需支持

**替代方案**：
- 如需保留向后兼容，仅保留一个**弃用警告**
- 用户若遇到旧数据库，指向文档说明迁移方式

### Step 3：删除/清理 memory_repositories.py

**保留项**：（迁移辅助，低频调用）
```python
# 可选保留，用于诊断
def agent_keys_with_memory_content() → set[str]:
    """检查旧表是否还有数据（仅用于诊断）"""
```

**删除项**：
```python
# ❌ 删除
memory_to_rows()          # 仅用于导出旧表
rows_to_memory()          # 仅用于导入旧表
save_memory()             # 已被 OwnedMemoryStorage.save() 替代
load_memory()             # 已被 OwnedMemoryStorage.load() 替代
_delete_children()        # 仅删旧表用
```

**迁移受影响的导入**：
```python
# 现在：from evoflow.persistence.memory_repositories import save_memory
# 改为：from evoflow.memory.facade import remember  或  from evoflow.memory.storage import OwnedMemoryStorage
```

### Step 4：清理 config/paths.py

**删除**：
```python
def memory_file(self) -> Path:
    """Legacy path hint; memory is stored in :attr:`evoflow_db` table ``evoflow_memory``."""
```

**改为**：
```python
# 文档注释改为指向 owned.sqlite / mem_* 表
```

### Step 5：更新 storage.py 的日志和注释

**改进**：
```python
logger.info("Memory storage → OwnedMemoryStorage (mem_*)")  # 移除"legacy retired"
```

### Step 6：更新 updater.py 的文档

**移除引用**：
```python
# 旧：has_memory_file means the agent has non-empty chat memory in evoflow_memory
# 新：has_memory_file means the agent has non-empty chat memory in mem_* atoms
```

---

## 受影响的代码调用链

### 需要修改的导入
```python
# ❌ 旧
from evoflow.persistence.memory_repositories import save_memory, load_memory

# ✅ 新
from evoflow.memory.storage import OwnedMemoryStorage

storage = OwnedMemoryStorage()
storage.save(document, agent_name)  # 等价于旧的 save_memory()
doc = storage.load(agent_name)      # 等价于旧的 load_memory()
```

### 检查已有调用
```bash
rg 'from evoflow.persistence.memory_repositories import' --type py
rg 'from evoflow.persistence import.*memory' --type py
```

目前检查结果（应该没有调用）：
- `backend/packages/harness/evoflow/memory/migrate_legacy.py` - 仅迁移用，可删除
- `backend/packages/harness/evoflow/persistence/repositories.py` - 可能有，需检查

---

## 验证清理完成

### 数据库兼容性
```bash
# 旧版本数据库（upgrade 前）
# evoflow.db 仍包含 evoflow_memory* 表
# → migration 检查：自动跳过（表已删除声明）
# → 迁移流程：用户需手动运行清理脚本（可选）

# 新版本数据库（upgrade 后）
# evoflow.db 不包含 evoflow_memory* 表
# → owned.sqlite 包含 mem_* 表
# → 无冗余，完全统一
```

### 测试清单
```python
# 1. 记忆写入不受影响
from evoflow.memory.facade import remember
aid = remember(namespace="user:default", content="test", ...)
assert aid is not None

# 2. 记忆检索不受影响
from evoflow.persistence.person_memory_repositories import retrieve_for_query
results = retrieve_for_query("main", "query")
assert len(results) >= 0

# 3. 旧表不存在（新数据库）
from evoflow.knowledge.owned.db import db
with db() as conn:
    try:
        conn.execute("SELECT * FROM evoflow_memory LIMIT 1")
        assert False, "旧表不应该存在"
    except Exception:
        pass  # 预期错误
```

---

## 迁移路径（用户升级指南）

### 情景 A：新安装
✅ **无影响**，新数据库直接使用 `mem_*` 表

### 情景 B：现有用户升级
1. **备份**：`evoflow.db` 和 `owned.sqlite`
2. **升级**：安装新版本代码
3. **迁移**（如有旧记忆）：
   ```bash
   # 运行一次性迁移脚本（可选）
   python -m evoflow.memory.migrate_legacy_batch
   ```
4. **验证**：检查记忆是否正常出现在资产中心
5. **清理**（可选）：
   ```bash
   # 删除已迁移的旧表数据（不影响 mem_*）
   python -m evoflow.scripts.cleanup_legacy_memory_tables
   ```

---

## 实施计划

### Phase 1：准备（现在）
- [ ] 确认所有记忆业务逻辑已迁移到 `mem_*` 表
- [ ] 检查是否有生产数据库仍在使用 `evoflow_memory` 表
- [ ] 编写数据清理脚本（可选）

### Phase 2：代码清理（当前 PR）
- [ ] 删除 `schema.py` 中的三个旧表 DDL
- [ ] 删除或重构 `memory_repositories.py` 中的旧接口
- [ ] 删除 `migrate_legacy.py`（或保留为弃用警告）
- [ ] 更新所有文档和注释

### Phase 3：测试和发布
- [ ] 运行完整测试套件（特别是记忆相关）
- [ ] 验证新安装和升级路径
- [ ] 发布版本说明

### Phase 4：生产迁移
- [ ] 通知现有用户清理旧数据（可选）
- [ ] 监控记忆操作是否异常
- [ ] 预留回滚计划

---

## 代码清理粗略变更量

```
删除：
  - schema.py: ~30 行（三个 CREATE TABLE）
  - migrate_legacy.py: ~100 行（整文件）
  - memory_repositories.py: ~120 行（5 个函数）
  
修改：
  - config/paths.py: 2-3 行
  - agents/memory/storage.py: 1 行注释
  - agents/memory/updater.py: 5-10 行文档

总计：~150-160 行代码删除，5-10 行修改
```

---

## 最终状态

### ✅ 完成后
- **单一真源**：`owned.sqlite` 中的 `mem_*` 表
- **清爽的代码**：无冗余的兼容层
- **性能提升**：少一层转换开销
- **可维护性**：业务逻辑直接依赖新 API

### 🏗️ 架构简化
```
Before:
  Gateway/Agent → memory_repositories.py (旧API)
                ↓
                evoflow_memory* 表 (SQLite)
                ↓
                migrate_legacy() (定期转换)
                ↓
                OwnedMemoryStorage → mem_* 表 (Owned KB)

After:
  Gateway/Agent → OwnedMemoryStorage API
                ↓
                mem_* 表 (Owned KB)
                ✨ 完成
```

