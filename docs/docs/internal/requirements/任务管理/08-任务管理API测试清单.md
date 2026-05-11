# 任务管理 API 测试清单

> **文档状态**: 🔄 测试进行中  
> **最后更新**: 2025-01-18  
> **测试版本**: Phase 1-3 完整功能

---

## 📋 测试说明

- [ ] 未测试
- [🔄] 测试中
- [x] 已通过
- [❌] 未通过
- [⏭️] 跳过

**记录格式**:
```
状态: [x] 已通过
输入: {...}
输出: {...}
备注: 特殊情况说明
```

---

## 一、基础 CRUD 操作测试

### 1.1 创建任务 (POST /api/tasks)

#### 1.1.1 正常创建任务
- [ ] 未测试
```
状态: 
输入: {"name": "测试任务", "description": "这是一个测试任务", "thread_id": null}
输出: 
备注: 
```

#### 1.1.2 创建任务 - 缺少必填字段
- [ ] 未测试
```
状态: 
输入: {}
输出: 
备注: 验证是否返回 VALIDATION_ERROR
```

#### 1.1.3 创建任务 - 字段类型错误
- [ ] 未测试
```
状态: 
输入: {"name": 123, "description": true}
输出: 
备注: 验证 Pydantic 验证错误格式
```

#### 1.1.4 创建任务 - 超长名称
- [ ] 未测试
```
状态: 
输入: {"name": "a" * 500}
输出: 
备注: 验证长度限制处理
```

---

### 1.2 获取任务列表 (GET /api/tasks)

#### 1.2.1 获取所有任务
- [ ] 未测试
```
状态: 
输入: GET /api/tasks
输出: 
备注: 验证返回结构包含 data.tasks, data.total, data.filters
```

#### 1.2.2 按状态过滤
- [ ] 未测试
```
状态: 
输入: GET /api/tasks?status=pending
输出: 
备注: 只返回 pending 状态的任务
```

#### 1.2.3 按来源过滤
- [ ] 未测试
```
状态: 
输入: GET /api/tasks?source=manual
输出: 
备注: source 可选值: conversation | automation | manual
```

#### 1.2.4 按项目ID过滤
- [ ] 未测试
```
状态: 
输入: GET /api/tasks?project_id=proj_xxx
输出: 
备注: 只返回指定项目的任务
```

#### 1.2.5 搜索功能
- [ ] 未测试
```
状态: 
输入: GET /api/tasks?search=关键词
输出: 
备注: 在任务名称和ID中搜索（不区分大小写）
```

#### 1.2.6 排序功能
- [ ] 未测试
```
状态: 
输入: GET /api/tasks?sort=created_at&order=asc
输出: 
备注: 测试所有排序字段: name | status | created_at | updated_at
```

---

### 1.3 获取单个任务 (GET /api/tasks/{task_id})

#### 1.3.1 获取存在的任务
- [ ] 未测试
```
状态: 
输入: GET /api/tasks/task_xxx
输出: 
备注: 验证返回包含 parent_project_id 和 project_name
```

#### 1.3.2 获取不存在的任务 (错误码验证)
- [ ] 未测试
```
状态: 
输入: GET /api/tasks/non_existent
输出: 
备注: 验证返回 404, error_code: TASK_NOT_FOUND
```

#### 1.3.3 获取任务 - 状态自动协调
- [ ] 未测试
```
状态: 
前置: 创建一个所有子任务都 completed 的主任务
输入: GET /api/tasks/{task_id}
输出: 
备注: 验证主任务状态自动更新为 completed, progress=100
```

---

### 1.4 更新任务 (PUT /api/tasks/{task_id})

#### 1.4.1 更新任务名称
- [ ] 未测试
```
状态: 
输入: PUT /api/tasks/{task_id} {"name": "新名称"}
输出: 
备注: 
```

#### 1.4.2 更新任务状态 - 开始执行
- [ ] 未测试
```
状态: 
输入: PUT /api/tasks/{task_id} {"status": "executing"}
输出: 
备注: 验证 started_at 字段被自动设置
```

#### 1.4.3 更新任务状态 - 完成
- [ ] 未测试
```
状态: 
输入: PUT /api/tasks/{task_id} {"status": "completed"}
输出: 
备注: 验证 completed_at 字段被自动设置
```

#### 1.4.4 更新任务进度 + 发送事件
- [ ] 未测试
```
状态: 
输入: PUT /api/tasks/{task_id} {"progress": 75}
输出: 
备注: 验证触发 progress 事件广播
```

