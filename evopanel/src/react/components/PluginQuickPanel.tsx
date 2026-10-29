import { useEffect, useMemo, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import '@/styles-bridge.css'
import { resolvePluginIconSource } from '@/lib/pluginIconSource.js'
import { blog } from '../../lib/browser-unified-log.js'
import type { PluginPickerItem } from './PluginPickerModal.js'

/**
 * 聊天「+」快捷面板 — ZCode ChatPromptActionMenu 排版复刻（EvoFlow 品牌）：
 *   「添加」节：附件 / 图片；
 *   「插件」节：小图标 + 名称 + 内联描述的窄行（即点即存）；
 *   「能力」节：技能 / 目标 / 员工 / 语音播报 / 思考与记忆等；
 *   底部提示条：@ 添加上下文 · / 选择能力 · $ 选择技能。
 */

interface RowAction {
  key: string
  label: string
  /** 可省略：省略时不渲染图标占位（用于纯文案行） */
  icon?: ReactNode
  run: () => void
  trailing?: ReactNode
}

/** 额外能力/区段：宿主（如工作台首页）注入自身特有行；主对话不传即完全不变 */
export interface PluginQuickPanelExtraSection {
  title: string
  rows: RowAction[]
}

export function PluginQuickPanel({
  open,
  onClose,
  style,
  plugins,
  loading,
  selected,
  onToggle,
  onPickDocs,
  onPickImages,
  onOpenSkillPicker,
  onOpenGoal,
  onOpenRolePicker,
  onOpenLegacyMenu,
  onInsertText,
  showVoice,
  voiceOn,
  onToggleVoice,
  showRole = false,
  showLegacyMenu = true,
  showHintBar = true,
  onPickEmployee,
  extraAbilityRows,
  extraSections,
}: {
  open: boolean
  onClose: () => void
  style?: CSSProperties | null
  plugins: PluginPickerItem[]
  loading: boolean
  selected: Array<{ id: string; label: string }>
  onToggle: (item: PluginPickerItem) => void
  onPickDocs: () => void
  onPickImages: () => void
  onOpenSkillPicker: () => void
  onOpenGoal: () => void
  /** 仅 showRole 时需要；主对话默认不展示预设角色 */
  onOpenRolePicker?: () => void
  onOpenLegacyMenu: () => void
  onInsertText: (text: string) => void
  showVoice: boolean
  voiceOn: boolean
  onToggleVoice: () => void
  /** 「预设角色」行开关（主对话固定主智能体，默认隐藏；其他 Agent 走员工会话） */
  showRole?: boolean
  /** 「思考与记忆…」遗留更多菜单行开关（首页可隐藏） */
  showLegacyMenu?: boolean
  /** 底部 @ / / / $ 提示条开关（首页输入框无这些触发器时隐藏） */
  showHintBar?: boolean
  /** 提供「员工」行的自定义行为（默认向输入框插入 @）；首页传打开智能体选择 */
  onPickEmployee?: () => void
  /** 追加进「能力」节的行（如首页的「记忆」开关） */
  extraAbilityRows?: RowAction[]
  /** 「能力」之后追加的独立区段 */
  extraSections?: PluginQuickPanelExtraSection[]
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target : null
      if (!target) return
      if (target.closest('[data-plugin-quick-panel], .react-chat-icon-attach-btn')) return
      onClose()
    }
    document.addEventListener('click', onDown)
    return () => document.removeEventListener('click', onDown)
  }, [open, onClose])

  const selectedIds = useMemo(() => new Set(selected.map((p) => p.id)), [selected])

  if (!open || typeof document === 'undefined') return null

  const addRows: RowAction[] = [
    {
      key: 'docs',
      label: '附件',
      icon: (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
      ),
      run: () => { onClose(); onPickDocs() },
    },
    {
      key: 'images',
      label: '图片',
      icon: (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="M21 15l-5-5L5 21" />
        </svg>
      ),
      run: () => { onClose(); onPickImages() },
    },
  ]

  const abilityRows: RowAction[] = [
    {
      key: 'skill',
      label: '技能',
      icon: (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 2l1.2 4.5L18 8l-4.8 1.5L12 14l-1.2-4.5L6 8l4.8-1.5L12 2z" />
          <path d="M19 14l.8 2.8L23 18l-3.2 1.2L19 22l-.8-2.8L15 18l3.2-1.2L19 14z" />
        </svg>
      ),
      run: () => { onClose(); onOpenSkillPicker() },
    },
    {
      key: 'goal',
      label: '目标',
      icon: (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
      ),
      run: () => { onClose(); onOpenGoal() },
    },
    {
      key: 'employee',
      label: '员工',
      icon: (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
        </svg>
      ),
      run: () => {
        onClose()
        if (onPickEmployee) onPickEmployee()
        else onInsertText('@')
      },
    },
    ...(showRole
      ? [
          {
            key: 'role',
            label: '预设角色',
            icon: (
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" />
              </svg>
            ),
            run: () => { onClose(); onOpenRolePicker?.() },
          } as RowAction,
        ]
      : []),
    ...(showVoice
      ? [
          {
            key: 'voice',
            label: voiceOn ? '语音播报 · 已开启' : '语音播报',
            icon: (
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M11 5L6 9H2v6h4l5 4V5z" />
                <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
              </svg>
            ),
            run: () => { onToggleVoice() },
            trailing: voiceOn ? (
              <span className="rounded-full bg-foreground/10 px-1.5 py-0.5 text-[10px] leading-4 text-foreground">开</span>
            ) : undefined,
          } as RowAction,
        ]
      : []),
    ...(showLegacyMenu
      ? [
          {
            key: 'legacy',
            label: '思考与记忆…',
            icon: (
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <circle cx="5" cy="12" r="1" />
                <circle cx="12" cy="12" r="1" />
                <circle cx="19" cy="12" r="1" />
              </svg>
            ),
            run: () => { onClose(); onOpenLegacyMenu() },
          } as RowAction,
        ]
      : []),
    ...(extraAbilityRows || []),
  ]

  const renderSection = (title: string, rows: Array<{ key: string; node: ReactNode }>) => (
    <div className="px-1.5 pb-1">
      <div className="px-2 pb-1 pt-2.5 text-ui-xs font-semibold tracking-wide text-foreground-subtle">
        {title}
      </div>
      {rows.map((row) => (
        <div key={row.key}>{row.node}</div>
      ))}
    </div>
  )

  const renderAbilityRow = (row: RowAction) => (
    <button
      type="button"
      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left transition-colors duration-100 hover:bg-hover"
      onClick={row.run}
    >
      {row.icon ? (
        <span className="flex-none text-foreground-subtle" aria-hidden>
          {row.icon}
        </span>
      ) : null}
      <span className="text-ui-sm font-medium text-foreground">{row.label}</span>
      {row.trailing}
    </button>
  )

  return createPortal(
    <div
      data-plugin-quick-panel
      className="zcode-bridge-root flex flex-col overflow-hidden rounded-2xl border border-border bg-background text-foreground shadow-2xl"
      style={{ ...(style || {}), width: 560, maxWidth: '94vw' }}
    >
      <div className="max-h-[56vh] overflow-y-auto px-1.5 py-1.5">
        {/* ── 添加 ── */}
        {renderSection(
          '添加',
          addRows.map((row) => ({
            key: row.key,
            node: (
              <button
                type="button"
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left transition-colors duration-100 hover:bg-hover"
                onClick={row.run}
              >
                <span className="flex-none text-foreground-subtle" aria-hidden>
                  {row.icon}
                </span>
                <span className="text-ui-sm font-medium text-foreground">{row.label}</span>
              </button>
            ),
          })),
        )}

        {/* ── 插件 ── */}
        {renderSection(
          '插件',
          loading
            ? [{ key: 'loading', node: <div className="px-2.5 py-2 text-ui-sm text-foreground-subtle">加载中…</div> }]
            : plugins.length === 0
              ? [{
                  key: 'empty',
                  node: (
                    <div className="px-2.5 py-2 text-ui-sm text-foreground-subtle">
                      暂无已启用插件 — 设置 → 插件市场安装
                    </div>
                  ),
                }]
              : plugins.map((p) => {
                  const active = selectedIds.has(p.id)
                  return {
                    key: p.id,
                    node: (
                      <button
                        type="button"
                        className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left transition-colors duration-100 ${
                          active ? 'bg-selected' : 'hover:bg-hover'
                        }`}
                        onClick={() => {
                          // 即点即存（与说明文案一致），选完一项自动收起面板，
                          // 避免浮层继续遮挡下方输入框。如果将来需要连选，
                          // 这里接 Ctrl/Cmd 修饰键维持开启即可。
                          blog(
                            'info',
                            `[plugin-panel] toggle id=${p.id} turning ${selectedIds.has(p.id) ? 'off' : 'on'}`,
                          )
                          onToggle(p)
                          if (!selectedIds.has(p.id)) onClose()
                        }}
                        title={p.description}
                      >
                        <span
                          className="flex h-5 w-5 flex-none items-center justify-center overflow-hidden"
                          aria-hidden
                        >
                          {(() => {
                            // 与 ZCode UI 同一图标解析链：打包官方图标优先，其次受信 CDN 图标
                            const resolved = resolvePluginIconSource(p.id, p.iconUrl)
                            return resolved ? (
                              <img src={resolved} alt="" className="h-[18px] w-[18px] object-contain" />
                            ) : (
                              <span className="flex h-[18px] w-[18px] items-center justify-center rounded bg-hover text-[10px]">
                                🧩
                              </span>
                            )
                          })()}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-ui-sm">
                          <span className="font-medium text-foreground">{p.label || p.name}</span>
                          {p.description ? (
                            <span className="ml-2 text-foreground-subtle">{p.description}</span>
                          ) : null}
                        </span>
                        {active ? (
                          <span className="flex-none text-ui-xs text-foreground-subtle">已选</span>
                        ) : null}
                      </button>
                    ),
                  }
                }),
        )}

        {/* ── 能力 ── */}
        {renderSection(
          '能力',
          abilityRows.map((row) => ({
            key: row.key,
            node: renderAbilityRow(row),
          })),
        )}

        {/* ── 宿主注入区段 ── */}
        {(extraSections || []).map((section) =>
          renderSection(
            section.title,
            section.rows.map((row) => ({ key: row.key, node: renderAbilityRow(row) })),
          ),
        )}
      </div>

      {/* ── 底部提示条 ── */}
      {showHintBar ? (
      <div className="flex items-center gap-4 border-t border-border/70 px-3.5 py-2 text-ui-sm text-foreground-subtle">
        <button
          type="button"
          className="flex items-center gap-1.5 transition-colors hover:text-foreground"
          onClick={() => { onInsertText('@'); onClose() }}
        >
          <span className="flex h-[18px] w-[18px] items-center justify-center rounded border border-border text-[10px]">@</span>
          添加上下文
        </button>
        <button
          type="button"
          className="flex items-center gap-1.5 transition-colors hover:text-foreground"
          onClick={() => { onInsertText('/'); onClose() }}
        >
          <span className="flex h-[18px] w-[18px] items-center justify-center rounded border border-border text-[10px]">/</span>
          选择能力
        </button>
        <button
          type="button"
          className="flex items-center gap-1.5 transition-colors hover:text-foreground"
          onClick={() => { onClose(); onOpenSkillPicker() }}
        >
          <span className="flex h-[18px] w-[18px] items-center justify-center rounded border border-border text-[10px]">$</span>
          选择技能
        </button>
        <span className="ml-auto hidden items-center gap-1.5 md:flex" title="在主输入框输入 / 可搜索技能与插件；输入 @ 选择员工；输入 # 选择工作区文件">
          <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full border border-border text-[9px]">ⓘ</span>
          <span className="hidden lg:inline">主框输入 / 搜索</span>
        </span>
      </div>
      ) : null}
    </div>,
    document.body,
  )
}
