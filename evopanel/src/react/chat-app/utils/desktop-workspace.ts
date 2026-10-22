/**
 * Desktop / workspace helpers used by ChatApp chrome (pure + modal prompt).
 * Extracted from ChatApp.tsx module-top helpers (P0).
 */
import { showModal } from '../../../components/modal.js'

export function pathBasename(p: string): string {
  const s = String(p || '').trim()
  if (!s) return ''
  const noSlash = s.replace(/[\\/]+$/, '')
  const parts = noSlash.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || noSlash
}

/** @deprecated use pathBasename — kept for call-site parity during extract */
export const _pathBasename = pathBasename

export function isDesktopTauriRuntime(): boolean {
  return !!((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__)
}

/** WebView2：拖区须标在实际被命中的节点上 */
export const TAURI_HEADER_CELL_DRAG_PROPS = { 'data-tauri-drag-region': '' } as const

export function promptWorkspacePath(current: string): Promise<string> {
  return new Promise((resolve) => {
    showModal({
      title: '设置工作空间目录',
      width: 360,
      fields: [
        {
          name: 'path',
          label: '本机工作空间目录（绝对路径）',
          value: current || '',
          placeholder: '例如：D:\\work\\project',
          hint: '提示：Web 模式请手动输入绝对路径；桌面端可直接选择系统目录。',
        },
      ],
      onConfirm: (result: any) => {
        resolve(String(result?.path || '').trim())
      },
    })
  })
}

/** Thread panel / stream state expiry window. */
export const THREAD_STATE_EXPIRY_MS = 5 * 60 * 1000

export const QUICK_PROMPTS: Array<{ label: string; prompt: string }> = [
  { label: '开始创作', prompt: '开始创作：给我一个可直接执行的第一步方案，并附上下一步行动清单。' },
  {
    label: '文生视频',
    prompt:
      '请阅读 byted-ark-seedream-skill 与 media-production skill。你是制片：依次委派 screenwriter → visual-planner → artist → video-director，主题为[主题]。要求贴题、克制、镜头与口播衔接；每步验收 outputs/ 后再下一步；生图/生视频用 terminal 跑 provider 脚本。',
  },
  {
    label: '配音字幕短片',
    prompt:
      '请阅读 byted-ark-seedream-skill 与 media-production skill。你是制片：完整委派 screenwriter → visual-planner → artist → video-director → media-post，主题为[主题]。要求：贴题、克制不浮夸、画面与口播前后衔接、声画一致；每步验收 outputs/；主会话用 terminal 跑脚本，不要调用已废弃的 media_* 工具。',
  },
  { label: '写作', prompt: '撰写一篇关于[主题]的博客文章' },
  { label: '深入研究', prompt: '深入浅出的研究一下[主题]，并总结发现。' },
  { label: '收集', prompt: '从[来源]收集数据并创建报告。' },
  { label: '学习', prompt: '帮我学习[主题]：先给学习路线，再出练习题并批改。' },
  { label: '创建', prompt: '创建一个[类型]的作品：给方案、步骤和可交付物。' },
  { label: '创建角色', prompt: '我想新建一个能长期用的[类型]角色。' },
]

export function inferWriteStreamFormat(path: string): 'plain' | 'markdown' | 'code' {
  const lower = String(path || '').trim().toLowerCase()
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown'
  if (/\.(tsx?|jsx?|py|go|rs|java|cpp|c|h|css|scss|json|yaml|yml|toml|sh|sql)$/.test(lower)) {
    return 'code'
  }
  return 'plain'
}