#### 1.4.5 更新不存在的任务
- [ ] 未测试
```
状态: 
输入: PUT /api/tasks/non_existent {"name": "test"}
输出: 
备注: 验证返回 404, error_code: TASK_NOT_FOUND
```

---

### 1.5 删除任务 (DELETE /api/tasks/{task_id})

#### 1.5.1 删除存在的任务
- [ ] 未测试
```
状态: 
输入: DELETE /api/tasks/{task_id}
输出: 
备注: 验证返回 success: true
```

#### 1.5.2 删除不存在的任务
- [ ] 未测试
```
状态: 
输入: DELETE /api/tasks/non_existent
输出: 
备注: 验证返回 404, error_code: TASK_NOT_FOUND
```

#### 1.5.3 删除运行中的任务
- [ ] 未测试
```
状态: 
前置: 创建并启动一个任务
输入: DELETE /api/tasks/{running_task_id}
输出: 
备注: 验证是否允许删除运行中的任务
```

---

## 二、错误码统一测试 (Phase 3 重点)

### 2.1 错误响应结构验证

#### 2.1.1 统一错误格式检查
- [ ] 未测试
```
状态: 
触发: 任意导致错误的请求
验证点:
  - [ ] success: false
  - [ ] error_code: 非空字符串
  - [ ] message: 中文描述
  - [ ] details: null 或数组
  - [ ] request_id: null 或可空
```

#### 2.1.2 HTTP 状态码映射
- [ ] 未测试
```
状态: 
验证点:
  - [ ] TASK_NOT_FOUND → 404
  - [ ] SUBTASK_NOT_FOUND → 404
  - [ ] INVALID_STATUS → 400
  - [ ] INVALID_ACTION → 400
  - [ ] EXECUTION_NOT_AUTHORIZED → 403
  - [ ] INTERNAL_ERROR → 500
```

---

### 2.2 各类错误场景测试

#### 2.2.1 TASK_NOT_FOUND (404)
- [ ] 未测试
```
状态: 
端点: GET /api/tasks/non_existent
期望:
  status_code: 404
  error_code: "TASK_NOT_FOUND"
  message: 包含"不存在"中文提示
```

#### 2.2.2 SUBTASK_NOT_FOUND (404)
- [ ] 未测试
```
状态: 
端点: PUT /api/tasks/{task_id}/subtasks/non_existent
期望:
  status_code: 404
  error_code: "SUBTASK_NOT_FOUND"
```

#### 2.2.3 INVALID_STATUS (400)
- [ ] 未测试
```
状态: 
端点: PUT /api/tasks/{task_id} {"status": "invalid_status"}
期望:
  status_code: 400
  error_code: "INVALID_STATUS"
```

#### 2.2.4 INVALID_ACTION (400)
- [ ] 未测试
```
状态: 
端点: POST /api/tasks/batch {"action": "invalid", "task_ids": []}
期望:
  status_code: 400
  error_code: "INVALID_ACTION"
  message: 包含允许的操作列表
```

#### 2.2.5 EXECUTION_NOT_AUTHORIZED (403)
- [ ] 未测试
```
状态: 
前置: 创建一个非 planned/planning 状态的任务
端点: POST /api/tasks/{task_id}/authorize-execution
期望:
  status_code: 422
  error_code: "EXECUTION_NOT_AUTHORIZED"
```

#### 2.2.6 VALIDATION_ERROR (400)
- [ ] 未测试
```
状态: 
端点: POST /api/tasks {"name": 123}
期望:
  status_code: 400
  error_code: 包含 "VALIDATION" 或 "VALIDATION_ERROR"
  details: 数组格式错误详情
```

---

## 三、子任务管理测试

### 3.1 添加子任务 (POST /api/tasks/{task_id}/subtasks)

#### 3.1.1 正常添加子任务
- [ ] 未测试
```
状态: 
输入: 
  task_id: {existing_task_id}
  body: {"name": "子任务1", "description": "测试子任务"}
输出: 
备注: 验证返回 subtask_id
```

#### 3.1.2 添加子任务 - 带依赖
- [ ] 未测试
```
状态: 
输入: 
  body: {
    "name": "子任务2",
    "dependencies": ["subtask_1_id"]
  }
输出: 
备注: 验证 dependencies 被正确保存
```

