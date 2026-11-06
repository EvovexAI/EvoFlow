# 资产注入审计：主智能体 vs 员工

## 📋 主智能体 (lead_agent/main) 注入了什么?

### 调用路径
1. `prompt.py:1502` → `build_memory_context_region()`
2. 调用 `build_session_asset_memory_block(agent_name=agent_name, principal_id=principal_id)`

### 注入的资产
```
build_session_asset_memory_block()
  ├─ resolve_memory_entity(agent_name=agent_name, principal_id=principal_id)
  │  → 返回用户实体 (USER)
  │
  ├─ build_entity_memory_injection(user_entity)
  │  ├─ User standing.md (名字索引)
  │  ├─ User catalog (facts, episodic, craft)
  │  └─ read_path_guidance (共享 procedure)
  │
  └─ build_agent_soul_injection_block(agent_name="lead_agent" or "")
     └─ lead_agent SOUL.md 摘要 (~400 chars)

结果: USER 资产 + LEAD_AGENT SOUL
```

---

## 📋 员工 (employee) 注入了什么?

### 调用路径
1. `assemble_employee_system_prompt()` → 最终调用
2. `build_employee_memory_policy_block(identity, memory_context=..., person_memory_context=...)`
3. `build_employee_memory_assets_block()` 只接受已构建的参数

### 问题 1️⃣ : memory_context 从何而来?

**在 assemble_employee_system_prompt 中没有调用 build_session_asset_memory_block**

```python
# ❌ 员工系统提示中
def assemble_employee_system_prompt(...):
    # 这里 memory_context 参数是调用者传入的
    # 不是内部构建的
    
    if mem_on:
        parts.append(
            build_employee_memory_policy_block(
                info,
                memory_context=memory_context,      # ← 从外部传入
                person_memory_context=person_memory_context,
                prompt_language=prompt_language,
            )
        )
```

**调用者需要预先构建 memory_context**：
```python
# 这应该在外部完成
memory_context = build_session_asset_memory_block(
    agent_name=None,  # 用户资产
    principal_id=principal_id,
    include_procedure=True,
)
```

### 问题 2️⃣ : 员工自己的身份/SOUL 资产缺失

**build_employee_identity_block 只生成基本信息**：
```python
def build_employee_identity_block(...) -> str:
    """Just: 你是「name」（code=...），所属 dept。"""
    who = f"你是「{name}」（agent_code=`{code}`）"
    return f"<identity>\n{who}\n</identity>"
```

**缺少**：
- ❌ 员工 SOUL.md (profile/SOUL.md)
- ❌ 员工 identity.md (profile/identity.md)
- ❌ 员工 affect.md (profile/affect.md)

**对比主智能体**：
```python
# ✅ 主智能体有
build_agent_soul_injection_block(agent_name=agent_name)
  └─ 读取 assets/agents/lead_agent/profile/soul-summary.md
```

### 问题 3️⃣ : 员工自己的 profile 缺失

**session.py 只注入全局 USER.md**：
```python
if include_user_profile:
    profile = build_user_profile_injection_block(
        prompt_language=prompt_language,
        scope="full",
    ).strip()
    # ↑ 这只是全局 USER.md，没有员工自己的 profile
```

**缺少**：
- ❌ 员工的 profile/USER.md（如果有的话）
- ❌ 员工的 profile/affect.md

---

## 🎯 完整对比

| 资产类型 | 主智能体 (lead_agent) | 员工 (employee) | 状态 |
|---------|-------------------|---------------|------|
| 用户 standing | ✅ 注入 | ✅ 通过 memory_context | OK |
| 用户 catalog | ✅ 注入 | ✅ 通过 memory_context | OK |
| 用户 SOUL | ❌ N/A (lead_agent 是内置) | ✅ 通过 memory_context | OK |
| 用户 profile/USER.md | ✅ 通过 memory_context | ✅ 通过 session | OK |
| 用户 profile/affect.md | ✅ 通过 memory_context | ✅ 通过 memory_assets | OK |
| **员工 SOUL/identity** | ❌ N/A | ❌ **缺失** | ⚠️ 问题 |
| **员工 profile/affect** | ❌ N/A | ❌ **缺失** | ⚠️ 问题 |
| **员工 profile/USER** | ❌ N/A | ❌ **缺失** | ⚠️ 问题 |
| 员工 craft/person | ✅ 通过 person_memory_context | ✅ 通过 person_memory_context | OK |

