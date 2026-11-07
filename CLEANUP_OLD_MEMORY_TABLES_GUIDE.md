# 清理旧记忆表实施指南

## 🎯 目标
删除 `evoflow_memory*` 旧表的所有声明和兼容层，统一迁移到资产中心 `mem_*` 原子化存储。

## 📋 具体改动清单

### 1. `backend/packages/harness/evoflow/persistence/schema.py`

**删除的 DDL（约第 916-944 行）**：
```python
# ❌ 删除这三个 CREATE TABLE
CREATE TABLE IF NOT EXISTS "evoflow_memory" (...)
CREATE TABLE IF NOT EXISTS evoflow_memory_facts (...)
CREATE TABLE IF NOT EXISTS evoflow_memory_sections (...)

# ❌ 删除相关索引（如果有）
CREATE INDEX IF NOT EXISTS idx_evoflow_memory_agent_key ...
```

**查找命令**：
```bash
rg "CREATE TABLE.*evoflow_memory" backend/packages/harness/evoflow/persistence/schema.py
```

---

### 2. `backend/packages/harness/evoflow/persistence/memory_repositories.py`

**完全删除此文件**（或保留为已弃用）。

**原因**：
- `memory_to_rows()` → 仅用于旧表导出
- `rows_to_memory()` → 仅用于旧表导入  
- `save_memory()` → 已被 `OwnedMemoryStorage.save()` 替代
- `load_memory()` → 已被 `OwnedMemoryStorage.load()` 替代
- `_delete_children()` → 仅删旧表用
- `agent_keys_with_memory_content()` → 迁移方法，改为直接查询 `mem_namespaces`

**替代方案**：
若需诊断旧数据是否存在（极少数情况），保留一个只读诊断函数：

```python
# 新版本：backend/packages/harness/evoflow/memory/store.py 中新增

def list_agents_with_memory() -> set[str]:
    """List all agents/users that have memory atoms in mem_* tables."""
    from evoflow.knowledge.owned.db import db

    keys: set[str] = set()
    try:
        with db() as conn:
            rows = conn.execute("""
                SELECT DISTINCT n.kind, n.owner_ref
                FROM mem_namespaces n
                JOIN mem_atoms a ON a.namespace_id = n.id
                WHERE a.deleted_at IS NULL
            """).fetchall()
            for row in rows:
                kind = row["kind"]
                owner = row["owner_ref"]
                if kind == "agent":
                    keys.add(owner)
                elif kind == "user" and owner in ("", "default"):
                    keys.add("")
                elif kind == "workspace":
                    keys.add(owner if owner.startswith("ws-") else f"ws-{owner}")
    except Exception:
        pass
    return keys
```

---

### 3. `backend/packages/harness/evoflow/agents/memory/updater.py`

**改动**（第 44-47 行）：

```python
# ❌ 旧版本
def list_memory_agent_slots() -> list[dict[str, Any]]:
    from evoflow.persistence.memory_repositories import agent_keys_with_memory_content
    
    try:
        content_keys = agent_keys_with_memory_content()
    except Exception:
        ...
        content_keys = set()

# ✅ 新版本
def list_memory_agent_slots() -> list[dict[str, Any]]:
    """List memory scopes for UI: global + each Agent + Workspace (from mem_* atoms)."""
    from evoflow.config.agents_config import AGENT_NAME_PATTERN, list_all_agents, load_agent_config
    from evoflow.memory.store import list_agents_with_memory  # 新位置
    
    try:
        content_keys = list_agents_with_memory()  # 改为直接查询 mem_*
    except Exception:
        logger.debug("list_memory_agent_slots: content_keys failed", exc_info=True)
        content_keys = set()
```

**更新文档注释**：
```python
# ❌ 旧注释
"""
``has_memory_file`` means the agent has non-empty chat memory in
``evoflow_memory`` (facts or section summaries), not a legacy disk JSON.
"""

# ✅ 新注释
"""
``has_memory_file`` means the agent has non-empty chat memory atoms in
``mem_*`` tables (via owned.sqlite), not a legacy disk JSON.
"""
```

---

### 4. `backend/packages/harness/evoflow/memory/migrate_legacy.py`

**选项 A：删除整文件**（推荐）
- 迁移已完成，新数据库无需此文件
- 旧数据库用户可通过其他方式迁移（文档支持）

**选项 B：保留为弃用警告**（如需向后兼容）
```python
"""Legacy migration helper — deprecated. Use OwnedMemoryStorage directly.

This module is retained only for diagnostic purposes on extremely old databases.
New installations and normal upgrades use mem_* tables directly.
"""

import warnings
import logging

logger = logging.getLogger(__name__)

def ensure_legacy_migrated() -> None:
    """Deprecated: no-op. Legacy migration is automatic via ensure_owned_migrated()."""
    warnings.warn(
        "ensure_legacy_migrated() is deprecated. "
        "Use evoflow.memory.migrate_owned.ensure_owned_migrated() instead.",
        DeprecationWarning,
        stacklevel=2
    )
```