#### 3.1.3 添加子任务 - 指定 worker_profile
- [ ] 未测试
```
状态: 
输入: 
  body: {
    "name": "子任务3",
    "worker_profile": {
      "base_subagent": "WorkerAgent",
      "tools": ["tool1", "tool2"],
      "skills": ["skill1"],
      "instruction": "自定义指令"
    }
  }
输出: 
备注: 验证 worker_profile 完整保存
```

#### 3.1.4 为不存在的任务添加子任务
- [ ] 未测试
```
状态: 
输入: POST /api/tasks/non_existent/subtasks
输出: 
备注: 验证返回 TASK_NOT_FOUND
```

---

### 3.2 更新子任务 (PUT /api/tasks/{task_id}/subtasks/{subtask_id})

#### 3.2.1 更新子任务状态
- [ ] 未测试
```
状态: 
输入: PUT /api/tasks/{task_id}/subtasks/{subtask_id} {"status": "executing"}
输出: 
备注: 
```

#### 3.2.2 更新子任务负责人
- [ ] 未测试
```
状态: 
输入: PUT ... {"assigned_to": "agent_123"}
输出: 
备注: 
```

#### 3.2.3 更新子任务进度
- [ ] 未测试
```
状态: 
输入: PUT ... {"progress": 50}
输出: 
备注: 
```

#### 3.2.4 更新不存在的子任务
- [ ] 未测试
```
状态: 
输入: PUT /api/tasks/{task_id}/subtasks/non_existent
输出: 
备注: 验证返回 SUBTASK_NOT_FOUND
```

---

### 3.3 重试子任务 (POST /api/tasks/{task_id}/subtasks:retry)

#### 3.3.1 重试失败的子任务
- [ ] 未测试
```
状态: 
前置: 创建一个失败的子任务
输入: POST .../subtasks:retry {"subtask_ids": ["subtask_xxx"]}
输出: 
备注: 验证子任务状态重置为 pending
```

#### 3.3.2 重试所有失败的子任务
- [ ] 未测试
```
状态: 
输入: POST .../subtasks:retry {"retry_all_failed": true}
输出: 
备注: 验证所有 failed 状态子任务被重置
```

#### 3.3.3 重试非失败状态的子任务
- [ ] 未测试
```
状态: 
前置: 创建一个 completed 状态的子任务
输入: POST .../subtasks:retry {"subtask_ids": ["completed_subtask"]}
输出: 
备注: 验证返回 SUBTASK_NOT_RETRYABLE
```

---

## 四、批量操作测试

### 4.1 批量启动 (POST /api/tasks/batch)

#### 4.1.1 批量启动多个任务
- [ ] 未测试
```
状态: 
前置: 创建多个 pending 状态任务
输入: {"action": "start", "task_ids": ["task1", "task2"]}
输出: 
备注: 验证所有任务状态变为 executing
```

#### 4.1.2 批量启动 - 包含已运行的任务
- [ ] 未测试
```
状态: 
前置: task1=executing, task2=pending
输入: {"action": "start", "task_ids": ["task1", "task2"]}
输出: 
备注: 验证 task1 返回 ALREADY_RUNNING 错误，task2 成功启动
```

#### 4.1.3 批量启动 - 任务不存在
- [ ] 未测试
```
状态: 
输入: {"action": "start", "task_ids": ["non_existent"]}
输出: 
备注: 验证返回对应错误
```

---

### 4.2 批量取消

#### 4.2.1 批量取消运行中的任务
- [ ] 未测试
```
状态: 
前置: 创建多个 executing 状态任务
输入: {"action": "cancel", "task_ids": [...]}
输出: 
备注: 验证任务状态变为 cancelled
```

#### 4.2.2 批量取消 - 已完成任务
- [ ] 未测试
```
状态: 
前置: task1=completed, task2=executing
输入: {"action": "cancel", "task_ids": [...]}
输出: 
备注: 验证 completed 任务返回错误提示
```

---

### 4.3 批量暂停

#### 4.3.1 批量暂停运行中的任务
- [ ] 未测试
```
状态: 
输入: {"action": "pause", "task_ids": [...]}
输出: 
备注: 验证任务状态变为 paused
```

---

### 4.4 批量恢复

#### 4.4.1 批量恢复暂停的任务
- [ ] 未测试
```
状态: 
前置: 创建 paused 状态任务
输入: {"action": "resume", "task_ids": [...]}
输出: 
备注: 验证任务恢复为 executing 状态
```

---

### 4.5 批量删除

