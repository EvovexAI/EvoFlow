# 06 - RunManager UI/UX 优化设计

## 目录

- [1. 问题定义](#1-问题定义)
- [2. 现有机制分析](#2-现有机制分析)
- [3. 设计方案](#3-设计方案)
- [4. 开发事项与进度](#4-开发事项与进度)

---

## 1. 问题定义

### 1.1 当前问题

当前 RunManager 存在以下 UX 问题：
1. **按钮状态不清晰** - 不知道什么状态下显示什么按钮
2. **缺少任务来源标识** - 不知道任务是哪里创建的
3. **子任务展示不直观** - 子任务列表不够清晰
4. **缺少进度可视化** - 没有进度条、甘特图等
5. **筛选功能缺失** - 无法按状态、来源筛选任务
6. **缺少批量操作** - 不能批量启动/取消任务
7. **实时反馈不足** - WebSocket 事件展示不明显

### 1.2 目标定义

提升 RunManager 的用户体验：
1. 清晰的按钮状态逻辑
2. 直观的任务来源标识
3. 更好的子任务可视化
4. 支持任务筛选和搜索
5. 支持批量操作
6. 实时状态同步

---

## 2. 现有机制分析

### 2.1 当前 RunManager 结构

```typescript
// RunManager.tsx 当前结构

interface RunManagerProps {
  isOpen: boolean
  taskNames?: Array<{ taskId: string; name: string; status?: string }>
  selectedTaskId?: string | null
  onSelectTaskId?: (taskId: string) => void
  onClose: () => void
  agents?: unknown[]
}

// 当前功能:
// - 显示任务列表
// - 显示子任务列表
// - 启动/取消/刷新按钮
// - 智能体名称显示
```

### 2.2 当前按钮逻辑

```typescript
// 当前按钮（简化版）
<div className="react-chat-run-subtasks-actions">
  <button onClick={handleStartTask}>启动</button>
  <button onClick={handleCancelCurrentTask}>取消</button>
  <button onClick={handleRefresh}>刷新</button>
</div>

// 问题: 所有按钮都显示，没有根据状态动态显示
```

### 2.3 问题根因

- 按钮没有根据任务状态动态显示
- 缺少任务来源信息
- 子任务展示不够直观
- 没有筛选和搜索功能

---

## 3. 设计方案

### 3.1 按钮状态逻辑设计

#### 3.1.1 动态按钮显示

```typescript
// 按钮显示逻辑

const getActionButtons = (taskStatus: string, subtasks: SubtaskInfo[]) => {
  const buttons = []
  
  switch (taskStatus) {
    case 'pending':
    case 'planned':
      buttons.push(
        { key: 'start', label: '启动', icon: 'play', variant: 'primary' }
      )
      break
      
    case 'executing':
      buttons.push(
        { key: 'pause', label: '暂停', icon: 'pause', variant: 'warning' },
        { key: 'cancel', label: '取消', icon: 'stop', variant: 'danger' }
      )
      break
      
    case 'paused':
      buttons.push(
        { key: 'resume', label: '恢复', icon: 'play', variant: 'primary' },
        { key: 'cancel', label: '取消', icon: 'stop', variant: 'danger' }
      )
      break
      
    case 'failed':
      const failedSubtasks = subtasks.filter(s => s.status === 'failed')
      if (failedSubtasks.length > 0) {
        buttons.push(
          { key: 'retry', label: '重试失败子任务', icon: 'refresh', variant: 'primary' }
        )
      }
      buttons.push(
        { key: 'cancel', label: '取消', icon: 'stop', variant: 'danger' }
      )
      break
      
    case 'completed':
      buttons.push(
        { key: 'view-result', label: '查看结果', icon: 'eye', variant: 'secondary' }
      )
      break
  }
  
  // 刷新按钮始终显示
  buttons.push(
    { key: 'refresh', label: '刷新', icon: 'refresh', variant: 'secondary' }
  )
  
  return buttons
}
```

### 3.2 任务来源标识

#### 3.2.1 来源标签设计

```typescript
// 任务来源标签

const TaskSourceBadge = ({ source }: { source: string }) => {
  const sourceConfig = {
    conversation: { 
      label: '对话创建', 
      color: '#3b82f6', 
      icon: 'message-circle' 
    },
    automation: { 
      label: '定时任务', 
      color: '#8b5cf6', 
      icon: 'clock' 
    },
    manual: { 
      label: '手动创建', 
      color: '#22c55e', 
      icon: 'user' 
    },
  }
  
  const config = sourceConfig[source] || sourceConfig.manual
  
  return (
    <span className="task-source-badge" style={{ backgroundColor: config.color }}>
      <Icon name={config.icon} size={12} />
      {config.label}
    </span>
  )
}
```

### 3.3 子任务可视化

#### 3.3.1 子任务卡片设计

```typescript
// 子任务卡片

const SubtaskCard = ({ subtask }: { subtask: SubtaskInfo }) => {
  const statusColors = {
    pending: '#9ca3af',
    executing: '#3b82f6',
    completed: '#22c55e',
    failed: '#ef4444',
    cancelled: '#6b7280',
  }
  
  return (
    <div className="subtask-card">
      <div className="subtask-header">
        <span className="subtask-name">{subtask.name || subtask.subtaskId}</span>
        <span 
          className="subtask-status"
          style={{ backgroundColor: statusColors[subtask.status] }}
        >
          {getStatusText(subtask.status)}
        </span>
      </div>
      
      <div className="subtask-meta">
        <span className="subtask-agent">
          <Icon name="bot" size={12} />
          {subtask.assignedAgentDisplay || subtask.assignedAgent || '未分配'}
        </span>
        
        {subtask.progress !== undefined && (
          <div className="subtask-progress">
            <ProgressBar value={subtask.progress} size="small" />
            <span>{subtask.progress}%</span>
          </div>
        )}
      </div>
      
      {subtask.status === 'failed' && (
        <div className="subtask-error">
          <Icon name="alert-circle" size={12} />
          {subtask.error || '执行失败'}
        </div>
      )}
    </div>
  )
}
```

#### 3.3.2 子任务甘特图（可选）

```typescript
// 简单甘特图

const SubtaskGantt = ({ subtasks }: { subtasks: SubtaskInfo[] }) => {
  // 按时间排序
  const sortedSubtasks = subtasks.sort((a, b) => 
    new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
  )
  
  return (
    <div className="subtask-gantt">
      {sortedSubtasks.map(subtask => (
        <div key={subtask.subtaskId} className="gantt-row">
          <span className="gantt-label">{subtask.name}</span>
          <div className="gantt-bar">
            <div 
              className={`gantt-bar-fill status-${subtask.status}`}
              style={{ 
                left: `${calculateOffset(subtask)}%`,
                width: `${calculateDuration(subtask)}%`,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}
```

### 3.4 任务筛选和搜索

#### 3.4.1 筛选栏设计

```typescript
// 任务筛选

const TaskFilterBar = ({ onFilterChange }: { onFilterChange: (filters) => void }) => {
  const [filters, setFilters] = useState({
    status: 'all',  // all | pending | executing | completed | failed
    source: 'all',  // all | conversation | automation | manual
    search: '',
  })
  
  return (
    <div className="task-filter-bar">
      <select 
        value={filters.status}
        onChange={(e) => setFilters({ ...filters, status: e.target.value })}
      >
        <option value="all">全部状态</option>
        <option value="pending">待执行</option>
        <option value="executing">执行中</option>
        <option value="paused">已暂停</option>
        <option value="completed">已完成</option>
        <option value="failed">失败</option>
        <option value="cancelled">已取消</option>
      </select>
      
      <select
        value={filters.source}
        onChange={(e) => setFilters({ ...filters, source: e.target.value })}
      >
        <option value="all">全部来源</option>
        <option value="conversation">对话创建</option>
        <option value="automation">定时任务</option>
        <option value="manual">手动创建</option>
      </select>
      
      <input
        type="text"
        placeholder="搜索任务名称..."
        value={filters.search}
        onChange={(e) => setFilters({ ...filters, search: e.target.value })}
      />
    </div>
  )
}
```

### 3.5 批量操作

#### 3.5.1 批量操作设计

```typescript
// 批量操作

const BatchOperations = ({ selectedTasks, onBatchAction }: { 
  selectedTasks: string[],
  onBatchAction: (action: string, taskIds: string[]) => void 
}) => {
  if (selectedTasks.length === 0) return null
  
  return (
    <div className="batch-operations">
      <span>已选择 {selectedTasks.length} 个任务</span>
      
      <button onClick={() => onBatchAction('start', selectedTasks)}>
        <Icon name="play" size={14} />
        批量启动
      </button>
      
      <button onClick={() => onBatchAction('cancel', selectedTasks)}>
        <Icon name="stop" size={14} />
        批量取消
      </button>
      
      <button onClick={() => onBatchAction('delete', selectedTasks)}>
        <Icon name="trash" size={14} />
        批量删除
      </button>
    </div>
  )
}
```

### 3.6 实时状态同步

#### 3.6.1 WebSocket 事件监听

```typescript
// WebSocket 事件处理

const useTaskEvents = (taskId: string, onEvent: (event) => void) => {
  useEffect(() => {
    const ws = new WebSocket(`/api/events/tasks/${taskId}`)
    
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data)
      onEvent(data)
    }
    
    return () => ws.close()
  }, [taskId])
}

// 事件通知

const EventNotification = ({ event }: { event: any }) => {
  const notificationConfig = {
    'task_started': { type: 'info', message: '任务开始执行' },
    'task_paused': { type: 'warning', message: '任务已暂停' },
    'task_resumed': { type: 'info', message: '任务已恢复' },
    'task_cancelled': { type: 'error', message: '任务已取消' },
    'task_completed': { type: 'success', message: '任务已完成' },
    'task_failed': { type: 'error', message: '任务执行失败' },
    'subtask_started': { type: 'info', message: '子任务开始' },
    'subtask_completed': { type: 'success', message: '子任务完成' },
    'subtask_failed': { type: 'error', message: '子任务失败' },
  }
  
  const config = notificationConfig[event.type]
  if (!config) return null
  
  return (
    <div className={`event-notification ${config.type}`}>
      <Icon name={getIconForType(config.type)} size={16} />
      {config.message}
    </div>
  )
}
```

---

## 4. 开发事项与进度

### 4.1 开发进度总览

| 阶段 | 内容 | 工时 | 进度 | 状态 |
|------|------|------|------|------|
| Phase 1 | 按钮状态逻辑 | 4h | 100% | 已完成 |
| Phase 2 | 来源标识 | 2h | 0% | 待开发 |
| Phase 3 | 子任务可视化 | 6h | 30% | 进行中 |
| Phase 4 | 筛选搜索 | 4h | 100% | 已完成 |
| Phase 5 | 批量操作 | 4h | 100% | 已完成 |
| Phase 6 | 实时同步 | 4h | 50% | 进行中 |
| Phase 7 | 调试优化 | 4h | 0% | 未开始 |
| **总计** | - | **28h** | **60%** | **进行中** |

### 4.2 详细任务

#### Phase 1: 按钮状态逻辑 (4h)

| 序号 | 任务 | 文件 | 工时 | 状态 |
|------|------|------|------|------|
| 1.1 | 实现 getActionButtons 函数 | RunManager.tsx | 1h | 待开发 |
| 1.2 | 根据状态动态显示按钮 | RunManager.tsx | 2h | 待开发 |
| 1.3 | 添加按钮图标和样式 | RunManager.tsx | 1h | 待开发 |

#### Phase 2: 来源标识 (2h)

| 序号 | 任务 | 文件 | 工时 | 状态 |
|------|------|------|------|------|
| 2.1 | 创建 TaskSourceBadge 组件 | TaskSourceBadge.tsx | 1h | 待开发 |
| 2.2 | 在任务列表中显示来源 | RunManager.tsx | 0.5h | 待开发 |
| 2.3 | 后端 API 添加 source 字段 | tasks.py | 0.5h | 待开发 |

#### Phase 3: 子任务可视化 (6h)

| 序号 | 任务 | 文件 | 工时 | 状态 |
|------|------|------|------|------|
| 3.1 | 创建 SubtaskCard 组件 | SubtaskCard.tsx | 2h | 待开发 |
| 3.2 | 优化子任务列表展示 | RunManager.tsx | 2h | 待开发 |
| 3.3 | 添加进度条显示 | react-chat.css | 1h | 待开发 |
| 3.4 | （可选）实现甘特图 | SubtaskGantt.tsx | 1h | 待开发 |

#### Phase 4: 筛选搜索 (4h)

| 序号 | 任务 | 文件 | 工时 | 状态 |
|------|------|------|------|------|
| 4.1 | 创建 TaskFilterBar 组件 | TaskFilterBar.tsx | 2h | ✅ 已完成 |
| 4.2 | 实现筛选逻辑 | RunManager.tsx | 1h | ✅ 已完成 |
| 4.3 | 添加搜索功能 | RunManager.tsx | 1h | ✅ 已完成 |

**实现内容**:
- ✅ TaskFilterBar 组件支持状态筛选（全部/待执行/执行中/已完成/失败/已取消）
- ✅ 搜索框支持按任务名称和ID搜索，带防抖功能（300ms）
- ✅ 排序功能支持按更新时间/名称排序，支持升序/降序切换
- ✅ 清除筛选按钮，一键重置所有筛选条件
- ✅ 筛选结果统计显示（显示 X 个任务 / 共 Y 个）

#### Phase 5: 批量操作 (4h)

| 序号 | 任务 | 文件 | 工时 | 状态 |
|------|------|------|------|------|
| 5.1 | 添加任务选择功能 | RunManager.tsx | 1h | ✅ 已完成 |
| 5.2 | 创建 BatchOperations 组件 | BatchOperations.tsx | 2h | ✅ 已完成 |
| 5.3 | 实现批量操作 API | tasks.py | 1h | ⏸️ 延后 |

**实现内容**:
- ✅ 任务列表项添加复选框支持单选/多选
- ✅ 全选/取消全选功能
- ✅ BatchOperations 组件支持批量启动/取消/刷新/删除
- ✅ 删除和取消操作带确认对话框
- ✅ 批量操作错误处理（单任务失败不影响其他任务）
- ✅ 操作完成后自动刷新任务列表
- ⏸️ 批量删除 API 待后端实现

#### Phase 6: 实时同步 (4h)

| 序号 | 任务 | 文件 | 工时 | 状态 |
|------|------|------|------|------|
| 6.1 | 实现 useTaskEvents hook | useTaskEvents.ts | 1h | 待开发 |
| 6.2 | 创建 EventNotification 组件 | EventNotification.tsx | 1h | 待开发 |
| 6.3 | 集成 WebSocket 事件 | RunManager.tsx | 2h | 待开发 |

#### Phase 7: 调试优化 (4h)

| 序号 | 任务 | 工时 | 状态 |
|------|------|------|------|
| 7.1 | 响应式布局测试 | 1h | 待调试 |
| 7.2 | 性能优化 | 2h | 待调试 |
| 7.3 | 用户体验测试 | 1h | 待调试 |

---

**设计完成日期**: 2025-04-17
**状态**: 待评审
