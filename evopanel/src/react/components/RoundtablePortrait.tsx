/**
 * 圆桌专用肖像：圆形发言态 / 高腰胶囊 idle 态；
 * 有图用 AgentCustomImage，无图用统一 placeholder（禁止字母色球）。
 */
import React, { useEffect, useMemo, useState } from 'react'
import AgentCustomImage from './AgentCustomImage'
import { useGatewayBaseUrl } from '../hooks/useGatewayBaseUrl'
import {
  resolveAgentAvatar,
  type AgentAvatarAgent,
} from '../lib/agent-avatar'

export type RoundtablePortraitProps = {
  agent?: AgentAvatarAgent | null
  agentCode?: string | null
  name?: string | null
  size?: number
  /** shell 态高度；不传则按 size * 1.32 */
  height?: number
  className?: string
  speaking?: boolean
  host?: boolean
  /** circle=发言圆环；shell=高腰胶囊裁切半身 */
  variant?: 'circle' | 'shell'
}

function hashHue(seed: string): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return h % 360
}

/** 统一暗色玻璃肖像 placeholder（SVG data URI），按角色轻微变色 */
export function portraitPlaceholderSrc(seed: string, host = false, tall = false): string {
  const hue = host ? 268 : 210 + (hashHue(seed) % 80)
  const c1 = host ? '#7c3aed' : `hsl(${hue} 55% 42%)`
  const c2 = host ? '#312e81' : `hsl(${(hue + 40) % 360} 45% 22%)`
  const c3 = host ? '#1e1b4b' : '#0b1224'
  const skin = host ? '#c4b5fd' : `hsl(${(hue + 20) % 360} 28% 72%)`
  const w = tall ? 110 : 128
  const h = tall ? 145 : 128
  const cx = w / 2
  const headY = tall ? 48 : 46
  const bodyY = tall ? 118 : 96
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <radialGradient id="g" cx="34%" cy="28%" r="72%">
      <stop offset="0%" stop-color="${c1}" stop-opacity="0.98"/>
      <stop offset="52%" stop-color="${c2}"/>
      <stop offset="100%" stop-color="${c3}"/>
    </radialGradient>
    <linearGradient id="s" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fff" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#g)"/>
  <circle cx="${cx}" cy="${headY}" r="24" fill="${skin}" fill-opacity="0.55"/>
  <ellipse cx="${cx}" cy="${bodyY}" rx="36" ry="${tall ? 38 : 30}" fill="${skin}" fill-opacity="0.28"/>
  <ellipse cx="${cx}" cy="${headY - 12}" rx="26" ry="14" fill="${c1}" fill-opacity="0.35"/>
</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

const RoundtablePortrait: React.FC<RoundtablePortraitProps> = ({
  agent,
  agentCode,
  name,
  size = 76,
  height,
  className = '',
  speaking = false,
  host = false,
  variant = 'circle',
}) => {
  const { baseUrl, ready } = useGatewayBaseUrl('')
  const [failed, setFailed] = useState(false)
  const isShell = variant === 'shell'
  const w = size
  const h = isShell ? height ?? Math.round(size * 1.32) : size

  const code = String(agent?.agent_code ?? agentCode ?? '').trim()
  const displayName = String(agent?.agent_name ?? name ?? (code || 'host'))

  const resolved = useMemo(
    () =>
      resolveAgentAvatar(
        {
          agent_code: code,
          agent_name: displayName,
          avatar: agent?.avatar,
          avatar_meta: agent?.avatar_meta,
          has_avatar_file: agent?.has_avatar_file,
          avatar_rev: agent?.avatar_rev,
        },
        { baseUrl },
      ),
    [
      code,
      displayName,
      agent?.avatar,
      agent?.avatar_meta,
      agent?.has_avatar_file,
      agent?.avatar_rev,
      baseUrl,
    ],
  )

  const seed = code || displayName || 'host'
  const imageSrc = resolved.kind === 'image' ? resolved.src : ''

  useEffect(() => {
    setFailed(false)
  }, [imageSrc])

  const showImage = resolved.kind === 'image' && !!imageSrc && !failed && ready
  const showEmoji = resolved.kind === 'emoji' && !failed
  const wrapClass = [
    'ai-rt-portrait',
    isShell ? 'is-shell' : '',
    speaking ? 'is-speaking' : '',
    host ? 'is-host' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ')

  // shell 态不用 AgentCustomImage（其 bust 裁切会带圆角黑底，会从高腰壳底部露出来）
  const useCustomCrop = showImage && !isShell && resolved.kind === 'image' && !!resolved.meta

  return (
    <span className={wrapClass} style={{ width: w, height: h }} title={displayName}>
      {useCustomCrop && resolved.kind === 'image' && resolved.meta ? (
        <AgentCustomImage
          src={imageSrc}
          aspect={resolved.meta.aspect}
          headBox={resolved.meta.headBox}
          size={size}
          onError={() => setFailed(true)}
        />
      ) : showImage ? (
        <img
          src={imageSrc}
          alt=""
          draggable={false}
          className="ai-rt-portrait__img"
          onError={() => setFailed(true)}
        />
      ) : showEmoji ? (
        <>
          <img
            src={portraitPlaceholderSrc(seed, host, isShell)}
            alt=""
            draggable={false}
            className="ai-rt-portrait__img"
          />
          <span className="ai-rt-portrait__emoji">{resolved.emoji}</span>
        </>
      ) : (
        <img
          src={portraitPlaceholderSrc(seed, host, isShell)}
          alt=""
          draggable={false}
          className="ai-rt-portrait__img"
        />
      )}
    </span>
  )
}

export default RoundtablePortrait
