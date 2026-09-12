import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import AgentAvatar from './AgentAvatar'
import { useGatewayBaseUrl } from '../hooks/useGatewayBaseUrl'
import { formatAvatarForSave } from '../lib/agent-avatar'
import { DEFAULT_HEAD_BOX, matteImageFile } from '../lib/agent-matting'
import { agentAvatarPresetUrl, avatarMetaToWire, type AgentAvatarMetaWire } from '../lib/agent-avatar-meta'
import { api } from '../../lib/tauri-api.js'

export type AvatarPickerValue = {
  avatar: string | null
  avatar_meta?: AgentAvatarMetaWire | null
  previewUrl?: string | null
}

export type AgentAvatarPickerProps = {
  value: AvatarPickerValue
  onChange: (next: AvatarPickerValue) => void
  agentCode: string
  agentName?: string | null
  baseUrl?: string
  onUpload?: (file: Blob, meta: AgentAvatarMetaWire) => Promise<void>
}

type PresetRow = { id: string; label: string; url?: string }

const EMOJI_OPTIONS = [
  '✨', '🧭', '⌨️', '💻', '📂', '🤖',
  '🏗️', '📋', '🔨', '🔍', '🐞', '🛡️',
  '✍️', '👁️', '🎨', '🎬', '🎤', '🎞️',
  '🎮', '📐', '📢', '⚙️',
  '🛠', '🧩', '🚀', '🎯', '📊', '📝',
]

