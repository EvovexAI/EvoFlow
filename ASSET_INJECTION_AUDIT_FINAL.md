# 资产注入审计最终版：真实问题

## ✅ 理解修正

员工应该同时拥有：
1. **员工自己的身份**：SOUL/affect/solo（我是谁、我的性格、我的情感）
2. **用户的画像**：profile/USER.md、standing.md、preferences（用户是谁、用户的状态）

这样员工才能做出**以用户为中心**的决策。

---

## 🔴 真实问题：Chat vs Duty 的不对称性

### Chat 模式（员工和用户聊天）✅ 正确

**调用链**：lead_agent/prompt.py:2359-2379

员工注入了完整资产：

```python
prompt = assemble_employee_system_prompt(
    mode="chat",
    identity=emp_identity,
    soul=emp_soul,                    # ✅ 员工 SOUL
    memory_context=memory_context,    # ✅ 用户 standing/memories
    person_memory_context=emp_person_memory,  # ✅ 员工自己的记忆
    user_profile_block=emp_user_profile,      # ✅ 用户的画像
    include_memory=include_memory,
)
```

**最终注入内容**：
```
员工系统提示 =
  ✅ 员工 SOUL（我是谁、我的性格）
  ✅ 用户 profile（用户是谁、用户的性格）
  ✅ 用户 standing（用户当前状态）
  ✅ 用户 memories（用户记忆）
  ✅ 员工记忆（我的工作记忆）
  ✅ 员工 affect（我的心境）
```

### Duty 模式（员工值班）❌ 缺少用户画像

**调用链**：proactive/prompt.py:105-115

员工**只注入了自己的资产**，缺少用户：

```python
def build_system_prompt(role, roster=None, query=""):
    return assemble_employee_system_prompt(
        mode="duty",
        role=role,
        roster=roster,
        query=query,
        # ❌ memory_context 未传
        # ❌ user_profile_block 未传
        # ❌ 其他用户资产都未传
    )
```

**最终注入内容**：
```
员工系统提示 =
  ✅ 员工 SOUL（我是谁、我的性格）
  ✅ 员工记忆（我的工作记忆）
  ✅ 员工 affect（我的心境）
  ❌ 用户 profile（用户是谁）← 缺失
  ❌ 用户 standing（用户状态）← 缺失
  ❌ 用户 memories（用户记忆）← 缺失
```

---

## 📊 对比表

| 资产 | Chat 模式 | Duty 模式 |
|------|----------|----------|
| **员工 SOUL** | ✅ soul 参数 | ✅ role.soul |
| **员工 affect** | ✅ get_agent_affect_block | ✅ get_agent_affect_block |
| **员工记忆** | ✅ person_memory_context | ✅ person_memory_context |
| **用户 profile** | ✅ user_profile_block | ❌ **缺失** |
| **用户 standing** | ✅ memory_context | ❌ **缺失** |
| **用户记忆** | ✅ memory_context | ❌ **缺失** |

---

## 🎯 核心问题

### 问题 1️⃣ : Duty 模式缺少用户画像

员工在值班时**不知道用户是谁、用户的性格偏好、用户的状态**，只能基于：
- 员工自己的设定
- 待办任务的描述
- 过往交互记录

**无法做出用户中心的决策**。

### 问题 2️⃣ : 为什么 Chat 有而 Duty 没有？

**Chat 模式调用处**（lead_agent/prompt.py:2359）：
- 有主认证用户 principal_id
- 可以构建 user_profile_block
- 知道用户是谁

**Duty 模式调用处**（proactive/prompt.py:105）：
- 无用户信息（只知道员工角色）
- 无法获取 principal_id
- 不知道应该展示谁的用户画像

---

## ✅ 这是设计缺陷还是有意？

### 可能的解释

**A) 有意设计**：
- Duty 是后台值班，不涉及用户
- 只需关注自己的任务、待办、记忆
- 用户信息可能无关

**B) 设计缺陷**：
- Duty 也应该了解用户背景
- 值班员工可能需要为用户做决策
- 缺少用户信息导致决策质量低

---

## 🛠️ 修复方案

### 方案 A：在 Duty 模式中补充用户资产

需要确定员工值班时的"用户"是谁：
- 系统全局用户？
- 当前认证用户？
- 派发任务的用户？

```python
def build_system_prompt(
    role: ProactiveRole, 
    *, 
    roster=None, 
    query="",
    principal_id="",  # ← 新增：用户 ID
):
    # 构建用户资产
    user_memory = ""
    user_profile = ""
    if principal_id:
        user_memory = build_session_asset_memory_block(
            agent_name=None,
            principal_id=principal_id,
        )
        user_profile = build_user_profile_injection_block(
            entity=EntityRef("user", sanitize_user_asset_id(principal_id))
        )
    
    return assemble_employee_system_prompt(
        mode="duty",
        role=role,
        roster=roster,
        query=query,
        memory_context=user_memory,    # ← 新增
        user_profile_block=user_profile,  # ← 新增
    )
```

### 方案 B：保持现状

Duty 模式确实不需要用户画像，只需关注工作本身。

---

## 📝 总结

**真实问题**：
- Chat 模式：✅ 员工有自己的身份 + 用户的画像 → 对称、完整
- Duty 模式：❌ 员工有自己的身份 - 用户的画像 → 缺失用户背景

**影响**：
- Chat：员工可以进行用户中心的对话
- Duty：员工只能进行任务中心的值班（可能无法考虑用户背景）

**需要决定**：这个不对称是有意的吗？

