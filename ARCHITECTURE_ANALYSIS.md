# 架构混乱分析与修复计划

## 🔴 现状：三层复杂的调用链

### 第 1 层：公共入口（engine.py, execution_bridge.py）
```
engine.py:310 / execution_bridge.py:186
  ↓
build_system_prompt(role, query, roster)  ← proactive/prompt.py
```

### 第 2 层：薄包装（prompt.py）
```
build_system_prompt()
  └─ assemble_employee_system_prompt(mode="duty", role, roster, query)
     ↑
     └─ proactive/employee_prompting/assemble.py
```

### 第 3 层：真实实现（assemble.py）
```
assemble_employee_system_prompt()
  ├─ build_employee_identity_block()
  ├─ build_employee_job_block()
  ├─ build_employee_memory_policy_block()
  │  ├─ memory_context      ← ❌ 从未传入（本应来自外部）
  │  ├─ person_memory_context
  │  └─ user_profile_block  ← ❌ 从未传入（本应来自外部）
  ├─ build_duty_resources_block()
  └─ get_agent_affect_block()
```

---

## 🎯 混乱的根本原因

### 问题 1️⃣ : 两个入口，参数集合不同

**入口 A**：`build_system_prompt(role, roster, query)`
- 简化版本（仅 Duty 模式）
- 参数少，无法传用户信息

**入口 B**：`assemble_employee_system_prompt(...20+ params)`
- 完整版本（支持 Chat + Duty）
- 参数多，支持所有资产注入

**结果**：
- Chat 用完整版本（lead_agent/prompt.py:2359）
- Duty 用简化版本（engine.py:310）
- 无法统一

### 问题 2️⃣ : Duty 调用链缺少用户上下文

```
engine.py:310
  build_system_prompt(role, query)
    └─ assemble_employee_system_prompt(mode="duty", ...)
       ├─ memory_context="" ← 从未构建
       └─ user_profile_block="" ← 从未构建
```

**为什么缺少？**
- `build_system_prompt()` 接收的参数不足
- 无法获取 principal_id（用户 ID）
- 无法构建 user_profile_block

### 问题 3️⃣ : 职责不清

- `assemble_employee_system_prompt()` 是**被动的**
  - 接收所有参数
  - 只负责组装
  - 不负责获取资产

- `build_system_prompt()` 是**传送带**
  - 仅转发参数
  - 不做真实工作
  - 不获取缺失资产

**谁应该负责获取用户画像？**
- ❌ assemble：不知道怎么获取
- ❌ build_system_prompt：没有能力获取
- ✅ engine/execution_bridge：有上下文，应该负责

---

## 🛠️ 修复方案

### 方案一：改进 build_system_prompt()（推荐）

```python
# proactive/prompt.py:105
def build_system_prompt(
    role: ProactiveRole,
    *,
    roster: list[ProactiveRole] | None = None,
    query: str = "",
    principal_id: str = "",  # ← 新增
) -> str:
    """Duty system prompt — with optional user profile injection."""
    
    # 获取用户画像（如果需要且有用户）
    user_profile = ""
    if principal_id and _should_inject_user_profile(role):
        user_profile = _build_user_profile_for_duty(principal_id)
    
    return assemble_employee_system_prompt(
        mode="duty",
        role=role,
        roster=roster,
        query=query,
        user_profile_block=user_profile,  # ← 新增传入
    )


def _should_inject_user_profile(role: ProactiveRole) -> bool:
    """判断是否应该注入用户画像（基于配置）。"""
    return getattr(role.config, "memory_enabled", True)


def _build_user_profile_for_duty(principal_id: str) -> str:
    """构建用户画像（复用 lead_agent 中的逻辑）。"""
    try:
        from evoflow.assets.paths import EntityRef, sanitize_user_asset_id
        from evoflow.assets.profile_injection import build_user_profile_injection_block
        
        user_ent = EntityRef(
            "user",
            sanitize_user_asset_id(principal_id)
        ).normalized()
        
        return build_user_profile_injection_block(
            entity=user_ent,
            scope="full",
        ).strip()
    except Exception:
        return ""
```

### 方案二：更新调用处（engine.py, execution_bridge.py）

需要把 principal_id 传下去：

```python
# engine.py:310（需要找到当前用户）
principal_id = get_current_principal_id()  # 需要实现
system_prompt = build_system_prompt(
    role,
    query=str(environment_context or "").strip()[:500],
    principal_id=principal_id,  # ← 新增
)

# execution_bridge.py:186
principal_id = get_duty_principal_id(duty_session)  # 需要实现
duty_system = build_system_prompt(
    role,
    query=duty_query,
    principal_id=principal_id,  # ← 新增
) if role else ""
```

---

## 📊 改进后的架构

### Before（混乱）
```
engine.py / execution_bridge.py
  ↓ (无用户信息)
build_system_prompt(role, query)
  ↓ (转发)
assemble_employee_system_prompt(mode="duty", ..., user_profile_block="")
  ↓ (缺少用户)
员工系统提示 ← 不知道用户是谁 ❌
```

### After（清晰）
```
engine.py / execution_bridge.py (有 principal_id)
  ↓ (获取用户画像)
build_system_prompt(role, query, principal_id)
  ├─ _build_user_profile_for_duty(principal_id) ← 构建用户画像
  └─ assemble_employee_system_prompt(..., user_profile_block)
     ↓
员工系统提示 ← 知道用户是谁 ✅
```

---

## 🔧 为什么这样做能减轻混乱

1. **职责清晰**
   - `build_system_prompt()` 负责参数补全（获取用户画像）
   - `assemble_employee_system_prompt()` 仅负责组装
   - 调用处只负责提供基础信息（role, query, principal_id）

2. **参数对称**
   - Chat 和 Duty 的调用都能提供 user_profile_block
   - 不再有"简化版"和"完整版"的差异
   - 都通过 assemble_employee_system_prompt() 统一实现

3. **易维护**
   - 修改用户画像逻辑只需改 `_build_user_profile_for_duty()`
   - 不需要在 lead_agent/prompt.py 和 proactive/prompt.py 间重复代码

---

## 📝 后续改进方向

### 短期（本次修复）
✅ Duty 模式补充用户画像

### 中期
- [ ] 合并 Chat/Duty 的调用接口
- [ ] 提取共用的资产注入逻辑到 `employee_prompting/guidance.py`

### 长期
- [ ] 重新设计 employee_prompting 接口
  - Tier 0：最少参数（role, query）
  - Tier 1：完整参数（+user_profile）
  - Tier 2：扩展参数（+user_memory）