---

## 🔴 核心问题总结

### 问题 A: 员工缺少自己的人格资产

员工（如小微、其他 Agent）应该有自己的：
- `assets/employees/<code>/profile/SOUL.md` - 人格/目标
- `assets/employees/<code>/profile/affect.md` - 情感/风格
- `assets/employees/<code>/profile/identity.md` - 身份细节

但系统提示中**没有注入这些**，只有硬编码的一句话：
```
"你是「小微」（agent_code=`xiaomi`），所属 xxx。"
```

### 问题 B: memory_context 需要调用者预处理

员工系统提示**不主动构建** `memory_context`，需要调用者提供。

查看调用处：
```bash
rg "assemble_employee_system_prompt\(" --type py | head -10
```

看看谁在调用，是否都传了 memory_context。

### 问题 C: 不对称性

**主智能体**：内部自动注入所有资产（standing + catalog + profile + soul）

**员工**：需要外部传入 memory_context，还缺自己的 soul/profile

---

## 🛠️ 建议改进

### 改进 1: 员工也应该注入自己的资产

```python
def build_session_asset_memory_block(...):
    # ... 现有代码 ...
    
    # 新增：如果是员工，也注入员工自己的 SOUL
    if is_employee_agent_name(agent_name):
        employee_soul = build_agent_soul_injection_block(agent_name=agent_name)
        if employee_soul:
            parts.append(employee_soul)
    
    return "\n\n".join(parts)
```

### 改进 2: 员工系统提示主动构建 memory_context

```python
def assemble_employee_system_prompt(..., memory_context: str = ""):
    # 如果没有提供，内部构建
    if not memory_context and mem_on:
        from evoflow.assets.guidance import build_session_asset_memory_block
        memory_context = build_session_asset_memory_block(
            agent_name=None,  # 用户资产
            principal_id=identity.get("principal_id", ""),
        )
```

### 改进 3: 员工资产架构完善

建议员工也遵循与主智能体相同的资产结构：
```
assets/employees/<code>/
├── profile/
│   ├── SOUL.md          (新增)
│   ├── identity.md      (新增)
│   ├── affect.md        (新增)
│   └── ...
├── memory/
│   ├── standing.md      (现有)
│   ├── MEMORY.md        (现有)
│   └── ...
└── craft/
    └── ...              (现有)
```

---

## 🔍 实际验证结果

### 调用处分析

**proactive/prompt.py:110-115**：
```python
def build_system_prompt(role: ProactiveRole, *, roster=None, query=""):
    """Duty system prompt"""
    return assemble_employee_system_prompt(
        mode="duty",
        role=role,
        roster=roster,
        query=query,
        # ❌ 没有传 memory_context
        # ❌ 没有传 person_memory_context
        # ❌ 没有传 user_profile_block
    )
```

### 关键发现

**✅ duty 模式下**：
- 员工 standing/memory 通过 `build_duty_resources_block()` 注入
- 但是 **用户资产缺失**（没有 memory_context）

**❓ chat 模式下**：
- 需要查看谁调用 `assemble_employee_system_prompt(mode="chat", ...)`
- 这个调用链在 lead_agent 中

### 最终问题清单

1. **Duty mode 中用户资产缺失**
   - ❌ 用户 standing.md 未注入
   - ❌ 用户 SOUL 未注入
   - ❌ 用户 profile/affect.md 未注入

2. **所有模式下员工自己的身份/SOUL 缺失**
   - ❌ 员工 SOUL.md 未注入（只有硬编码一句话）
   - ❌ 员工 profile/affect.md 未注入

3. **不对称性**
   - 主智能体：完整注入用户资产
   - 员工：缺失用户资产 + 缺失自己的人格资产