---

### 5. `backend/packages/harness/evoflow/config/paths.py`

**删除**（约第 175-177 行）：
```python
# ❌ 删除
def memory_file(self) -> Path:
    """Legacy path hint; memory is stored in :attr:`evoflow_db` table ``evoflow_memory``."""
    return self.agent_memory_file("memory.json")
```

**如果有调用此方法的代码**：
```bash
rg "\.memory_file\(\)" --type py
```
（应该没有，因为已被 OwnedMemoryStorage 替代）

---

### 6. `backend/packages/harness/evoflow/agents/memory/storage.py`

**改进日志消息**（第 30 行）：

```python
# ❌ 旧版本
logger.info("Memory storage → OwnedMemoryStorage (legacy evoflow_memory retired)")

# ✅ 新版本
logger.info("Memory storage initialized: OwnedMemoryStorage (mem_* atoms on owned.sqlite)")
```

---

### 7. 其他可能的引用

**检查是否有其他 `memory_to_rows` / `rows_to_memory` 的调用**：
```bash
rg "memory_to_rows|rows_to_memory" --type py
```

预期结果：
- `backend/packages/harness/evoflow/persistence/memory_repositories.py` 定义（删除）
- `backend/packages/harness/evoflow/memory/migrate_legacy.py` 调用（删除或改）
- 无其他调用处

---

## 🧪 测试清单

### 单元测试
```bash
# 检查记忆 API 是否正常
cd backend
uv run pytest tests/ -k memory -v

# 特别验证：
# ✅ list_memory_agent_slots() 返回正确结果
# ✅ retrieve_for_query() 仍能检索
# ✅ insert_person_memory() 仍能写入
```

### 集成测试
```python
# 1. 验证新数据库无旧表
from evoflow.knowledge.owned.db import db

with db() as conn:
    try:
        conn.execute("SELECT * FROM evoflow_memory LIMIT 1")
        raise AssertionError("旧表不应该存在")
    except sqlite3.OperationalError:
        pass  # ✅ 预期

# 2. 验证所有记忆操作仍然正常
from evoflow.memory.facade import remember
from evoflow.memory.namespaces import user_ns

aid = remember(user_ns("default"), "test", layer="semantic")
assert aid is not None  # ✅

# 3. 验证 list_memory_agent_slots() 正常
from evoflow.agents.memory.updater import list_memory_agent_slots

slots = list_memory_agent_slots()
assert isinstance(slots, list)  # ✅
assert any(s["id"] is None for s in slots)  # ✅ 全局槽
```

### 向后兼容性检查
```bash
# 检查是否有生产用户仍依赖 memory_repositories API
# 预期：没有（已由资产中心替代）
rg "memory_repositories" --type py -l | grep -v "^backend/packages/harness/evoflow/persistence/memory_repositories.py"
```

---

## 📊 变更统计

```
删除行数：
  - schema.py: ~28 行
  - memory_repositories.py: ~198 行（整文件）
  - migrate_legacy.py: ~130 行（整文件）
  - config/paths.py: ~3 行
  
修改行数：
  - updater.py: ~8 行（导入 + 2 调用处）
  - storage.py: ~1 行（注释）
  - memory/store.py: ~30 行（新增函数）

总计：~359 行删除，~40 行修改/新增
```

---

## 🚀 发布说明

### 用户影响
- ✅ **无破坏性改动**（旧 API 已不在使用）
- ✅ **自动兼容**（mem_* 表已完全替代）
- ⚠️ **旧数据库**：第一次启动会自动迁移（如有残留数据）

### 升级步骤
1. **备份**：保存 `.evoflow/evoflow.db` 和 `.evoflow/owned.sqlite`
2. **升级**：安装新版本
3. **验证**：运行 `list_memory_agent_slots()` 检查是否正常
4. **完成**：旧表在下一次 GC 时自动清理（可选）

### 发布 Notes
```markdown
## 记忆系统清理

✅ 已删除不再使用的旧 `evoflow_memory*` 表
- 所有记忆操作已完全迁移到 `mem_*` 原子化存储
- 代码简化 ~360 行，性能提升（少一层转换）
- 无用户可见影响，升级完全透明

💡 如遇到旧数据库：运行 `python -m evoflow.memory.ensure_migrated_all` 进行一次性迁移
```

---

## ⚠️ 回滚计划

如需回滚到含旧表的版本：
```bash
# 1. 恢复代码到旧版本
git revert <commit-hash>

# 2. 删除 mem_* 表中的新原子（可选）
# 旧表和新表可并存，旧代码会优先读旧表

# 3. 重启应用
```

