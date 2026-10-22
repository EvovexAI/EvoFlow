/**
 * Composer skill / plugin multi-select + session sticky persist.
 * Extracted from ChatApp.tsx (P6b). Catalog load effects for skills stay in ChatApp.
 */
import { useCallback, useState, type CSSProperties } from 'react'
import type { SkillSelection } from '../components/SkillPickerModal.js'
import type { PluginSelection } from '../components/PluginPickerModal.js'

export type PluginCatalogRow = {
  id: string
  name: string
  label: string
  description: string
  version?: string
  marketplace: string
  componentTypes?: string[]
  iconUrl?: string
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
