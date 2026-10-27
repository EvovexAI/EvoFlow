import { describe, expect, it } from 'vitest'
import {
  assetsActionLabelZh,
  readAssetsToolBrief,
  readNamedToolAction,
  readTasksToolBrief,
  tasksActionLabelZh,
} from '../src/lib/builtin-action-labels.js'

describe('builtin-action-labels', () => {
  it('maps tasks actions to Chinese labels', () => {
    expect(tasksActionLabelZh('create')).toBe('创建任务')
    expect(tasksActionLabelZh('progress')).toBe('更新进度')
    expect(tasksActionLabelZh('state')).toBe('结案/改状态')
    expect(tasksActionLabelZh('list')).toBe('列出任务')
    expect(tasksActionLabelZh('')).toBe('员工任务')
  })

  it('maps assets actions to Chinese labels', () => {
    expect(assetsActionLabelZh('search')).toBe('检索资产')
    expect(assetsActionLabelZh('note')).toBe('写入笔记')
    expect(assetsActionLabelZh('profile')).toBe('更新画像')
    expect(assetsActionLabelZh('read')).toBe('读取资产')
  })

  it('reads action from object and streaming half JSON', () => {
    expect(readNamedToolAction({ action: 'create', name: '日报' })).toBe('create')
    expect(readNamedToolAction('{"action":"search","query":"偏好')).toBe('search')
    expect(readNamedToolAction('')).toBe('')
  })

  it('builds tasks brief from name / status / progress', () => {
    expect(readTasksToolBrief({ action: 'create', name: '写周报' })).toBe('写周报')
    expect(readTasksToolBrief({ action: 'progress', status: 'running', progress: 40 })).toBe(
      'running · 40%',
    )
    expect(readTasksToolBrief('{"action":"get","task_id":"mt-abc"')).toBe('mt-abc')
  })

  it('builds assets brief from query / path', () => {
    expect(readAssetsToolBrief({ action: 'search', query: '用户偏好' })).toBe('用户偏好')
    expect(readAssetsToolBrief({ action: 'read', path: 'facts/prefs.md' })).toBe('facts/prefs.md')
    expect(readAssetsToolBrief({ action: 'note', content: '记住他喜欢简洁风格' })).toContain(
      '简洁风格',
    )
  })
})
