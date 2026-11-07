# 资产注入审计 - 正确版本

## ✅ 正确理解：员工需要什么

员工需要的资产三层次：

### 1️⃣ 员工自己的身份
- ✅ SOUL.md（我是谁、我的性格）
- ✅ affect（我的心境）
- ✅ identity（我的身份细节）

### 2️⃣ 员工自己的记忆
- ✅ person_memory_context（我记得什么）
- ✅ craft（我学会了什么）

### 3️⃣ 用户的画像（仅此而已）
- ✅ profile/USER.md（用户是谁、用户的性格/风格/喜好）

---

## ❌ 员工不需要

- ❌ 用户的长期记忆（standing.md）
  - 为什么：员工有自己的记忆系统
  - 员工会通过互动自己记录和学习用户

- ❌ 用户的 catalog/facts
  - 无关

- ❌ 用户的历史记录
  - 员工独立学习和互动

**理由**：员工和用户的关系是**独立的、互相学习的**，而不是"接管用户的上下文"。

---

## 🔴 真实问题：Duty 模式缺少用户画像

### Chat 模式 ✅ 正确

```python
# lead_agent/prompt.py:2340
emp_user_profile = build_user_profile_injection_block(
    entity=_emp_profile_ent,  # ✅ 用户的 profile
).strip()

prompt = assemble_employee_system_prompt(
    mode="chat",
    user_profile_block=emp_user_profile,  # ✅ 注入用户画像
)
```

### Duty 模式 ❌ 缺少用户画像

```python
# proactive/prompt.py:105
def build_system_prompt(role, roster=None, query=""):
    return assemble_employee_system_prompt(
        mode="duty",
        role=role,
        # ❌ user_profile_block 缺失
        # ❌ 没有用户画像信息
    )
```

---

## 📊 对比表

| 资产 | Chat 模式 | Duty 模式 | 说明 |
|------|----------|----------|------|
| 员工 SOUL | ✅ | ✅ | 员工本人定义 |
| 员工 affect | ✅ | ✅ | 员工实时心境 |
| 员工记忆 | ✅ | ✅ | 员工自己学到的 |
| **用户画像** | ✅ | ❌ **缺失** | **关键缺失** |
| ~~用户长期记忆~~ | ❌ | ❌ | 不需要 |
| ~~用户历史记录~~ | ❌ | ❌ | 不需要 |

---

## 🎯 核心缺陷

**问题**：Duty 模式的员工不知道用户是谁
- ❌ 不知道用户的性格/风格
- ❌ 不知道用户的偏好
- ❌ 不知道用户的背景

**后果**：员工无法快速建立和用户的理解，每次互动都是从零开始

**修复**：在 Duty 模式中注入**用户的 profile**（仅此而已）

---

## 🛠️ 修复方案

```python
def build_system_prompt(
    role: ProactiveRole,
    *,
    roster=None,
    query="",
    principal_id="",  # ← 新增：获取用户 profile
):
    """Duty system prompt"""
    user_profile = ""
    
    # 获取用户画像
    if principal_id and role.config.memory_enabled:
        try:
            from evoflow.assets.paths import EntityRef, sanitize_user_asset_id
            from evoflow.assets.profile_injection import build_user_profile_injection_block
            
            user_ent = EntityRef("user", sanitize_user_asset_id(principal_id)).normalized()
            user_profile = build_user_profile_injection_block(
                entity=user_ent,
                scope="full",
            ).strip()
        except Exception:
            pass
    
    return assemble_employee_system_prompt(
        mode="duty",
        role=role,
        roster=roster,
        query=query,
        user_profile_block=user_profile,  # ← 注入用户画像
    )
```

---

## 📝 总结

| 场景 | 员工有什么 | 缺什么 | 影响 |
|------|----------|-------|------|
| Chat | 自己 + 用户画像 | 无 | ✅ 正常工作 |
| Duty | 自己 | **用户画像** | ❌ 无法理解用户 |

**必要改进**：Duty 模式补充**用户画像注入**。

