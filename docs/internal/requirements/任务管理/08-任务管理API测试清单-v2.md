# 任务管理 API 测试清单（增强版 - 包含存储层验证）

> **文档状态**: 🔄 测试进行中  
> **最后更新**: 2025-01-18  
> **测试版本**: Phase 1-3 完整功能 + 存储层验证


## 📋 测试说明

### 验证维度
1. **接口响应** - API 返回的数据格式和状态码
2. **数据落地** - 存储层（文件/数据库）是否真实写入
3. **关联数据** - 相关实体是否正确联动
4. **副作用** - 事件、广播、状态变更等

### 标记说明
- [ ] 未测试
- [🔄] 测试中
- [x] 已通过
- [❌] 未通过
- [⏭️] 跳过


## 一、基础 CRUD 操作测试（含存储验证）

### 1.1 创建任务 (POST /api/tasks)

#### 1.1.1 正常创建任务 - 全字段
- [ ] 未测试

**接口验证:**
```
输入: {
  "name": "测试任务",
  "description": "这是一个测试任务",
  "thread_id": "thread_001"
}
响应: {
  "id": "task_xxx",
  "name": "测试任务",
  "description": "这是一个测试任务",
  "thread_id": "thread_001",
  "status": "pending",
  "progress": 0,
  "parent_project_id": "proj_xxx",
  "project_name": "..."
}
状态码: 200
```

**存储层验证:**
```
检查点1 - 项目存储:
- [ ] 新 project 目录是否创建: `storage/projects/{project_id}/`
- [ ] project.json 是否包含新任务
- [ ] task.metadata.json 是否正确生成

检查点2 - 任务数据完整性:
- [ ] id: 非空且唯一
- [ ] name: 与输入一致
- [ ] description: 与输入一致
- [ ] thread_id: 与输入一致
- [ ] status: "pending"
- [ ] progress: 0
- [ ] source: "manual"
- [ ] created_at: 当前时间戳
- [ ] updated_at: 当前时间戳
- [ ] subtasks: []
- [ ] execution_authorized: false
```

**关联验证:**
```
- [ ] 无关联数据需检查
```


#### 1.1.2 创建任务 - 只传名称
- [ ] 未测试

**接口验证:**
```
输入: {"name": "极简任务"}
响应: 包含默认值的完整任务对象
状态码: 200
```

**存储层验证:**
```
- [ ] description: 空字符串或 null
- [ ] thread_id: null
- [ ] 其他字段使用系统默认值
```


#### 1.1.3 创建任务后再次查询验证数据一致性
- [ ] 未测试

**测试流程:**
```
步骤1: 创建任务 → 获取 task_id
步骤2: GET /api/tasks/{task_id}
步骤3: 对比创建时返回的数据和查询返回的数据
步骤4: 直接读取存储文件验证
```

**验证点:**
```
- [ ] 查询返回与创建返回一致
- [ ] 存储文件与API返回一致
- [ ] 无字段丢失或变异
```


### 1.2 获取任务列表 (GET /api/tasks)

#### 1.2.1 获取所有任务 - 验证聚合逻辑
- [ ] 未测试

**接口验证:**
```
响应: {
  "success": true,
  "data": {
    "tasks": [...],
    "total": N,
    "filters": {...}
  }
}
```

**存储层验证:**
```
检查点1 - 聚合逻辑:
- [ ] tasks 数量是否等于所有项目任务之和
- [ ] 是否跨项目聚合正确
- [ ] parent_project_id 是否正确填充

检查点2 - 性能:
- [ ] 100+ 项目场景下的查询时间 < 500ms
```


#### 1.2.2 过滤后验证返回数据与存储一致
- [ ] 未测试

**测试流程:**
```
步骤1: 创建 pending 任务 A
步骤2: 创建 executing 任务 B
步骤3: GET /api/tasks?status=pending
步骤4: 验证只返回任务 A
步骤5: 验证任务 A 数据与存储一致
```


### 1.3 更新任务 (PUT /api/tasks/{task_id})

#### 1.3.1 更新任务名称 - 存储持久化验证
- [ ] 未测试

**接口验证:**
```
输入: PUT /api/tasks/task_xxx {"name": "新名称"}
响应: 包含更新后数据的完整对象
```

**存储层验证:**
```
检查点1 - 更新落库:
- [ ] storage/projects/{project_id}/project.json 中任务名称已变更
- [ ] updated_at 字段已更新为当前时间
- [ ] 其他字段未被意外修改

检查点2 - 数据一致性:
- [ ] API返回的updated_at与存储文件一致
- [ ] API返回的name与存储文件一致
```


#### 1.3.2 更新状态为 executing - 触发字段更新
- [ ] 未测试

