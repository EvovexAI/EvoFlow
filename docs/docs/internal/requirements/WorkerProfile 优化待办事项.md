# WorkerProfile 优化待办事项

## 📋 问题分析

### 当前设计

目前 `WorkerProfile` 存储在每个子任务中，包含：

```python
class WorkerProfile(BaseModel):
    base_subagent: str | None      # 子智能体模板名
    tools: list[str] | None        # 工具白名单
    skills: list[str] | None       # 技能白名单
    instruction: str | None        # 附加系统指令
    depends_on: list[str] | None   # 依赖的子任务 ID
```

### 问题

1. **数据冗余**：`tools` 和 `skills` 在 `AgentConfig` 中已经定义，又在 `WorkerProfile` 中重复存储
2. **一致性风险**：如果修改了智能体配置，已创建的子任务不会自动更新
3. **存储浪费**：每个子任务都复制一份 tools/skills

### 优化方向

**方案 A：完全引用（推荐）**
- `WorkerProfile` 只存 `base_subagent` 和 `instruction`
- `tools` 和 `skills` 直接从 `AgentConfig` 读取
- 优点：数据一致、无冗余、易维护
- 缺点：需要实时读取智能体配置

**方案 B：混合模式**
- `WorkerProfile` 可以覆盖 `tools` 和 `skills`
- 如果不设置，默认从 `AgentConfig` 继承
- 优点：灵活性高，可以针对特定任务调整
- 缺点：仍有部分冗余

**方案 C：保持现状**
- 所有配置都在 `WorkerProfile` 中
- 优点：简单直接，性能最好
- 缺点：数据冗余，一致性风险

---

## ✅ 推荐方案：方案 A（完全引用）

### 修改后的 WorkerProfile

```python
class WorkerProfile(BaseModel):
    base_subagent: str              # 子智能体模板名（必填）
    instruction: str | None = None  # 附加系统指令（可选）
    depends_on: list[str] = []      # 依赖关系
    # tools 和 skills 不再存储，从 AgentConfig 读取
```

### 修改后的 AgentConfig

```python
class AgentConfig(BaseModel):
    name: str
    description: str
    agent_type: Literal["custom", "subagent", "acp"]
    
    # Subagent 特有字段
    system_prompt: str | None = None
    tools: list[str] = []           # 默认工具列表
    skills: list[str] = []          # 默认技能列表
    disallowed_tools: list[str] = []
    max_turns: int = 50
    timeout_seconds: int = 900
```

### 使用流程

```python
# 1. Lead Agent 规划时
supervisor(
    action="create_subtask",
    task_id="task_001",
    name="前端开发",
    worker_profile={
        "base_subagent": "general-purpose",
        "instruction": "你是一位前端专家...",
        "depends_on": []
        # 不再需要 tools 和 skills
    }
)

# 2. Task Tool 执行时
def task_tool(...):
    # 读取 WorkerProfile
    worker_profile = task.worker_profile
    
    # 从 AgentConfig 加载 tools 和 skills
    agent_config = get_subagent_config(worker_profile.base_subagent)
    allowed_tools = agent_config.tools
    allowed_skills = agent_config.skills
    
    # 应用 WorkerProfile 的 instruction 覆盖
    if worker_profile.instruction:
        system_prompt = worker_profile.instruction
    else:
        system_prompt = agent_config.system_prompt
```

---

## 📝 待办事项清单

### 阶段 1：数据模型修改

- [ ] **修改 `WorkerProfile` 类**
  - 文件：`backend/packages/harness/evoflow/collab/models.py`
  - 移除 `tools` 字段（或设为可选，默认 None）
  - 移除 `skills` 字段（或设为可选，默认 None）
  - 使 `base_subagent` 必填
  - 更新 `to_storage_dict()` 方法

- [ ] **更新 `AgentConfig` 类**
  - 文件：`backend/packages/harness/evoflow/config/agents_config.py`
  - 确保 `tools` 和 `skills` 有默认值（空列表）
  - 添加验证：subagent 类型必须有 `system_prompt`

- [ ] **更新 `create_empty_task` 函数**
  - 文件：`backend/packages/harness/evoflow/collab/storage.py`
  - 更新默认的 `worker_profile` 结构

### 阶段 2：Task Tool 修改

- [ ] **修改 `task_tool` 加载逻辑**
  - 文件：`backend/packages/harness/evoflow/tools/builtins/task_tool.py`
  - 在加载 `WorkerProfile` 后，从 `AgentConfig` 读取 `tools` 和 `skills`
  - 应用 `WorkerProfile.instruction` 覆盖（如果有）
  - 更新日志输出

- [ ] **添加工具/技能合并逻辑**
  ```python
  # 伪代码
  agent_config = get_subagent_config(worker_profile.base_subagent)
  
  # 默认使用 AgentConfig 的配置
  allowed_tools = agent_config.tools or []
  allowed_skills = agent_config.skills or []
  
  # 如果 WorkerProfile 有覆盖（向后兼容）
  if worker_profile.tools is not None:
      allowed_tools = worker_profile.tools
  if worker_profile.skills is not None:
      allowed_skills = worker_profile.skills
  
  # 应用白名单过滤
  global_tools = get_available_tools()
  final_tools = [t for t in global_tools if t.name in allowed_tools]
  ```

