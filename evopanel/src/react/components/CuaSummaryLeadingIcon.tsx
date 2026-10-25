/**
 * LEGACY · 主对话已停用：旧版 ToolCallList CUA 摘要图标。可见聊天改 zcode-ui renderers/cua。
 * 默认产品聊天是 V4（display.kind=cua），修可见电脑控制图标勿只改这里。
 * 取不到图标时回退 ToolCardIcon。
 */
import { useEffect, useState } from 'react'
import { apiUrlAsync } from '../../lib/api-client.js'
import { evoflowCuaAppKeyToIconRequest } from '../../lib/chat-normalize.js'
import { ToolCardIcon } from './ToolCardIcon.js'

export function CuaSummaryLeadingIcon({
  appKey,
  appName,
  toolKind,
  running = false,
}: {
  appKey?: string
  appName?: string
  toolKind: string
  running?: boolean
}) {
  const [iconSrc, setIconSrc] = useState('')
  const key = String(appKey || '').trim()
  const name = String(appName || '').trim() || key || '目标应用'

  useEffect(() => {
    let active = true
    setIconSrc('')
    if (!key) return () => undefined
    const request = evoflowCuaAppKeyToIconRequest(key)
    if (!request) return () => undefined
    void (async () => {
      let ok = false
      try {
        const response = await fetch(await apiUrlAsync('/cua/app-icon'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        })
        if (!response.ok) return
        const result = (await response.json()) as { iconDataUrl?: string } | null
        if (active && result?.iconDataUrl) {
          setIconSrc(result.iconDataUrl)
          ok = true
        }
      } catch {
        /* 回退扳手 */
      } finally {
        void import('../lib/stream-compare-file-log.js')
          .then((mod) =>
            mod.logCuaPanelDisplay(`icon-summary app=${name} key=${key} ${ok ? 'ok' : 'miss'}`),
          )
          .catch(() => undefined)
      }
    })()
    return () => {
      active = false
    }
  }, [key, name])

  if (iconSrc) {
    return (
      <img
        className="evf-tcard-icon evf-tcard-icon--cua-app"
        src={iconSrc}
        alt={name}
        title={name}
        width={16}
        height={16}
        draggable={false}
      />
    )
  }
  return <ToolCardIcon toolKind={toolKind} running={running} />
}
