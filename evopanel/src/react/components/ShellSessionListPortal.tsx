import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ShellSessionList, type ShellSessionListProps } from './ShellSessionList.js'

const SHELL_CHAT_PANEL_ID = 'shell-chat-panel'

function resolveShellChatPanelHost(): HTMLElement | null {
  return document.getElementById(SHELL_CHAT_PANEL_ID)
}

/** 侧栏会话列表：挂载于 #shell-chat-panel，与 ChatApp 同一 React 树 */
export function ShellSessionListPortal(props: ShellSessionListProps) {
  const [host, setHost] = useState<HTMLElement | null>(resolveShellChatPanelHost)

  useEffect(() => {
    if (host?.isConnected) return
    queueMicrotask(() => setHost(resolveShellChatPanelHost()))
  }, [host])

  useEffect(() => {
    return () => {
      resolveShellChatPanelHost()?.replaceChildren()
    }
  }, [])

  if (!host) return null
  return createPortal(<ShellSessionList {...props} />, host)
}
