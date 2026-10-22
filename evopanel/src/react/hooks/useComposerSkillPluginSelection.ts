/**
 * Composer skill / plugin multi-select + session sticky persist + catalog load.
 * Extracted from ChatApp.tsx (P6 / P6c).
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { SkillSelection } from '../components/SkillPickerModal.js'
import type { PluginSelection } from '../components/PluginPickerModal.js'
import { loadSkillCatalog, subscribeSkillCatalog } from '../../lib/skill-catalog.js'
import { wsClient } from '../../lib/ws-client.js'
import { toast } from '../../components/toast.js'

export type PluginCatalogRow = {
  id: string
  name: string
  label: string
  description: string
  version?: string
  marketplace: string
  componentTypes?: string[]
  iconUrl?: string
  enabled?: boolean
}

type SkillPickerRow = {
  name: string
  label: string
  description: string
  icon: string
  enabled?: boolean
}

export function useComposerSkillPluginSelection(opts: { selectedSessionKey: string }) {
  const { selectedSessionKey } = opts

  const [bottomSkillOpen, setBottomSkillOpen] = useState(false)
  const [skillList, setSkillList] = useState<
    Array<{ name: string; label: string; description: string; icon: string; enabled?: boolean }>
  >([])
  const [skillListLoading, setSkillListLoading] = useState(false)
  const [selectedSkills, setSelectedSkills] = useState<SkillSelection[]>([])

  const persistSelectedSkills = useCallback(async (sk: string, skills: SkillSelection[]) => {
    const key = String(sk || '').trim()
    if (!key) return
    const names = skills.map((s) => String(s.name || '').trim()).filter(Boolean)
    try {
      const { api } = await import('../../lib/tauri-api.js')
      await api.chatUpdateContext(key, { preferred_skills: names })
    } catch {
      /* best-effort session sticky */
    }
  }, [])

  const removeSelectedSkill = useCallback(
    (name: string) => {
      setSelectedSkills((prev) => {
        const next = prev.filter((s) => s.name !== name)
        void persistSelectedSkills(String(selectedSessionKey || ''), next)
        return next
      })
    },
    [persistSelectedSkills, selectedSessionKey],
  )

  const addSelectedSkill = useCallback(
    (sk: { name: string; label: string; icon: string }) => {
      const name = String(sk.name || '').trim()
      if (!name) return
      setSelectedSkills((prev) => {
        if (prev.some((s) => s.name === name)) return prev
        const next = [...prev, { name, label: sk.label || name, icon: sk.icon || '🧩' }]
        void persistSelectedSkills(String(selectedSessionKey || ''), next)
        return next
      })
    },
    [persistSelectedSkills, selectedSessionKey],
  )

  const [bottomPluginPanelOpen, setBottomPluginPanelOpen] = useState(false)
  const [pluginPanelStyle, setPluginPanelStyle] = useState<CSSProperties | null>(null)
  const [pluginList, setPluginList] = useState<PluginCatalogRow[]>([])
  const [pluginListLoading, setPluginListLoading] = useState(false)
  const [selectedPlugins, setSelectedPlugins] = useState<PluginSelection[]>([])
  const [pluginComposerPillsVisible, setPluginComposerPillsVisible] = useState(false)

  const persistSelectedPlugins = useCallback(async (sk: string, plugins: PluginSelection[]) => {
    const key = String(sk || '').trim()
    if (!key) return
    const ids = plugins.map((p) => String(p.id || '').trim()).filter(Boolean)
    try {
      const { api } = await import('../../lib/tauri-api.js')
      await api.chatUpdateContext(key, { preferred_plugins: ids })
    } catch {
      /* best-effort session sticky */
    }
  }, [])

  const removeSelectedPlugin = useCallback(
    (id: string) => {
      setPluginComposerPillsVisible(true)
      setSelectedPlugins((prev) => {
        const next = prev.filter((p) => p.id !== id)
        void persistSelectedPlugins(String(selectedSessionKey || ''), next)
        return next
      })
    },
    [persistSelectedPlugins, selectedSessionKey],
  )

  const addSelectedPlugin = useCallback(
    (pl: { id: string; label: string; iconUrl?: string }) => {
      const id = String(pl.id || '').trim()
      if (!id) return
      setPluginComposerPillsVisible(true)
      setSelectedPlugins((prev) => {
        if (prev.some((p) => p.id === id)) return prev
        const next = [...prev, { id, label: pl.label || id, iconUrl: pl.iconUrl }]
        void persistSelectedPlugins(String(selectedSessionKey || ''), next)
        return next
      })
    },
    [persistSelectedPlugins, selectedSessionKey],
  )

  const refreshPluginCatalog = useCallback(async (force = false) => {
    setPluginListLoading(true)
    try {
      const { loadPluginCatalog } = await import('../../lib/plugin-catalog.js')
      const rows = await loadPluginCatalog({ enabledOnly: true, force })
      setPluginList(
        rows.map((p) => ({
          id: p.id,
          name: p.name,
          label: p.label,
          description: p.description || '',
          version: p.version,
          marketplace: p.marketplace,
          componentTypes: p.componentTypes,
          iconUrl: p.iconUrl,
        })),
      )
    } catch {
      setPluginList([])
    } finally {
      setPluginListLoading(false)
    }
  }, [])

  /** 全局技能目录（与技能管理页共用缓存，进入聊天时预拉取） */
  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => setSkillListLoading(true))
    const unsub = subscribeSkillCatalog((rows: SkillPickerRow[]) => {
      if (cancelled) return
      setSkillList(rows.filter((s) => s.enabled !== false))
      setSkillListLoading(false)
    })
    void loadSkillCatalog({ enabledOnly: true }).catch((e) => {
      if (cancelled) return
      toast(`技能列表加载失败：${(e as Error)?.message || e}`, 'error')
      setSkillListLoading(false)
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [])

  /** 会话级粘性技能：切换会话时从 context 恢复，与发送时 preferred_skills 一致 */
  useEffect(() => {
    const sk = String(selectedSessionKey || '').trim()
    if (!sk) {
      setSelectedSkills([])
      return
    }
    const ctx = wsClient.getSessionContext(sk) as {
      preferred_skills?: unknown
      preferred_skill?: unknown
    }
    let names: string[] = []
    if (Array.isArray(ctx?.preferred_skills)) {
      names = ctx.preferred_skills.map((s) => String(s || '').trim()).filter(Boolean)
    } else {
      const one = String(ctx?.preferred_skill || '').trim()
      if (one) names = [one]
    }
    if (!names.length) {
      setSelectedSkills([])
      return
    }
    setSelectedSkills(
      names.map((name) => {
        const hit = skillList.find((s) => s.name === name)
        return hit
          ? { name: hit.name, label: hit.label || hit.name, icon: hit.icon || '🧩' }
          : { name, label: name, icon: '🧩' }
      }),
    )
  }, [selectedSessionKey, skillList])

  /** 会话级粘性插件：切换会话时从 context 恢复；恢复不展示 pills */
  const pluginPillsSessionRef = useRef<string | null>(null)
  useEffect(() => {
    const sk = String(selectedSessionKey || '').trim()
    if (pluginPillsSessionRef.current !== sk) {
      pluginPillsSessionRef.current = sk
      setPluginComposerPillsVisible(false)
    }
    if (!sk) {
      setSelectedPlugins([])
      return
    }
    const ctx = wsClient.getSessionContext(sk) as { preferred_plugins?: unknown }
    if (!Array.isArray(ctx?.preferred_plugins)) {
      setSelectedPlugins([])
      return
    }
    const ids = ctx.preferred_plugins.map((s) => String(s || '').trim()).filter(Boolean)
    setSelectedPlugins((prev) =>
      ids.map((id) => {
        const cached = prev.find((p) => p.id === id && p.iconUrl)
        if (cached) return cached
        const hit = pluginList.find((p) => p.id === id)
        return {
          id,
          label: hit?.label || hit?.name || id.split('@')[0] || id,
          iconUrl: hit?.iconUrl,
        }
      }),
    )
  }, [selectedSessionKey, pluginList])

  /** 给已有的 selectedPlugins 反查 iconUrl（pluginList 异步到达后补齐） */
  useEffect(() => {
    if (pluginList.length === 0) return
    setSelectedPlugins((prev) => {
      let dirty = false
      const next = prev.map((p) => {
        if (p.iconUrl) return p
        const hit = pluginList.find((row) => row.id === p.id)
        if (!hit?.iconUrl) return p
        dirty = true
        return { ...p, iconUrl: hit.iconUrl, label: p.label || hit.label || hit.name }
      })
      return dirty ? next : prev
    })
  }, [pluginList])

  /** 进入对话即订阅/预加载插件目录（与技能目录同模式；点「+」不再现拉）。 */
  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => setPluginListLoading(true))
    let unsub = () => {}
    const toPickerItems = (rows: PluginCatalogRow[]) =>
      rows
        .filter((p) => p.enabled !== false)
        .map((p) => ({
          id: p.id,
          name: p.name,
          label: p.label,
          description: p.description || '',
          version: p.version,
          marketplace: p.marketplace,
          componentTypes: p.componentTypes,
          iconUrl: p.iconUrl,
        }))
    void import('../../lib/plugin-catalog.js').then((mod) => {
      if (cancelled) return
      unsub = mod.subscribePluginCatalog((rows: PluginCatalogRow[]) => {
        if (cancelled) return
        setPluginList(toPickerItems(rows))
        setPluginListLoading(false)
      })
      void mod.loadPluginCatalog({ enabledOnly: true }).catch(() => {
        if (cancelled) return
        setPluginList([])
        setPluginListLoading(false)
      })
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [])

  /** 粘性 selectedPlugins 只有 id 时，目录尚未到达则强制拉一次补齐 iconUrl。 */
  useEffect(() => {
    if (selectedPlugins.length === 0 || pluginList.length > 0 || pluginListLoading) return
    void refreshPluginCatalog()
  }, [selectedPlugins.length, pluginList.length, pluginListLoading, refreshPluginCatalog])

  return {
    bottomSkillOpen,
    setBottomSkillOpen,
    skillList,
    setSkillList,
    skillListLoading,
    setSkillListLoading,
    selectedSkills,
    setSelectedSkills,
    persistSelectedSkills,
    removeSelectedSkill,
    addSelectedSkill,
    bottomPluginPanelOpen,
    setBottomPluginPanelOpen,
    pluginPanelStyle,
    setPluginPanelStyle,
    pluginList,
    setPluginList,
    pluginListLoading,
    setPluginListLoading,
    selectedPlugins,
    setSelectedPlugins,
    pluginComposerPillsVisible,
    setPluginComposerPillsVisible,
    persistSelectedPlugins,
    removeSelectedPlugin,
    addSelectedPlugin,
    refreshPluginCatalog,
  }
}
