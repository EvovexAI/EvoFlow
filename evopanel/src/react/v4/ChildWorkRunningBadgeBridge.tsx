// ChildWorkRunningBadgeBridge — 主聊天头部的"N 个子代理运行中"浅色徽标。
//
// - 数据:复用 useSessionChildWorks 的 3s 轮询(execution/state.childWorks),
//   与输入框旁 SessionChildWorkIcons 同源,零后端改动。
// - 交互:点击优先打开一个运行中的 subagent 详情(与图标组一致);
//   无可解析详情时退回运行时汇总面板。
// - 挂载:chat-app-view.tsx 两处头部,紧挨 GoalStatusBadgeBridge。
import { useMemo } from 'react'
import { useSessionChildWorks } from '../hooks/useSessionChildWorks.js'
import type { SessionChildWorkItem } from '../lib/session-reattach.js'
import {
  openSessionChildWorkDetail,
  pickActiveChildWork,
} from '../../lib/right-stage/open-session-child-work-detail.js'
import { openSessionRuntimeInRightStage } from '../../lib/right-stage/open-session-runtime-stage.js'

const KIND_LABELS: Record<string, string> = {
  subagent: '子代理',
  workflow: '工作流',
  collab_subtask: '工作流节点',
  duty: 'BOT',
  warm_bash: '会话终端',
}

function kindLabel(kind: string): string {
  return KIND_LABELS[String(kind || '').trim()] || String(kind || '任务')
}

export function ChildWorkRunningBadgeBridge(props: {
  sessionKey: string
}): React.JSX.Element | null {
  const sk = String(props.sessionKey || '').trim()
  const { works, openCount, activeByKind } = useSessionChildWorks(sk || null)

  const summary = useMemo(() => {
    const parts: string[] = []
    for (const [kind, list] of activeByKind) {
      if (list.length > 0) parts.push(`${kindLabel(kind)} ×${list.length}`)
    }
    return parts
  }, [activeByKind])

  if (!sk || openCount <= 0) return null
  const workItems = works as SessionChildWorkItem[]
  const subagentWork = pickActiveChildWork(workItems, 'subagent')

  const onClick = () => {
    const target = subagentWork || workItems[0]
    if (target && openSessionChildWorkDetail(target, sk)) return
    openSessionRuntimeInRightStage({
      sessionKey: sk,
      works: workItems,
      focusKind: subagentWork ? 'subagent' : String(activeByKind.keys().next().value || 'unknown'),
      forceExpand: true,
    })
  }

  const title = `运行中 ${openCount}:${summary.join('、') || '任务'}\n点击查看详情`

  return (
    <button
      type="button"
      className="react-chat-header-childwork-badge"
      title={title}
      onClick={onClick}
      data-count={openCount}
    >
      <span className="react-chat-header-childwork-badge-dot" aria-hidden="true" />
      <span className="react-chat-header-childwork-badge-label">
        {openCount} 个任务运行中
      </span>
    </button>
  )
}