**接口验证:**
```
输入: PUT ... {"status": "executing"}
响应: status: "executing"
```

**存储层验证:**
```
必检字段:
- [ ] status: "executing"
- [ ] started_at: 当前时间戳（自动填充）
- [ ] updated_at: 当前时间戳

验证 started_at 只在首次变为 executing 时设置:
- [ ] 步骤1: pending → executing (记录 started_at)
- [ ] 步骤2: executing → paused
- [ ] 步骤3: paused → executing (started_at 应不变)
```

**副作用验证:**
```
- [ ] 是否触发 task:started 事件广播
- [ ] 事件 payload 包含正确数据
```


#### 1.3.3 更新状态为 completed - 完成时间验证
- [ ] 未测试

**存储层验证:**
```
- [ ] status: "completed"
- [ ] completed_at: 当前时间戳（自动填充）
- [ ] progress: 自动更新为 100（如未指定）
- [ ] 子任务状态自动协调
```


#### 1.3.4 更新进度 - 事件触发
- [ ] 未测试

**接口验证:**
```
输入: PUT ... {"progress": 75}
响应: progress: 75
```

**副作用验证:**
```
- [ ] 触发 task:progress 事件
- [ ] 事件数据: {task_id, subtask_id, progress: 75, message: ""}
- [ ] 订阅该事件的客户端收到通知
```


### 1.4 删除任务 (DELETE /api/tasks/{task_id})

#### 1.4.1 删除任务 - 存储清理验证
- [ ] 未测试

**接口验证:**
```
响应: {"success": true, "deleted_task_id": "task_xxx"}
状态码: 200
```

**存储层验证:**
```
检查点1 - 任务数据:
- [ ] project.json 中该任务已移除
- [ ] 项目目录下任务相关文件已清理

检查点2 - 子任务处理:
- [ ] 如任务有子任务，子任务记录是否一并清理
- [ ] 子任务关联的 thread 是否断开

检查点3 - 关联数据:
- [ ] 是否清理任务关联的内存记录
- [ ] 是否清理任务关联的 artifact
```

**验证删除后:**
```
步骤1: GET /api/tasks/{deleted_task_id}
步骤2: 验证返回 404 TASK_NOT_FOUND
步骤3: 直接检查存储文件
步骤4: 确认任务数据不存在
```


## 二、子任务管理测试（含关联验证）

### 2.1 添加子任务

#### 2.1.1 添加子任务 - 主任务联动
- [ ] 未测试

**接口验证:**
```
输入: POST /api/tasks/{task_id}/subtasks
{
  "name": "子任务1",
  "description": "测试"
}
响应: {"subtask_id": "subtask_xxx", "task_id": "task_xxx"}
```

**存储层验证:**
```
检查点1 - 子任务存储:
- [ ] task.metadata.json 中 subtasks 数组新增一条
- [ ] subtask_id 格式正确: {task_id}.{sequence}
- [ ] 子任务字段完整: id, name, description, status, dependencies

检查点2 - 主任务更新:
- [ ] 主任务的 updated_at 字段更新
- [ ] 主任务的 subtask_count 递增（如有该字段）
- [ ] 主任务状态未受影响
```


#### 2.1.2 添加子任务 - 带依赖关系
- [ ] 未测试

**接口验证:**
```
输入: {
  "name": "子任务B",
  "dependencies": ["task_xxx.001"]
}
```

**存储层验证:**
```
- [ ] 子任务 dependencies 字段正确存储
- [ ] 被依赖的子任务状态检查（如父任务不存在应报错）
```


#### 2.1.3 添加子任务 - worker_profile 存储
- [ ] 未测试

**接口验证:**
```
输入: {
  "name": "AI任务",
  "worker_profile": {
    "base_subagent": "WorkerAgent",
    "tools": ["code_tool", "file_tool"],
    "skills": ["python", "fastapi"],
    "instruction": "使用Python完成任务"
  }
}
```

**存储层验证:**
```
- [ ] worker_profile 完整存储为子对象
- [ ] tools: 数组类型，值完整
- [ ] skills: 数组类型，值完整
- [ ] instruction: 字符串完整存储
- [ ] base_subagent: 字符串存储
```


### 2.2 更新子任务 - 主任务状态协调

#### 2.2.1 子任务完成 - 触发主任务自动完成
- [ ] 未测试

**测试场景:**
```
前置: 创建任务 T，包含子任务 S1, S2
测试步骤:
1. S1 更新为 completed
2. S1 更新为 completed
3. 验证主任务 T 的状态
```

**存储层验证:**
```
- [ ] 子任务 S1 status --> completed
- [ ] 子任务 S2 status --> completed
- [ ] 主任务 T status --> completed（自动）
- [ ] 主任务 T progress --> 100（自动）
- [ ] 主任务 T completed_at --> 当前时间（自动）
- [ ] 触发 task:completed 事件
```


