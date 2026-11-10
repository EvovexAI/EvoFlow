import { describe, it, expect } from 'vitest'
import {
  buildShellSidebarGroups,
} from '../src/react/lib/session-list/build-shell-rows.js'
import {
  WORKSPACE_GROUP_PROACTIVE,
  WORKSPACE_GROUP_PROACTIVE_LABEL,
  WORKSPACE_GROUP_UNBOUND,
  isProactiveSession,
  proactiveAgentCodeFromSessionKey,
  resolveSessionWorkspaceGroup,
  splitVisibleAndFoldedDutySessions,
} from '../src/react/lib/session-list/workspace-groups.js'
import {
  getDisplayLabel,
  stripProactiveEmployeeTitlePrefix,
} from '../src/react/lib/session-list/display.js'
import {
  resolveSessionListIdentity,
  sessionTriggerLabel,
  buildOwnerSidebarGroups,
  looksLikeImChannelToken,
} from '../src/react/lib/session-list/session-identity.js'

describe('proactive employee session grouping', () => {
  it('isProactiveSession detects key prefix and context.source', () => {
    expect(isProactiveSession({ sessionKey: 'proactive:fe', context: {} })).toBe(true)
    expect(
      isProactiveSession({
        sessionKey: 'agent:main:abc',
        context: { source: 'proactive' },
      }),
    ).toBe(true)
    expect(
      isProactiveSession({
        sessionKey: 'agent:main:abc',
        context: { source: 'chat' },
      }),
    ).toBe(false)
  })

  it('resolveSessionWorkspaceGroup puts employees in __proactive__', () => {
    const g = resolveSessionWorkspaceGroup({
      sessionKey: 'proactive:fe',
      title: '智能体员工·前端',
      context: { source: 'proactive', local_workspace_root: '' },
    })
    expect(g.workspaceKey).toBe(WORKSPACE_GROUP_PROACTIVE)
    expect(g.label).toBe(WORKSPACE_GROUP_PROACTIVE_LABEL)
  })

  it('buildShellSidebarGroups separates employees from unbound chats', () => {
    const groups = buildShellSidebarGroups({
      filteredSessions: [
        {
          sessionKey: 'agent:main:chat-1',
          title: '普通对话',
          createdAt: 1000,
          updatedAt: 2000,
          context: {},
        },
        {
          sessionKey: 'proactive:fe',
          title: '智能体员工·前端架构师',
          createdAt: 1100,
          updatedAt: 3000,
          context: { source: 'proactive', proactive_agent_code: 'fe' },
        },
      ],
      selectedSessionKey: '',
      runningSessionMap: {},
      resolveLiveStreamActivityForSession: () => null,
      registeredWorkspacePaths: [],
      workspaceSummaries: [
        {
          workspaceKey: WORKSPACE_GROUP_UNBOUND,
          sessionCount: 1,
          maxUpdatedAt: 2000,
        },
        {
          workspaceKey: WORKSPACE_GROUP_PROACTIVE,
          sessionCount: 1,
          maxUpdatedAt: 3000,
        },
      ],
    })

    const unbound = groups.find((g) => g.workspaceKey === WORKSPACE_GROUP_UNBOUND)
    const proactive = groups.find((g) => g.workspaceKey === WORKSPACE_GROUP_PROACTIVE)
    expect(unbound?.sessions.map((s) => s.sessionKey)).toEqual(['agent:main:chat-1'])
    expect(proactive?.label).toBe(WORKSPACE_GROUP_PROACTIVE_LABEL)
    expect(proactive?.sessions.map((s) => s.sessionKey)).toEqual(['proactive:fe'])
    expect(proactive?.sessions[0]?.title).toBe('前端架构师')
    expect(groups[0]?.workspaceKey).toBe(WORKSPACE_GROUP_PROACTIVE)
  })

  it('strips employee title prefix for sidebar rows', () => {
    expect(stripProactiveEmployeeTitlePrefix('智能体员工·运维')).toBe('运维')
    expect(stripProactiveEmployeeTitlePrefix('AIGC 导演 · 你有啥记忆', ['AIGC 导演'])).toBe(
      '你有啥记忆',
    )
    expect(getDisplayLabel('proactive:ops', '智能体员工·运维')).toBe('运维')
  })

  it('extracts agent_code from proactive session key for avatar lookup', () => {
    expect(proactiveAgentCodeFromSessionKey('proactive:frontend_architect')).toBe(
      'frontend_architect',
    )
    expect(proactiveAgentCodeFromSessionKey('agent:main:abc')).toBe('')
  })

  it('folds older duty sessions per employee, keeps latest and selected', () => {
    const row = (sessionKey, updatedAt) => ({
      sessionKey,
      title: sessionKey,
      time: '',
      createdAt: updatedAt,
      updatedAt,
      active: false,
      canDelete: true,
      executing: false,
      runningPreviewLine: '',
      hasUnseenRunningUpdate: false,
      isPinned: false,
      pinOrder: 0,
      goalActive: false,
      workspaceKey: WORKSPACE_GROUP_PROACTIVE,
      workspaceLabel: '智能体员工',
    })
    const rows = [
      row('proactive:xiaomi:chat:1', 500),
      row('proactive:xiaomi:duty:a', 400),
      row('proactive:xiaomi:duty:b', 300),
      row('proactive:xiaomi:duty:c', 200),
      row('proactive:coder:duty:1', 150),
      row('proactive:coder:duty:2', 100),
    ]
    const collapsed = splitVisibleAndFoldedDutySessions(rows)
    expect(collapsed.visible.map((r) => r.sessionKey)).toEqual([
      'proactive:xiaomi:chat:1',
      'proactive:xiaomi:duty:a',
      'proactive:coder:duty:1',
    ])
    expect(collapsed.folded.map((r) => r.sessionKey)).toEqual([
      'proactive:xiaomi:duty:b',
      'proactive:xiaomi:duty:c',
      'proactive:coder:duty:2',
    ])

    const withSelected = splitVisibleAndFoldedDutySessions(rows, {
      selectedSessionKey: 'proactive:xiaomi:duty:c',
    })
    expect(withSelected.visible.map((r) => r.sessionKey)).toContain('proactive:xiaomi:duty:c')
    expect(withSelected.folded.map((r) => r.sessionKey)).not.toContain('proactive:xiaomi:duty:c')

    const expanded = splitVisibleAndFoldedDutySessions(rows, { expandAll: true })
    expect(expanded.folded).toEqual([])
    expect(expanded.visible).toHaveLength(rows.length)
  })
})

