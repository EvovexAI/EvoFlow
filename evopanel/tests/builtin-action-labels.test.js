import { describe, expect, it } from 'vitest'
import {
  assetsActionLabelZh,
  knowledgeActionLabelZh,
  readAssetsToolBrief,
  readKnowledgeToolBrief,
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

  it('maps knowledge actions to Chinese labels', () => {
    expect(knowledgeActionLabelZh('search')).toBe('检索知识库')
    expect(knowledgeActionLabelZh('read')).toBe('读取文档')
    expect(knowledgeActionLabelZh('list')).toBe('列出知识库')
    expect(knowledgeActionLabelZh('')).toBe('知识库')
  })

  it('builds knowledge brief from query / title / path leaf', () => {
    expect(readKnowledgeToolBrief({ action: 'search', query: 'auth middleware' })).toBe(
      'auth middleware',
    )
    expect(
      readKnowledgeToolBrief({
        action: 'read',
        paths: ['docs/roles/duty-handbook.md'],
      }),
    ).toBe('duty-handbook.md')
    expect(readKnowledgeToolBrief({ action: 'read', title: '值班手册' })).toBe('值班手册')
    expect(readKnowledgeToolBrief('{"action":"search","query":"项目架构')).toBe('项目架构')
    // 不把裸 doc_id 当摘要
    expect(readKnowledgeToolBrief({ action: 'read', doc_id: 'doc_abc123' })).toBe('')
  })
})