#### 2.2.2 部分子任务完成 - 进度计算
- [ ] 未测试

**测试场景:**
```
3个子任务，1个完成
期望主任务 progress = 33 或 34
```

**存储层验证:**
```
- [ ] 主任务 progress 正确计算
- [ ] 计算公式: completed_count / total_count * 100
```


### 2.3 重试子任务

#### 2.3.1 重试失败的子任务 - 状态重置
- [ ] 未测试

**接口验证:**
```
输入: POST .../subtasks:retry {"subtask_ids": ["subtask_xxx"]}
响应: {"success": true, "retried": ["subtask_xxx"]}
```

**存储层验证:**
```
前置: 子任务状态为 failed，有 error_info
检查点:
- [ ] status: "pending"
- [ ] error_info: 被清空或重置
- [ ] retry_count: +1（如存在）
- [ ] updated_at: 更新
- [ ] 主任务状态联动（如主任务是 failed，应变为 pending）
```


## 三、批量操作测试（含事务性验证）

### 3.1 批量启动 - 部分成功场景

#### 3.1.1 批量启动 - 原子性验证
- [ ] 未测试

**测试场景:**
```
任务列表:
- task1: pending (可启动)
- task2: executing (已在运行)
- task3: pending (可启动)

操作: batch start [task1, task2, task3]
```

**预期行为:**
```
- task1: 启动成功 (executing)
- task2: 返回 ALREADY_RUNNING 错误
- task3: 启动成功 (executing)

结果: 部分成功，非全或无
```

**存储层验证:**
```
- [ ] task1: status=executing, started_at=有值
- [ ] task2: status=executing (不变), started_at=原值
- [ ] task3: status=executing, started_at=有值
```


#### 3.1.2 批量启动 - 结果数组验证
- [ ] 未测试

**接口验证:**
```
响应结构: {
  "success": true,
  "data": {
    "results": [
      {"task_id": "task1", "success": true},
      {"task_id": "task2", "success": false, "error": "..."},
      {"task_id": "task3", "success": true}
    ],
    "stats": {"success": 2, "failed": 1}
  }
}
```


### 3.2 批量取消 - 任务状态回滚

#### 3.2.1 批量取消 - 状态变更验证
- [ ] 未测试

**存储层验证:**
```
前置: task1=executing, task2=paused

操作后检查:
- [ ] task1: status=cancelled, cancelled_at=时间戳
- [ ] task2: status=cancelled, cancelled_at=时间戳
- [ ] 触发 task:cancelled 事件
```


## 四、授权执行测试（含协作状态验证）

### 4.1 授权执行 - 协作阶段推进

#### 4.1.1 正常授权 - 协作状态变更
- [ ] 未测试

**接口验证:**
```
输入: POST .../authorize-execution
{
  "authorized_by": "user",
  "thread_id": "thread_xxx"
}
响应: {
  "success": true,
  "execution_authorized": true,
  "authorized_at": "2025-01-18T10:00:00Z",
  "authorized_by": "user"
}
```

**存储层验证 - 任务数据:**
```
- [ ] execution_authorized: true
- [ ] authorized_at: 当前时间戳
- [ ] authorized_by: "user"
- [ ] status: planned → executing（或保持不变）
```

**存储层验证 - 协作状态:**
```
- [ ] thread_checkpoint 中 collab_state.phase 更新
- [ ] 从 "planning" 推进到 "executing"
- [ ] collaboration_state 持久化
```

**副作用验证:**
```
- [ ] advance_collab_phase_to_executing_for_task 被调用
- [ ] 协作phase middleware 状态更新
```


### 4.2 重复授权 - 幂等性

#### 4.2.1 重复授权 - 数据不变
- [ ] 未测试

**存储层验证:**
```
步骤1: 首次授权，记录 authorized_at = T1
步骤2: 重复授权，记录 authorized_at = T2

验证:
- [ ] T2 == T1（时间戳不应改变）
- [ ] 无重复协作阶段推进
- [ ] 返回适当提示但不报错
```


## 五、状态机测试（含转换约束验证）

### 5.1 状态转换矩阵 - 存储验证

#### 5.1.1 非法状态转换 - 拒绝并保留原状态
- [ ] 未测试

**测试场景:**
```
当前: status = completed
操作: PUT ... {"status": "executing"}

期望: 
- 接口返回 400/422 错误
- 存储中 status 仍为 completed
- updated_at 不变
```


#### 5.1.2 有效状态转换 - 时间戳更新
- [ ] 未测试

**测试场景:**
```
转换: pending → executing
验证:
- [ ] status 变更
- [ ] updated_at 更新
- [ ] started_at 首次设置
```


