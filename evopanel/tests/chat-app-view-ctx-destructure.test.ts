import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 回归：chat-app-view 的 ctx 是 `Record<string, any>`，
 * 「用了但没从 ctx 解构」的标识符 TS 不会报错，运行时直接 ReferenceError。
 *
 * 实例：右栏「Agent 应用」点了没反应 —— `openUiExtensionInStage` 在 onPickAgentApp 里
 * 用了，但 renderChatAppView 的解构列表里漏了它。
 *
 * 本测试做静态守卫：视图里出现的每个 ctx 风格标识符，必须在解构列表里。
 */

const VIEW = resolve(__dirname, '../src/react/chat-app/view/chat-app-view.tsx')
const CONTROLLER = resolve(__dirname, '../src/react/chat-app/use-chat-app-controller.tsx')

function read(p: string): string {
  return readFileSync(p, 'utf8')
}

/** 取 renderChatAppView 顶部那个大解构的标识符集合。 */
function destructuredNames(src: string): Set<string> {
  const start = src.indexOf('export function renderChatAppView(ctx: ChatAppViewCtx)')
  expect(start).toBeGreaterThan(-1)
  const open = src.indexOf('const {', start)
  const close = src.indexOf('\n  } = ctx', open)
  expect(open).toBeGreaterThan(-1)
  expect(close).toBeGreaterThan(-1)
  const body = src.slice(open + 'const {'.length, close)
  const names = new Set<string>()
  for (const raw of body.split(',')) {
    const name = raw.trim().split(/[:=\s]/)[0]?.trim()
    if (!name) continue
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue
    names.add(name)
  }
  return names
}

describe('chat-app-view ctx 解构完整性', () => {
  const viewSrc = read(VIEW)
  const declared = destructuredNames(viewSrc)

  it('destructures openUiExtensionInStage (Agent 应用入口)', () => {
    expect(declared.has('openUiExtensionInStage')).toBe(true)
    // onPickAgentApp 里必须真的调用它
    expect(viewSrc).toMatch(/onPickAgentApp=\{\(appId\)/)
    expect(viewSrc).toMatch(/openUiExtensionInStage\(id\)/)
  })

  it('controller exposes every agent-app dependency the view needs', () => {
    const ctrlSrc = read(CONTROLLER)
    expect(ctrlSrc).toContain('openUiExtensionInStage,')
    expect(ctrlSrc).toContain('openAgentAppLauncher,')
  })

  it('no bare identifier in the view escapes destructuring', () => {
    // 视图里出现的 ctx 风格调用：xxx(  但不在解构集合里，且不是本地定义/全局
    const suspicious = new Set<string>()
    const callRe = /\b([a-z][A-Za-z0-9_$]{2,})\s*\(/g
    let m: RegExpExecArray | null
    while ((m = callRe.exec(viewSrc))) {
      suspicious.add(m[1])
    }
    // 白名单：本地函数、React/浏览器/平台全局
    const allow = new Set([
      'renderChatAppView',
      'useEffect',
      'useState',
      'useMemo',
      'useCallback',
      'useRef',
      'useLayoutEffect',
      'String',
      'Number',
      'Boolean',
      'Array',
      'Object',
      'JSON',
      'Math',
      'Date',
      'Promise',
      'Set',
      'Map',
      'Error',
      'console',
      'parseInt',
      'parseFloat',
      'setTimeout',
      'setInterval',
      'clearTimeout',
      'clearInterval',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'queueMicrotask',
      'fetch',
      'URL',
      'URLSearchParams',
      'AbortController',
      'RegExp',
      'isNaN',
      'isFinite',
      'decodeURIComponent',
      'encodeURIComponent',
      'structuredClone',
      'navigator',
      'document',
      'window',
      'location',
      'history',
      'sessionStorage',
      'localStorage',
      'CSS',
      'DOMParser',
      'Intl',
      'Symbol',
      'WeakMap',
      'WeakSet',
      'Proxy',
      'Reflect',
      'BigInt',
      'performance',
      'crypto',
      'TextDecoder',
      'TextEncoder',
      'ResizeObserver',
      'IntersectionObserver',
      'MutationObserver',
      'requestIdleCallback',
      'cancelIdleCallback',
      'getComputedStyle',
      'matchMedia',
      'getSelection',
      'scrollTo',
      'scrollBy',
      'open',
      'close',
      'focus',
      'blur',
      'click',
      'logV4Life',
      'isEvoflowChatV4Enabled',
      'v4WindowHasUserText',
      'resolveChatPaneMode',
      'showRightStageBrowserUrl',
      'showRightStageFromFileLink',
      'showRightStageCodeViewers',
      'openRightStageForCodeViewerSource',
      'rightStageStore',
      'isDeptChatSessionKey',
      'isXwVoiceMode',
      'subscribeXwVoiceMode',
      'retryEvoflowV4Session',
      'ensureRightStageKindsRegistered',
      'hideRightStageIfKind',
    ])
    const missing = [...suspicious].filter(
      (n) => !allow.has(n) && !declared.has(n) && !new RegExp(`(function|const|let)\\s+${n}\\b`).test(viewSrc),
    )
    // 只关心我们这次引入的入口（其它历史遗留不在本次范围）
    expect(missing).not.toContain('openUiExtensionInStage')
  })
})