const AgentAvatarPicker: React.FC<AgentAvatarPickerProps> = ({
  value,
  onChange,
  agentCode,
  agentName,
  baseUrl: baseUrlProp = '',
  onUpload,
}) => {
  const { baseUrl } = useGatewayBaseUrl(baseUrlProp)
  const titleId = useId()
  const [draft, setDraft] = useState<AvatarPickerValue>(() => ({
    avatar: value.avatar ?? null,
    avatar_meta: value.avatar_meta ?? null,
    previewUrl: value.previewUrl ?? null,
  }))
  const [open, setOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [presets, setPresets] = useState<PresetRow[]>([])
  const [presetsLoaded, setPresetsLoaded] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setDraft({
      avatar: value.avatar ?? null,
      avatar_meta: value.avatar_meta ?? null,
      previewUrl: value.previewUrl ?? null,
    })
  }, [value.avatar, value.avatar_meta, value.previewUrl])

  useEffect(() => {
    if (!open || presetsLoaded) return
    let cancelled = false
    void api
      .listAvatarPresets()
      .then((rows: PresetRow[]) => {
        if (!cancelled) {
          setPresets(Array.isArray(rows) ? rows : [])
          setPresetsLoaded(true)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPresets([])
          setPresetsLoaded(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [open, presetsLoaded])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const applyChange = useCallback(
    (next: AvatarPickerValue) => {
      setDraft(next)
      onChange(next)
    },
    [onChange],
  )

  const pickEmoji = (emoji: string) => {
    applyChange({ avatar: formatAvatarForSave('emoji', emoji), avatar_meta: null, previewUrl: null })
    setOpen(false)
  }

  const pickPreset = (id: string) => {
    applyChange({ avatar: formatAvatarForSave('preset', id), avatar_meta: null, previewUrl: null })
    setOpen(false)
  }

  const clearAvatar = () => {
    applyChange({ avatar: null, avatar_meta: null, previewUrl: null })
    setOpen(false)
  }

  const onFile = useCallback(
    async (file: File | null) => {
      if (!file) return
      setUploading(true)
      try {
        const matte = await matteImageFile(file)
        const meta = avatarMetaToWire({
          aspect: matte.aspect,
          headBox: { ...DEFAULT_HEAD_BOX, h: DEFAULT_HEAD_BOX.w * matte.aspect },
        })
        if (onUpload) {
          await onUpload(matte.blob, meta)
        }
        const previewUrl = URL.createObjectURL(matte.blob)
        applyChange({ avatar: 'image', avatar_meta: meta, previewUrl })
        setOpen(false)
      } catch (e) {
        console.error('avatar upload failed', e)
        alert(`图片处理失败：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setUploading(false)
        if (fileRef.current) fileRef.current.value = ''
      }
    },
    [applyChange, onUpload],
  )

  const selectedPresetId =
    draft.avatar && String(draft.avatar).startsWith('preset:')
      ? String(draft.avatar).slice('preset:'.length)
      : ''

  const previewAgent = {
    agent_code: agentCode,
    agent_name: agentName,
    avatar: draft.avatar,
    avatar_meta: draft.avatar_meta,
    has_avatar_file: draft.avatar === 'image',
  }

  const sheet =
    open && typeof document !== 'undefined'
      ? createPortal(
          <div
            className="modal-overlay agent-avatar-picker-overlay"
            role="presentation"
            onClick={(e) => {
              if (e.target === e.currentTarget) setOpen(false)
            }}
          >
            <div
              className="agent-avatar-picker-sheet"
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              onClick={(e) => e.stopPropagation()}
            >
              <header className="agent-avatar-picker-sheet-head">
                <strong id={titleId}>更换头像</strong>
                <button
                  type="button"
                  className="agent-avatar-picker-sheet-close"
                  aria-label="关闭"
                  onClick={() => setOpen(false)}
                >
                  &times;
                </button>
              </header>

              <div className="agent-avatar-picker-sheet-preview">
                <AgentAvatar
                  agent={previewAgent}
                  agentCode={agentCode}
                  size={72}
                  baseUrl={baseUrl}
                  imageSrcOverride={draft.previewUrl ?? undefined}
                />
                <div className="agent-avatar-picker-sheet-preview-actions">
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    hidden
                    onChange={(ev) => void onFile(ev.target.files?.[0] ?? null)}
                  />
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={uploading}
                    onClick={() => fileRef.current?.click()}
                  >
                    {uploading ? '处理中…' : draft.avatar === 'image' ? '重新上传' : '上传图片'}
                  </button>
                  {draft.avatar ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost agent-avatar-picker-reset"
                      onClick={clearAvatar}
                    >
                      恢复默认
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="agent-avatar-picker-sheet-body">
                {presets.length > 0 ? (
                  <>
                    <p className="agent-avatar-picker-label">系统默认</p>
                    <div className="agent-avatar-picker-preset-grid" role="listbox" aria-label="系统默认头像">
                      {presets.map((p) => {
                        const active = selectedPresetId === p.id
                        const src = agentAvatarPresetUrl(baseUrl, p.id)
                        return (
                          <button
                            key={p.id}
                            type="button"
                            role="option"
                            aria-selected={active}
                            title={p.label || p.id}
                            className={`agent-avatar-picker-preset${active ? ' agent-avatar-picker-preset--active' : ''}`}
                            onClick={() => pickPreset(p.id)}
                          >
                            <img src={src} alt="" draggable={false} />
                            <span className="agent-avatar-picker-preset-label">{p.label || p.id}</span>
                          </button>
                        )
                      })}
                    </div>
                  </>
                ) : presetsLoaded ? null : (
                  <p className="form-hint" style={{ margin: 0 }}>
                    加载系统头像…
                  </p>
                )}

                <p className="agent-avatar-picker-label">Emoji</p>
                <div className="agent-avatar-picker-emoji-row">
                  {EMOJI_OPTIONS.map((e) => (
                    <button
                      key={e}
                      type="button"
                      className={`agent-avatar-picker-emoji${draft.avatar === `emoji:${e}` ? ' agent-avatar-picker-emoji--active' : ''}`}
                      onClick={() => pickEmoji(e)}
                    >
                      {e}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null

  return (
    <div className="agent-avatar-picker agent-avatar-picker--compact">
      <div className="agent-avatar-picker-summary">
        <button
          type="button"
          className="agent-avatar-picker-trigger"
          aria-haspopup="dialog"
          aria-expanded={open}
          title="更换头像"
          onClick={() => setOpen(true)}
        >
          <AgentAvatar
            agent={previewAgent}
            agentCode={agentCode}
            size={56}
            baseUrl={baseUrl}
            imageSrcOverride={draft.previewUrl ?? undefined}
          />
        </button>
        <div className="agent-avatar-picker-summary-actions">
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => setOpen(true)}>
            更换头像
          </button>
          {draft.avatar ? (
            <button type="button" className="btn btn-sm btn-ghost agent-avatar-picker-reset" onClick={clearAvatar}>
              恢复默认
            </button>
          ) : null}
        </div>
      </div>
      {sheet}
    </div>
  )
}

export default AgentAvatarPicker