#### 4.5.1 批量删除多个任务
- [ ] 未测试
```
状态: 
输入: {"action": "delete", "task_ids": ["task1", "task2"]}
输出: 
备注: 验证任务被删除
```

---

## 五、授权执行测试

### 5.1 用户授权

#### 5.1.1 正常授权
- [ ] 未测试
```
状态: 
前置: 创建 planned 状态的任务
输入: POST /api/tasks/{task_id}/authorize-execution {"authorized_by": "user"}
输出: 
备注: 验证返回 execution_authorized: true
```

#### 5.1.2 重复授权
- [ ] 未测试
```
状态: 
前置: 已授权的任务
输入: POST .../authorize-execution
输出: 
备注: 验证返回适当提示，不报错
```

---

### 5.2 状态检查

#### 5.2.1 非可授权状态的任务
- [ ] 未测试
```
状态: 
前置: 创建 executing 状态的任务
输入: POST .../authorize-execution
输出: 
备注: 验证返回 EXECUTION_NOT_AUTHORIZED
```

#### 5.2.2 协作阶段推进
- [ ] 未测试
```
状态: 
前置: 关联了 thread 的任务
输入: POST .../authorize-execution {"thread_id": "thread_xxx"}
输出: 
备注: 验证 advance_collab_phase_to_executing_for_task 被调用
```

---

## 六、状态机与边界测试

### 6.1 状态转换矩阵验证

| 当前状态 | 目标状态 | 允许 | 测试状态 |
|---------|---------|------|---------|
| pending | executing | ✅ | [ ] |
| pending | cancelled | ✅ | [ ] |
| executing | paused | ✅ | [ ] |
| executing | completed | ✅ | [ ] |
| executing | failed | ✅ | [ ] |
| executing | cancelled | ✅ | [ ] |
| paused | executing | ✅ | [ ] |
| paused | cancelled | ✅ | [ ] |
| completed | executing | ❌ | [ ] |
| failed | executing | ❌ | [ ] |
| cancelled | executing | ❌ | [ ] |

---

### 6.2 边界值测试

#### 6.2.1 进度值边界
- [ ] 未测试
```
状态: 
测试点:
  - [ ] progress = 0
  - [ ] progress = 50
  - [ ] progress = 100
  - [ ] progress = -1 (应拒绝)
  - [ ] progress = 101 (应拒绝)
```

#### 6.2.2 空数组处理
- [ ] 未测试
```
状态: 
测试点:
  - [ ] batch 操作传入空 task_ids []
  - [ ] 创建任务后 subtasks 为空数组
```

#### 6.2.3 特殊字符处理
- [ ] 未测试
```
状态: 
测试点:
  - [ ] 任务名称包含 emoji
  - [ ] 任务名称包含 HTML 标签
  - [ ] 任务名称包含 SQL 注入尝试
```

---

## 七、性能与压力测试

### 7.1 基础性能

#### 7.1.1 列表接口响应时间
- [ ] 未测试
```
状态: 
测试条件: 100个任务
期望: < 200ms
实际: 
```

#### 7.1.2 批量操作性能
- [ ] 未测试
```
状态: 
测试条件: 批量操作50个任务
期望: < 1000ms
实际: 
```

---

## 八、测试执行记录

### 执行环境
```
后端版本: 
Python版本: 
测试日期: 
测试人员: 
```

###  Bug 记录

| Bug ID | 描述 | 复现步骤 | 严重程度 | 状态 |
|-------|------|---------|---------|------|
| | | | | |

### 测试统计

| 类别 | 总数 | 通过 | 失败 | 跳过 | 通过率 |
|-----|------|------|------|------|--------|
| CRUD操作 | 15 | 0 | 0 | 0 | 0% |
| 错误码验证 | 8 | 0 | 0 | 0 | 0% |
| 子任务管理 | 10 | 0 | 0 | 0 | 0% |
| 批量操作 | 10 | 0 | 0 | 0 | 0% |
| 授权执行 | 5 | 0 | 0 | 0 | 0% |
| 边界测试 | 6 | 0 | 0 | 0 | 0% |
| **总计** | **54** | **0** | **0** | **0** | **0%** |

---

## 附录：快速测试命令

```bash
# 1. 启动后端
cd backend && python -m uvicorn app.main:app --reload

# 2. 运行手动测试脚本
python test_tasks_manual.py

# 3. 运行自动化测试
python -m pytest tests/test_tasks_router.py -v

# 4. 生成测试报告
python -m pytest tests/test_tasks_router.py --html=report.html
```
