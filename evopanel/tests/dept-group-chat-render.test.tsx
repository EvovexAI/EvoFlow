/**
 * 部门群聊页面「真的能渲染」测试（渲染期冒烟 + 我的改动不崩页面）。
 *
 * 【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】
 *
 * ## 为什么必须补这个文件
 *
 * 上一轮我只跑了 `tsc --noEmit` + 纯函数 vitest。它们能证明「类型对」「函数对」，
 * **不能证明页面能渲染出来**——渲染期异常（hooks 顺序、undefined 解构、
 * useEffect 里炸掉、组件抛错）在 tsc 眼里全是合法的。
 * 用户问「前端页面显示正常吗」，唯一能回答的证据是把组件真的挂载起来看 DOM。
 *
 * ## 这个文件验什么
 *
 * 1. 组件能挂载并渲染——不抛错、不白屏；
 * 2. 我的旁路持久化（DeptGroupWakePersist）在**后端不可用**时不拖垮页面
 *    ——这是「不破坏现有前端」的核心承诺；
 * 3. 用户能输入（textarea 存在）。
 *
 * 不验「叫醒链路真的跑通」——那需要真模型真网关，已在后端真机验证过。
 * 本文件只回答一个问题：**页面会不会白屏**。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

// 网关层全部打桩：本测试不连真实后端，只验渲染。
vi.mock('../src/lib/tauri-api.js', () => ({
  api: {
    chatSessionsCreate: vi.fn(async () => ({})),
    updateSessionContext: vi.fn(async () => ({})),
    chatUpdateContext: vi.fn(async () => ({})),
    listOwnedKnowledgeBases: vi.fn(async () => []),
    getSessionModes: vi.fn(async () => ({})),
    // 群历史：默认空；需要验消息渲染的用例会覆盖返回值
    chatHistory: vi.fn(async () => ({ messages: [] })),
  },
  getGatewayBaseUrl: vi.fn(async () => 'http://127.0.0.1:8382'),
  // 旁路持久化的 transport 走这里。**默认让它失败**：
  // 验证「后端不可用时页面照样正常」——这是本次改动最该证的兼容性承诺。
  gatewayProxy: vi.fn(async () => {
    throw new Error('ECONNREFUSED')
  }),
}))

vi.mock('../src/lib/api-client.js', () => ({
  tasksAPI: {
    getTask: vi.fn(async () => null),
    listTasks: vi.fn(async () => []),
    listSubtasks: vi.fn(async () => []),
  },
}))

import { HomeDeptGroupChat } from '../src/react/components/HomeDeptGroupChat.js'

function person(code, name) {
  return {
    agent_code: code,
    role_name: name,
    department: '氛围部',
    reports_to: '',
    status: 'active',
    busy: false,
    summary: '',
  }
}

const DEPT = {
  id: 'd1',
  name: '氛围部',
  head_agent_code: 'atmosphere-newfan-bot',
  head_role_name: '新粉引导Bot',
  members: [
    person('atmosphere-newfan-bot', '新粉引导Bot'),
    person('atmosphere-fanvote-bot', '打投应援Bot'),
  ],
  busyCount: 0,
  accent: '#888888',
}

function renderChat(overrides = {}) {
  return render(
    <HomeDeptGroupChat
      dept={DEPT}
      onClose={() => {}}
      onOpenEmployeePage={() => {}}
      {...overrides}
    />,
  )
}

describe('HomeDeptGroupChat · 页面能渲染（渲染期冒烟）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('挂载不抛错，能渲染出部门名', async () => {
    const { container } = renderChat()
    await waitFor(() => expect(container.firstChild).toBeTruthy())
    expect(container.textContent || '').toContain('氛围部')
  })

  it('渲染出输入区（用户能打字）', async () => {
    renderChat()
    await waitFor(() => {
      expect(document.querySelector('textarea')).toBeTruthy()
    })
  })

  it('渲染出成员名字（花名册没被吞）', async () => {
    const { container } = renderChat()
    await waitFor(() => expect(container.firstChild).toBeTruthy())
    const text = container.textContent || ''
    expect(text.includes('新粉引导Bot') || text.includes('打投应援Bot')).toBe(true)
  })
})

describe('HomeDeptGroupChat · 后端不可用时不白屏（本次改动的兼容性承诺）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('旁路持久化全部失败，页面仍然渲染出部门名与输入框', async () => {
    // gatewayProxy 恒定抛错，模拟「网关没重启到新版本 / 断网」
    const { container } = renderChat()
    await waitFor(() => expect(container.firstChild).toBeTruthy())
    expect(container.textContent || '').toContain('氛围部')
    expect(document.querySelector('textarea')).toBeTruthy()
    // 不能出现整页错误兜底文案（说明异常没冒到 React 边界）
    const text = container.textContent || ''
    expect(text.includes('出错了') || text.includes('Something went wrong')).toBe(false)
  })
})

describe('HomeDeptGroupChat · 群消息真的渲染出来', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('历史里的一问一答都显示在页面上（用户话 + 岗位回复）', async () => {
    const { api } = await import('../src/lib/tauri-api.js')
    api.chatHistory.mockResolvedValue({
      messages: [
        {
          message_id: 'u-1',
          role: 'user',
          content: '大家报一下今天的进度',
          content_json: { content: '大家报一下今天的进度' },
        },
        {
          message_id: 'dept-reply-abc',
          role: 'assistant',
          content: '氛围部这边涨粉 320，已完成',
          content_json: {
            content: '氛围部这边涨粉 320，已完成',
            dept_group: {
              msg_kind: 'agent',
              speaker_code: 'atmosphere-newfan-bot',
              speaker_name: '新粉引导Bot',
              stream_state: 'final',
              origin: 'backend_mirror',
            },
          },
        },
      ],
    })
    const { container } = renderChat()
    await waitFor(() => {
      const text = container.textContent || ''
      expect(text).toContain('大家报一下今天的进度')
    })
    const text = container.textContent || ''
    // 回复正文必须可见
    expect(text).toContain('氛围部这边涨粉 320')
    // 发言人必须是岗位花名，不是 main（本轮修的 speaker_name 缺陷）
    expect(text).toContain('新粉引导Bot')
    expect(text.includes('main')).toBe(false)
  })

  it('镜像行与前端占位行同时存在时只显示一条（读取侧去重仍在生效）', async () => {
    const { api } = await import('../src/lib/tauri-api.js')
    const now = Date.now()
    api.chatHistory.mockResolvedValue({
      messages: [
        {
          message_id: 'dept-reply-dup1',
          role: 'assistant',
          content: '同一句话只该出现一次-标记X',
          created_at: new Date(now).toISOString(),
          content_json: {
            content: '同一句话只该出现一次-标记X',
            dept_group: {
              msg_kind: 'agent',
              speaker_code: 'atmosphere-newfan-bot',
              speaker_name: '新粉引导Bot',
              stream_state: 'final',
              origin: 'backend_mirror',
            },
          },
        },
        {
          message_id: `agent-atmosphere-newfan-bot-${now - 1000}`,
          role: 'assistant',
          content: '同一句话只该出现一次-标记X',
          created_at: new Date(now - 1000).toISOString(),
          content_json: {
            content: '同一句话只该出现一次-标记X',
            dept_group: {
              msg_kind: 'agent',
              speaker_code: 'atmosphere-newfan-bot',
              speaker_name: '新粉引导Bot',
              stream_state: 'final',
              work_session_key: 'proactive:atmosphere-newfan-bot:chat:dept-d1',
            },
          },
        },
      ],
    })
    const { container } = renderChat()
    await waitFor(() => expect(container.textContent || '').toContain('标记X'))
    const text = container.textContent || ''
    const hits = text.split('标记X').length - 1
    expect(hits).toBe(1)
  })
})
