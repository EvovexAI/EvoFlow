# 资产注入审计：主智能体 vs 员工（修正版）

## ✅ 更正：员工确实有自己的个性资产

感谢纠正！员工**确实**有自己的个性资产，存储位置：

| 资产类型 | 存储路径 | 读取函数 | 说明 |
|---------|--------|--------|------|
| 员工 SOUL | `assets/employees/<code>/profile/SOUL.md` | `load_agent_soul(code)` | 员工人格特征 |
| 员工 affect | `assets/employees/<code>/profile/affect.md` | `format_affect_brief(agent_code=code)` | 员工心境/情感 |
| 员工 identity | `assets/employees/<code>/profile/identity.md` | `load_agent_identity(code)` | 员工身份细节 |
| 用户 affect | `profile/affect.md` | `format_affect_brief(principal_id=uid)` | 用户心境（对比） |

这些都是员工**自己的**资产，不是用户的。

---

## 🔍 实际注入流程

### 主智能体（lead_agent/main）

**调用链**：`prompt.py:1502` → `build_memory_context_region()`

```python
asset_block = build_session_asset_memory_block(
    agent_name=None,  # ← None 表示用户
    principal_id=user_id,
)

# 内部注入：
# 1. resolve_memory_entity(agent_name=None) → 用户实体
# 2. build_entity_memory_injection(user_entity) → 用户 standing + catalog
# 3. build_agent_soul_injection_block(agent_name=None) → lead_agent SOUL + 用户 affect
```

**注入内容**：用户 standing/catalog/affect + lead_agent SOUL

---

### 员工系统提示（duty/chat）

**调用链**：`assemble_employee_system_prompt()`

```python
# 第一步：员工 SOUL（来自 agents/<code>/config 或 profile/SOUL.md）
job_soul, job_sp = _resolve_job_sources(duty_role, soul=soul, ...)
# → 内含员工的 SOUL 文本

# 第二步：内存区域（memory_assets）
if mem_on:
    parts.append(
        build_employee_memory_policy_block(
            info,
            memory_context=memory_context,         # ← 用户资产
            person_memory_context=person_memory_context,  # ← 员工自己
        )
    )

# 第三步：心境块（affect）- 第 273 行
if mem_on:
    code = str(info.get("code"))
    affect_blk = get_agent_affect_block(code)  # ← 读取 profile/affect.md
    if affect_blk:
        parts.append(affect_blk)
```

**注入内容**：
- ✅ 员工 SOUL（来自 job_soul）
- ✅ 员工 affect（通过 get_agent_affect_block）
- ✅ 员工记忆（person_memory_context）
- ? 用户资产（memory_context 内容取决于调用者）

---

## ⚠️ 真实问题：不对称性

### 对比表

| 资产类型 | 主智能体 | 员工 | 说明 |
|---------|--------|------|------|
| **自己的 SOUL** | ✅ lead_agent SOUL | ✅ 员工 SOUL | 双方都有 |
| **自己的 affect** | ✅ 用户 affect（因为是用户视角） | ✅ 员工 affect | 双方都有 |
| **用户的 standing** | ✅ 用户 standing | ❓ 需要 memory_context | 不对称 |
| **用户的 catalog** | ✅ 用户 catalog | ❓ 需要 memory_context | 不对称 |
| **用户的 profile/affect** | ✅ 用户 profile | ❓ 需要 memory_context | 不对称 |

### 核心不对称性

**主智能体看到的是用户视角**：
```
「我是 lead_agent」
- 用户的 standing（长期记忆）
- 用户的 preferences（偏好）
- 用户的 affect（心境）
- lead_agent 的 SOUL（我是谁）
```

**员工看到的是员工视角**：
```
「我是 xiaomi（小微）」
- 员工的 SOUL（我是谁）
- 员工的 affect（我的心境）
- 员工的记忆（我记得什么）
- 用户的资产？ ← 取决于调用者是否传 memory_context
```

---

## 🔴 问题清单

### 问题 1️⃣ : Duty 模式中用户资产缺失

**proactive/prompt.py:110**：
```python
def build_system_prompt(role: ProactiveRole, *, roster=None, query=""):
    """Duty system prompt"""
    return assemble_employee_system_prompt(
        mode="duty",
        role=role,
        roster=roster,
        query=query,
        # ❌ memory_context 未传入 → 员工看不到用户的 standing
        # ❌ user_profile_block 未传入 → 员工看不到用户的 profile
    )
```

**结果**：员工在值班时，不知道用户的状态和偏好

### 问题 2️⃣ : Chat 模式需要验证

需要查看 lead_agent 中员工聊天时是否传了 memory_context。

**关键代码**（prompt.py:2309-2359）：
```python
if employee_ok and emp_identity is not None:
    prompt = assemble_employee_system_prompt(
        mode="chat",
        role=emp_role,
        skills_section=...,
        memory_context=...,         # ← 这里有传吗？
        person_memory_context=...,
        user_profile_block=...,     # ← 这里有传吗？
    )
```

### 问题 3️⃣ : 设计意图不清

是否应该让员工在 duty 模式下也看到用户的上下文？

- **不应该**（隔离设计）：员工值班只关注自己的任务，不需要了解用户
- **应该**（协作设计）：员工需要知道用户的状态才能做出更好的决策

---

## 🎯 问题深度分析

### 为什么 Duty 模式缺 memory_context？

1. **build_system_prompt 是 proactive/prompt.py 的接口**
   - 只接收 role / roster / query
   - 不知道当前用户是谁（principal_id）
   - 无法构建 memory_context

2. **调用处无法获取用户信息**
   - Duty 是后台值班模式
   - 没有当前对话的用户 context
   - 无法自动补充

3. **设计决策**
   - 可能是有意的：值班模式只关注工作，不需要用户 context
   - 或者是遗漏：应该在某个地方传入用户信息

---

## ✅ 理想状态 vs 现实

### 理想状态（对称）

```
主智能体：用户 standing/preferences/affect + lead_agent SOUL
员工：用户 standing/preferences/affect + 员工 SOUL/affect
```

→ 双方都能看到用户的完整背景

### 现实状态

```
主智能体：用户 standing/preferences/affect + lead_agent SOUL ✅
员工 (duty)：员工 SOUL/affect/记忆 ❌ 缺用户背景
员工 (chat)：员工 SOUL/affect/记忆 + ？用户背景（取决于调用处）
```

---

## 🤔 需要你确认的问题

1. **设计意图**：员工在 duty 模式下应该看到用户资产吗？

2. **Chat 模式**：员工聊天时是否传了 memory_context？
   - 如果是，那就已经对称了
   - 如果否，那也需要补充

3. **改进建议**：
   - **方案 A**（保持现状）：Duty 模式不需要用户背景
   - **方案 B**（补充用户背景）：Duty 模式也应该注入用户上下文
   - **方案 C**（标准化）：统一员工和主智能体的资产注入流程

---

## 📝 总结

员工**确实**有自己的个性资产（SOUL/affect/identity），这不是问题。

真正的问题是：**员工在某些模式下看不到用户的上下文**，导致决策不够充分。这个设计是有意的还是遗漏？