### 阶段 3：Supervisor Tool 修改

- [ ] **更新 `create_subtask` 参数验证**
  - 文件：`backend/packages/harness/evoflow/tools/builtins/supervisor_tool.py`
  - 移除 `tools` 和 `skills` 作为必填参数
  - 更新文档字符串
  - 添加自动加载 AgentConfig 的逻辑

- [ ] **添加工具/技能预览**
  ```python
  # 在创建子任务时，显示将使用的工具
  agent_config = get_subagent_config(worker_profile.base_subagent)
  print(f"将使用工具：{agent_config.tools}")
  print(f"将使用技能：{agent_config.skills}")
  ```

### 阶段 4：迁移和兼容

- [ ] **数据迁移脚本**
  - 文件：`backend/migrate_worker_profiles.py`
  - 遍历所有现有项目
  - 移除子任务中冗余的 `tools` 和 `skills` 字段
  - 备份原数据

- [ ] **向后兼容处理**
  - 在 `WorkerProfile` 中保留 `tools` 和 `skills` 字段（可选）
  - 如果存在，优先使用（兼容旧数据）
  - 如果不存在，从 `AgentConfig` 读取

### 阶段 5：文档更新

- [ ] **更新 `底层数据结构分析.md`**
  - 文件：`docs/智能体协助/底层数据结构分析.md`
  - 更新 `WorkerProfile` 数据结构说明
  - 更新数据关系图
  - 添加引用关系说明

- [ ] **更新 `Subagent 协作流程工具列表.md`**
  - 文件：`docs/智能体协助/Subagent 协作流程工具列表.md`
  - 更新 `WorkerProfile` 结构示例
  - 更新传递路径说明

- [ ] **创建 `WorkerProfile 优化说明.md`**
  - 文件：`docs/智能体协助/WorkerProfile 优化说明.md`
  - 说明优化原因
  - 说明新旧对比
  - 说明迁移步骤

### 阶段 6：测试

- [ ] **单元测试**
  - 测试 `WorkerProfile` 加载逻辑
  - 测试从 `AgentConfig` 读取 tools/skills
  - 测试 instruction 覆盖逻辑

- [ ] **集成测试**
  - 创建子任务并验证 tools/skills 正确加载
  - 测试不同智能体类型的工具限制
  - 测试 instruction 覆盖效果

- [ ] **回归测试**
  - 确保旧项目仍能正常加载
  - 确保数据迁移不破坏现有功能

---

## 🎯 优化后的数据结构

### 修改前（冗余）

```json
{
  "id": "subtask_001",
  "name": "前端开发",
  "worker_profile": {
    "base_subagent": "general-purpose",
    "tools": ["read_file", "write_file", "bash"],  // 冗余
    "skills": ["react", "typescript"],              // 冗余
    "instruction": "你是一位前端专家...",
    "depends_on": []
  }
}

// 同时在 agents/general-purpose/config.yaml 中也有：
tools: ["read_file", "write_file", "bash"]
skills: ["react", "typescript"]
```

### 修改后（引用）

```json
{
  "id": "subtask_001",
  "name": "前端开发",
  "worker_profile": {
    "base_subagent": "general-purpose",  // 只存引用
    "instruction": "你是一位前端专家...",
    "depends_on": []
    // tools 和 skills 不再存储
  }
}

// 运行时动态加载：
// agents/general-purpose/config.yaml
tools: ["read_file", "write_file", "bash"]
skills: ["react", "typescript"]
```

---

## 📊 影响评估

### 正面影响

✅ **数据一致性**：智能体配置修改后，所有引用自动更新  
✅ **减少冗余**：每个子任务节省约 100-500 字节  
✅ **易维护**：只需在一处修改 tools/skills  
✅ **更清晰**：WorkerProfile 只关注任务特定约束

### 潜在风险

⚠️ **性能影响**：每次执行需要额外读取 AgentConfig（约 1-2ms）  
⚠️ **兼容性问题**：旧项目需要迁移或兼容处理  
⚠️ **灵活性降低**：无法为特定任务单独调整 tools/skills（可通过方案 B 解决）

### 建议

**推荐采用方案 A（完全引用）**，原因：
1. 数据一致性最重要
2. 性能影响可忽略（1-2ms）
3. 如需灵活性，可在未来采用方案 B（混合模式）

---

## 🚀 实施优先级

### 高优先级（必须做）

1. ✅ 修改 `WorkerProfile` 数据结构
2. ✅ 修改 `task_tool` 加载逻辑
3. ✅ 向后兼容处理

### 中优先级（应该做）

4. ✅ 更新 Supervisor Tool
5. ✅ 数据迁移脚本
6. ✅ 文档更新

### 低优先级（可以做）

7. ✅ 完整测试覆盖
8. ✅ 性能优化
9. ✅ 混合模式支持（方案 B）

---

**文档版本**: 1.0  
**创建时间**: 2026-04-04  
**状态**: 📝 待评审
