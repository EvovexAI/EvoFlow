import { useCallback, useEffect, useState } from 'react'
import { api } from '../../lib/tauri-api.js'
import { toast } from '../../components/toast.js'

type CatalogRow = {
  id?: string
  content?: string
  title?: string
  summary?: string
  kind?: string
  path?: string
  layer?: string
}

type Props = {
  workspaceRoot: string
}

/**
 * Project assets for the bound workspace — Asset Hub catalog (title + short summary).
 * SoT: ~/.evoflow/assets/workspaces/{ws-hash}/
 */
export function WorkspaceMemoryBlock({ workspaceRoot }: Props) {
  const root = String(workspaceRoot || '').trim()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [atoms, setAtoms] = useState<CatalogRow[]>([])
  const [standing, setStanding] = useState('')
  const [entityId, setEntityId] = useState('')
  const [hint, setHint] = useState('仅本工作区；目录行 10～30 字')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!root) {
      setAtoms([])
      setStanding('')
      setEntityId('')
      return
    }
    setLoading(true)
    try {
      const res = await api.getWorkspaceProjectMemory(root, { limit: 40 })
      setAtoms(Array.isArray(res?.atoms) ? res.atoms : [])
      setStanding(String(res?.standing || '').trim())
      setEntityId(String(res?.entityId || '').trim())
      if (res?.hint) setHint(String(res.hint))
    } catch (e) {
      setAtoms([])
      setStanding('')
      setEntityId('')
      toast(`加载项目资产失败: ${e}`, 'error')
    } finally {
      setLoading(false)
    }
  }, [root])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const onAdd = async () => {
    const content = draft.trim()
    if (!content || !root) return
    setBusy(true)
    try {
      await api.createWorkspaceProjectMemoryAtom({
        path: root,
        content,
        kind: 'convention',
        summary: content.slice(0, 30),
      })
      setDraft('')
      toast('已写入项目事实', 'success')
      await load()
    } catch (e) {
      toast(`添加失败: ${e}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  if (!root) return null

  const assetsHref = entityId
    ? `#/assets?entity=workspace:${encodeURIComponent(entityId)}`
    : '#/assets'

  return (
    <div className="ws-memory-block">
      <button
        type="button"
        className="ws-memory-block__toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>项目资产</span>
        <span className="ws-memory-block__count">{loading && !open ? '…' : atoms.length}</span>
      </button>
      {open ? (
        <div className="ws-memory-block__body">
          <p className="ws-memory-block__hint">{hint}</p>
          {standing ? <p className="ws-memory-block__standing">{standing}</p> : null}
          {loading ? <p className="memory-muted">加载中…</p> : null}
          {!loading && atoms.length === 0 ? (
            <p className="memory-muted">还没有项目事实。添加后写入 assets/workspaces/…</p>
          ) : null}
          <ul className="ws-memory-block__list">
            {atoms.map((a) => (
              <li key={a.id || a.path || a.content} className="ws-memory-block__item">
                <div className="ws-memory-block__text">
                  <span className="ws-memory-block__kind">{a.kind || 'fact'}</span>{' '}
                  <strong>{a.title || a.content || ''}</strong>
                  {a.summary && a.summary !== a.title ? (
                    <span className="ws-memory-block__summary"> — {a.summary}</span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          <div className="ws-memory-block__add">
            <input
              className="form-input"
              type="text"
              placeholder="添加项目约定，例如：默认用 pnpm"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void onAdd()
              }}
              disabled={busy}
            />
            <button type="button" className="btn btn-sm btn-primary" disabled={busy || !draft.trim()} onClick={() => void onAdd()}>
              添加
            </button>
          </div>
          <a className="ws-memory-block__link" href={assetsHref} title="打开资产中心">
            在资产中心查看全文 →
          </a>
        </div>
      ) : null}
    </div>
  )
}
