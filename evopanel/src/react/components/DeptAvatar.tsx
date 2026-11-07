/**
 * 部门头像：读 ``avatar`` 预设 id（``studio`` / ``engineering`` …），
 * 取 ``/api/proactive/departments/avatar-presets/{id}`` 图片。
 *
 * 与员工头像同一套视觉：圆角、``objectFit: cover``（见 AgentAvatar）。
 * 没有头像 / 加载失败 / id 非法时回落部门名首字，不留白、不抛错。
 */
import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { useGatewayBaseUrl } from '../hooks/useGatewayBaseUrl'
import { deptAvatarPresetUrl } from '../lib/agent-avatar-meta'

export type DeptAvatarProps = {
  /** ``evoflow_departments.avatar``（裸预设 id，可空） */
  avatar?: string | null
  /** 部门名，用于兜底首字 */
  name?: string | null
  size?: number
  className?: string
  title?: string
  baseUrl?: string
}

const PRESET_ID_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/

export function normalizeDeptAvatarId(raw?: string | null): string {
  let id = String(raw || '').trim().toLowerCase()
  if (id.startsWith('preset:')) id = id.slice('preset:'.length)
  return PRESET_ID_RE.test(id) ? id : ''
}

export function DeptAvatar({
  avatar,
  name,
  size = 28,
  className = '',
  title,
  baseUrl: baseUrlProp = '',
}: DeptAvatarProps) {
  const { baseUrl, ready } = useGatewayBaseUrl(baseUrlProp)
  const [imageFailed, setImageFailed] = useState(false)
  const presetId = normalizeDeptAvatarId(avatar)
  const src = presetId ? deptAvatarPresetUrl(baseUrl, presetId) : ''

  useEffect(() => {
    setImageFailed(false)
  }, [src])

  const wrapStyle: CSSProperties = {
    width: size,
    height: size,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    overflow: 'hidden',
    borderRadius: size <= 36 ? 10 : 12,
  }

  const showImage = Boolean(src) && !imageFailed && ready
  if (showImage) {
    return (
      <span
        className={`dept-avatar dept-avatar--image ${className}`.trim()}
        style={wrapStyle}
        title={title || name || presetId}
      >
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

  const initial = String(name || '').trim().slice(0, 1) || '部'
  return (
    <span
      className={`dept-avatar dept-avatar--initial ${className}`.trim()}
      style={{
        ...wrapStyle,
        background: 'var(--bg-secondary, #f4f4f5)',
        color: 'var(--text-secondary, #64748b)',
        fontWeight: 700,
        fontSize: Math.max(10, Math.floor(size * 0.42)),
      }}
      title={title || name || '部门'}
      aria-hidden={!title && !name}
    >
      {initial}
    </span>
  )
}

export default DeptAvatar
