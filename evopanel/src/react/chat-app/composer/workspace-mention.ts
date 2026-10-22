// @ts-nocheck — mechanical P103 extract.
/**
 * Workspace @file / @skill / @plugin mention config. Extracted from ChatApp.tsx (P103).
 */
export type WorkspaceMentionCtx = Record<string, any>

export async function searchWorkspaceFilesForMention(
  ctx: WorkspaceMentionCtx,
  query: string,
): Promise<Array<{ path: string; name: string; detail: string }>> {
  const root = ctx.effectiveWorkspaceRoot
  const threadId = String(ctx.wsClient.getSessionThreadId(ctx.selectedSessionKey || '') || '').trim()
  if (!root && !threadId) return []
  const q = String(query || '').trim()
  if (!q) return []
  try {
    const { api } = await import('../../../lib/tauri-api.js')
    const data = await api.searchWorkspaceFiles(root, q, 15, threadId || undefined)
    return (Array.isArray(data?.files) ? data.files : [])
      .map((f: { path?: string; name?: string }) => {
        const path = String(f?.path || '').trim()
        if (!path) return null
        return {
          path,
          name: String(f?.name || ctx.basenameFromPath(path)),
          detail: '文件',
        }
      })
      .filter(
        (x: { path: string; name: string; detail: string } | null): x is {
          path: string
          name: string
          detail: string
        } => x != null,
      )
  } catch {
    return []
  }
}

export function buildWorkspaceMentionConfig(ctx: WorkspaceMentionCtx) {
  const root = ctx.effectiveWorkspaceRoot
  const threadId = String(ctx.wsClient.getSessionThreadId(ctx.selectedSessionKey || '') || '').trim()
  if (!root && !threadId) return undefined
  return {
    enabled: true,
    searchFiles: (query: string) => searchWorkspaceFilesForMention(ctx, query),
    onAttachFile: (entry: { path?: string; name?: string }) => {
      const path = String(entry.path || '').trim()
      if (!path) return
      ctx.setContextFiles((prev: Array<{ path: string }>) => {
        if (prev.some((x) => x.path === path)) return prev
        const next = [...prev, { path, name: entry.name || ctx.basenameFromPath(path) }]
        void ctx.persistContextFiles(next)
        return next
      })
      void import('../../components/toast.js').then(({ toast }) => {
        toast(`已附加：${entry.name || ctx.basenameFromPath(path)}（发送后注入 Agent 上下文）`, 'info')
      })
    },
    roles: ctx.proactiveRolesDisplay,
    // `/` 触发器：注入技能 + 插件的搜索目录。`addSelected*` 会把命中项追加到
    // `selectedSkills` / `selectedPlugins`，与加号面板的语义一致。
    skills: ctx.skillList,
    plugins: (ctx.pluginList || []).map((p: { id: string; label?: string; name?: string; iconUrl?: string; description?: string }) => ({
      id: p.id,
      label: p.label || p.name,
      iconUrl: p.iconUrl,
      description: p.description,
    })),
    onPickSkill: (sk: { label?: string }) => {
      ctx.addSelectedSkill(sk)
      void import('../../components/toast.js').then(({ toast }) => {
        toast(`已选技能：${sk.label}`, 'info')
      })
    },
    onPickPlugin: (pl: { label?: string }) => {
      ctx.addSelectedPlugin(pl)
      void import('../../components/toast.js').then(({ toast }) => {
        toast(`已选插件：${pl.label}`, 'info')
      })
    },
  }
}