## 六、事件与副作用验证

### 6.1 事件触发验证

#### 6.1.1 任务生命周期事件
- [ ] 未测试

**验证清单:**
```
| 操作 | 事件名 | 验证点 |
|-----|-------|-------|
| 启动任务 | task:started | [ ] payload正确 [ ] 已广播 |
| 更新进度 | task:progress | [ ] progress值正确 [ ] 已广播 |
| 完成任务 | task:completed | [ ] 完成时间正确 [ ] 已广播 |
| 取消任务 | task:cancelled | [ ] 取消原因正确 [ ] 已广播 |
| 失败任务 | task:failed | [ ] error_info正确 [ ] 已广播 |
```

#### 6.1.2 事件数据与存储一致性
- [ ] 未测试

**验证:**
```
- [ ] 事件中的 task_id 与存储一致
- [ ] 事件中的 timestamp 与实际发生时间一致
- [ ] 事件中的 status 与存储最终状态一致
```


## 七、存储格式检查

### 7.1 项目存储结构

#### 7.1.1 文件结构验证
- [ ] 未测试

**检查路径:**
```
storage/
└── projects/
    └── {project_id}/
        ├── project.json          [ ] 存在且格式正确
        ├── task.metadata.json    [ ] 存在且格式正确
        └── tasks/                [ ] 目录存在
            └── 如有单独存储
```

#### 7.1.2 project.json 格式
- [ ] 未测试

**必填字段:**
```
- [ ] id
- [ ] name
- [ ] tasks: 数组，包含完整任务对象
- [ ] created_at
- [ ] updated_at
```

#### 7.1.3 task.metadata.json 格式
- [ ] 未测试

**必填字段:**
```
- [ ] task_id
- [ ] project_id
- [ ] subtasks: 数组
- [ ] status
- [ ] progress
```


## 八、边界与异常测试

### 8.1 并发操作

#### 8.1.1 并发更新同一任务
- [ ] 未测试

**测试场景:**
```
步骤1: 读取任务 (version=1)
步骤2: A线程更新名称
步骤3: B线程更新描述
期望: 后提交的覆盖前者，或返回冲突错误
```

**存储层验证:**
```
- [ ] 数据一致性（无损坏）
- [ ] 最终状态可预期
```


### 8.2 异常恢复

#### 8.2.1 存储失败回滚
- [ ] 未测试

**测试场景:**
```
模拟存储写入失败（如磁盘满）
操作: 更新任务
期望: 返回 500 错误，原数据不变
```

**存储层验证:**
```
- [ ] 错误前数据保持不变
- [ ] 无部分写入的脏数据
- [ ] 返回 SAVE_FAILED 错误码
```


## 九、测试执行模板

### 单条测试记录格式

```markdown
### 测试编号: TC-XXX

**测试项:** xxx操作

**状态:** [x] 已通过 / [❌] 未通过 / [ ] 未测试

**输入:**
```json
{
  "name": "测试数据"
}
```

**接口响应:**
- 状态码: 200
- 响应体:
```json
{
  "id": "task_xxx",
  ...
}
```

**存储层验证:**
```
检查文件: storage/projects/proj_xxx/project.json
- [x] 字段A: 值正确
- [x] 字段B: 值正确
- [ ] 字段C: 期望xxx，实际yyy ❌
```

**关联验证:**
```
- [x] 事件已触发
- [x] 关联数据已更新
```

**问题记录:**
```
如未通过，记录问题详情和复现步骤
```

**截图/日志:**
```
如有需要，附加截图或日志
```
```


## 十、测试工具命令

### 快速验证存储

```bash
# 查看项目存储内容
cat storage/projects/{project_id}/project.json | python -m json.tool

# 查看所有项目
ls -la storage/projects/

# 实时监控文件变化
watch -n 1 'cat storage/projects/{project_id}/project.json'

# 搜索特定任务
find storage/projects -name "*.json" -exec grep -l "task_id" {} \;
```

### 调试请求

```bash
# 带详细输出的curl
curl -v -X POST http://localhost:8000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"name": "test"}' 2>&1 | tee request.log
```


## 附录：验收标准

### 必须通过项

| # | 检查项 | 优先级 |
|---|-------|-------|
| 1 | 所有API操作数据成功落库 | P0 |
| 2 | 状态变更正确触发关联更新 | P0 |
| 3 | 错误码统一格式正确 | P0 |
| 4 | 批量操作结果与单体一致 | P0 |
| 5 | 删除操作彻底清理数据 | P0 |
| 6 | 事件广播与存储同步 | P1 |
| 7 | 并发操作数据一致性 | P1 |
| 8 | 状态机约束生效 | P1 |
