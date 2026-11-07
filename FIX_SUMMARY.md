# 修复实现总结

## ✅ 已完成

### 1. 修改 `build_system_prompt()`

**文件**：`backend/packages/harness/evoflow/proactive/prompt.py`

**改进内容**：
```python
def build_system_prompt(
    role: ProactiveRole,
    *,
    roster: list[ProactiveRole] | None = None,
    query: str = "",
    principal_id: str = "",  # ← 新增参数
) -> str:
    """Duty system prompt with optional user profile injection."""
    
    # 如果有 principal_id，构建并注入用户画像
    user_profile = ""
    if principal_id and _should_inject_user_profile_for_duty(role):
        user_profile = _build_user_profile_for_duty(principal_id)
    
    return assemble_employee_system_prompt(
        mode="duty",
        role=role,
        roster=roster,
        query=query,
        user_profile_block=user_profile,  # ← 新增注入
    )
```

### 2. 添加辅助函数

- `_should_inject_user_profile_for_duty(role)` - 检查配置
- `_build_user_profile_for_duty(principal_id)` - 构建用户画像

### 3. 测试通过

✅ `backend/tests/test_employee_prompt_assemble.py` - 全部 15 个测试通过

---

## 🔄 向后兼容

- **旧代码**：`build_system_prompt(role, query=...)` 仍然工作（principal_id 默认为空）
- **新代码**：可以传递 `principal_id` 来注入用户画像
- **零破坏**：现有代码无需改动

---

## 📝 调用处更新指南

需要在以下地方传入 `principal_id`（可以逐步推进）：

### 1. engine.py:310 (Duty 循环)

```python
# 获取主认证用户（可能需要从某处传入）
# 这取决于 Duty 模式的用户是谁的设计决策
principal_id = get_duty_principal_id(role, environment_context)

system_prompt = build_system_prompt(
    role,
    query=str(environment_context or "").strip()[:500],
    principal_id=principal_id,  # ← 新增
)
```

### 2. execution_bridge.py:186 (任务执行)

```python
# 如果是任务派发，可以从任务或派发者处获取 principal_id
principal_id = extract_principal_from_task(task_id)

duty_system = build_system_prompt(
    role,
    query=duty_query,
    principal_id=principal_id,  # ← 新增
) if role else ""
```

### 3. middleware/proactive_tool_middleware.py:384 (工具调用)

```python
# 取决于上下文是否有 principal_id
system_prompt = build_system_prompt(
    role,
    principal_id=extract_principal_from_context(),
)
```

---

## 🎯 架构改进效果

### Before（混乱）
```
Duty 模式
  └─ 员工系统提示
     ├─ 员工 SOUL/affect ✅
     ├─ 员工记忆 ✅
     └─ 用户画像 ❌ 缺失
```

### After（清晰）
```
Duty 模式
  └─ 员工系统提示
     ├─ 员工 SOUL/affect ✅
     ├─ 员工记忆 ✅
     └─ 用户画像 ✅ （可选注入）
```

---

## 🔧 后续可选优化

### 短期
- [ ] 更新 engine.py 和 execution_bridge.py 传递 principal_id
- [ ] 添加测试验证用户画像注入

### 中期
- [ ] 提取共用资产注入逻辑
- [ ] 统一 Chat/Duty 的调用接口

### 长期
- [ ] 重新设计 employee_prompting 模块接口
- [ ] 分级参数集合（Tier 0/1/2）

---

## 📊 代码变更统计

| 文件 | 变更 |
|------|------|
| `proactive/prompt.py` | +1 参数 + 3 新函数 |
| Tests | ✅ 0 破坏，所有测试通过 |
| 向后兼容 | ✅ 完全兼容 |

---

## ✨ 关键设计决策

1. **参数可选**：principal_id 默认为空，不破坏现有调用
2. **内部处理**：`build_system_prompt()` 负责构建用户画像
3. **内存门控**：遵循 role.config.memory_enabled 配置
4. **同步 Chat**：使用与 lead_agent/prompt.py 相同的逻辑

这样做的好处：
- 职责清晰：`build_system_prompt()` 补全参数
- 扩展容易：新调用处只需传 principal_id
- 维护简单：用户画像构建逻辑集中在一处