describe('session list identity (Owner × Trigger)', () => {
  it('classifies main / BOT panel / channel / schedule / task / dept / automation', () => {
    expect(resolveSessionListIdentity('agent:main:new-abcd')).toMatchObject({
      ownerKey: 'main',
      ownerKind: 'main',
      trigger: 'panel',
    })
    expect(resolveSessionListIdentity('proactive:aigc:chat:2026-01-01')).toMatchObject({
      ownerKey: 'aigc',
      ownerKind: 'agent',
      trigger: 'panel',
    })
    expect(resolveSessionListIdentity('proactive:aigc:chat:feishu:oc_abc')).toMatchObject({
      trigger: 'channel',
    })
    expect(resolveSessionListIdentity('agent:main:feishu:oc_xyz')).toMatchObject({
      ownerKey: 'main',
      trigger: 'channel',
    })
    expect(resolveSessionListIdentity('proactive:aigc:duty:round-1')).toMatchObject({
      trigger: 'schedule',
    })
    expect(resolveSessionListIdentity('proactive:aigc:task:tid-9')).toMatchObject({
      trigger: 'task',
    })
    expect(resolveSessionListIdentity('automation:task1:sticky')).toMatchObject({
      ownerKey: 'main',
      trigger: 'schedule',
    })
    expect(resolveSessionListIdentity('dept:marketing:chat')).toMatchObject({
      ownerKey: 'dept:marketing',
      ownerKind: 'dept',
      trigger: 'dept',
    })
    expect(
      resolveSessionListIdentity('proactive:bot:chat:free', { channel: 'feishu' }),
    ).toMatchObject({ trigger: 'channel' })
  })

  it('maps trigger chips and IM tokens', () => {
    expect(sessionTriggerLabel('panel')).toBe('对话')
    expect(sessionTriggerLabel('channel')).toBe('渠道')
    expect(sessionTriggerLabel('schedule')).toBe('定时')
    expect(sessionTriggerLabel('task')).toBe('任务')
    expect(sessionTriggerLabel('dept')).toBe('部门')
    expect(looksLikeImChannelToken('feishu')).toBe(true)
    expect(looksLikeImChannelToken('wecom:acct')).toBe(true)
    expect(looksLikeImChannelToken('2026-01-01T00-00-00')).toBe(false)
  })

  it('buildOwnerSidebarGroups orders main, agents, then depts', () => {
    const groups = buildOwnerSidebarGroups(
      [
        { sessionKey: 'proactive:botb:chat:1', updatedAt: 50 },
        { sessionKey: 'agent:main:new-1', updatedAt: 10 },
        { sessionKey: 'dept:sales:chat', updatedAt: 99 },
        { sessionKey: 'proactive:bota:duty:1', updatedAt: 80 },
      ],
      {
        seedOwners: [
          { ownerKey: 'main', ownerKind: 'main', ownerCode: '', label: '主对话' },
          { ownerKey: 'bota', ownerKind: 'agent', ownerCode: 'bota', label: 'BOT A' },
          { ownerKey: 'botb', ownerKind: 'agent', ownerCode: 'botb', label: 'BOT B' },
        ],
      },
    )
    expect(groups.map((g) => g.ownerKey)).toEqual(['main', 'bota', 'botb', 'dept:sales'])
    expect(groups[0].label).toBe('主对话')
  })
})
