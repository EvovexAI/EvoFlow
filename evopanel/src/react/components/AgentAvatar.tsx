import React, { useEffect, useState } from 'react'
import AgentCustomImage from './AgentCustomImage'
import { useGatewayBaseUrl } from '../hooks/useGatewayBaseUrl'
import { resolveAgentAvatar, resolveInitial, hashColor, type AgentAvatarAgent } from '../lib/agent-avatar'

export type AgentAvatarProps = {
  agent?: AgentAvatarAgent | null
  agentCode?: string | null
  size?: number
  busy?: boolean
  /** Gateway origin. When omitted/empty, resolved via `getGatewayBaseUrl()` (required for Tauri). */
  baseUrl?: string
  className?: string
  title?: string
  /** Local blob URL while previewing an upload before save. */
  imageSrcOverride?: string
}

const AgentAvatar: React.FC<AgentAvatarProps> = ({
  agent,
  agentCode,
  size = 40,
  busy,
  baseUrl: baseUrlProp = '',
  className = '',
  title,
  imageSrcOverride,
}) => {
  const { baseUrl, ready } = useGatewayBaseUrl(baseUrlProp)
  const [imageFailed, setImageFailed] = useState(false)

  const merged: AgentAvatarAgent = {
    ...agent,
    agent_code: agent?.agent_code ?? agentCode ?? undefined,
  }
  const resolved = resolveAgentAvatar(merged, { baseUrl })
  const wrapStyle: React.CSSProperties = {
    width: size,
    height: size,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    overflow: 'hidden',
    borderRadius: size <= 36 ? 10 : 12,
  }

  // Reset broken-image state when the resolved src changes.
  const imageSrc = resolved.kind === 'image' ? imageSrcOverride || resolved.src : ''
  useEffect(() => {
    setImageFailed(false)
  }, [imageSrc])

  if (resolved.kind === 'emoji') {
    const fontSize = Math.floor(size * 0.55)
    return (
      <span
        className={`agent-avatar agent-avatar--emoji ${className}`.trim()}
        style={{ ...wrapStyle, background: 'var(--bg-secondary, #f4f4f5)', fontSize }}
        title={title}
      >
        {resolved.emoji}
      </span>
    )
  }

  const src = imageSrc
  // Relative `/api/...` works same-origin without waiting for Gateway base.
  // Waiting + falling through to「首字母」会造成岗位页头像「闪一下又变回来」。
  const srcOkWithoutBase =
    Boolean(imageSrcOverride) ||
    (Boolean(src) && (src.startsWith('/') || /^https?:\/\//i.test(src)))
  const showImage =
    resolved.kind === 'image' && !imageFailed && (ready || srcOkWithoutBase)

  if (showImage && resolved.kind === 'image' && resolved.meta) {
    return (
      <span className={`agent-avatar agent-avatar--image ${className}`.trim()} style={wrapStyle} title={title}>
        <AgentCustomImage
          src={src}
          aspect={resolved.meta.aspect}
          headBox={resolved.meta.headBox}
          size={size}
          busy={busy}
          onError={() => setImageFailed(true)}
        />
      </span>
    )
  }

  if (showImage && resolved.kind === 'image') {
    return (
      <span className={`agent-avatar agent-avatar--image ${className}`.trim()} style={wrapStyle} title={title}>
        <img
          src={src}
          alt=""
          style={{ width: size, height: size, objectFit: 'cover', borderRadius: wrapStyle.borderRadius }}
          draggable={false}
          onError={() => setImageFailed(true)}
        />
      </span>
    )
  }

  // 已判定是图片、只是 Gateway base 还在解析：占位，不要先画首字母再切图。
  if (resolved.kind === 'image' && !imageFailed) {
    return (
      <span
        className={`agent-avatar agent-avatar--pending ${className}`.trim()}
        style={{
          ...wrapStyle,
          background: 'var(--bg-secondary, #f4f4f5)',
        }}
        title={title}
        aria-hidden="true"
      />
    )
  }

  // Initial fallback（真·无头像，或图片加载失败后）。
  const initial =
    resolved.kind === 'initial'
      ? resolved.initial
      : resolveInitial(merged)
  const bg = resolved.kind === 'initial' ? resolved.bg : hashColor(String(merged.agent_name || merged.agent_code || '?'))
  const fontSize = Math.floor(size * 0.42)
  return (
    <span
      className={`agent-avatar agent-avatar--initial ${className}`.trim()}
      style={{
        ...wrapStyle,
        background: bg,
        color: '#fff',
        fontWeight: 700,
        fontSize,
        boxShadow: busy ? '0 0 0 2px rgba(99, 102, 241, 0.35)' : undefined,
      }}
      title={title}
    >
      {initial}
    </span>
  )
}

export default AgentAvatar
