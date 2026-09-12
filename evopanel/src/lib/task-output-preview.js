/**
 * Preview a task output file using the shared chat WorkspaceFilePreviewModal.
 * Always prefers the employee role's bound workspace_path — never thread sandboxes.
 */
import { api } from './tauri-api.js'
import { toast } from '../components/toast.js'
import { extractOutputPathFields } from './task-summary.js'
import { openWorkspaceFilePreviewModal } from './mount-workspace-file-preview.js'
import { healStrippedAbsolutePath, isAbsoluteHostPath, cleanHostPath, toNativeHostPath } from './workspace-abs-path.js'

function sanitizePreviewPath(raw, workspaceRoot) {
  const extracted = extractOutputPathFields(cleanHostPath(raw))
  const path = cleanHostPath(extracted.path || raw || '')
  if (!path) return ''
  return healStrippedAbsolutePath(path, workspaceRoot)
}

function joinRootRel(root, rel) {
  const r = cleanHostPath(root).replace(/[\\/]+$/, '')
  const p = cleanHostPath(rel).replace(/^[/\\]+/, '')
  if (!r || !p) return cleanHostPath(rel)
  return `${r}/${p}`.replace(/\\/g, '/')
}

/** Candidate workspace roots for relative deliverables (app demos, panel, runtime). */
async function collectOutputRootCandidates(hintRoot) {
  const out = []
  const push = (v) => {
    const s = cleanHostPath(v).replace(/\\/g, '/').replace(/\/+$/, '')
    if (s && !out.includes(s)) out.push(s)
  }
  push(hintRoot)
  try {
    const { getPanelSettingsSync } = await import('./panel-settings.js')
    push(getPanelSettingsSync()?.localWorkspaceRoot)
  } catch {
    /* ignore */
  }
  try {
    const info = await api.workspaceRuntimeInfo()
    push(info?.configuredRoot)
    push(info?.workspaceRoot)
    push(info?.root)
  } catch {
    /* ignore */
  }
  // Common unattended app-run workspace used by ops-copy demos.
  for (const base of out.slice()) {
    push(`${base}/demos/ops-copy-workflows/runs/workspace`)
    push(`${base}/runs/workspace`)
    const parent = base.replace(/\/[^/]+$/, '')
    if (parent && parent !== base) {
      push(`${parent}/demos/ops-copy-workflows/runs/workspace`)
    }
  }
  return out
}

async function probeAbsolutePath(candidate) {
  const path = cleanHostPath(candidate).replace(/\\/g, '/')
  if (!path) return ''
  try {
    const info = await api.resolveWorkspacePath(path)
    const resolved = cleanHostPath(info?.resolved || path).replace(/\\/g, '/')
    if (info?.exists === false) return ''
    if (resolved) return resolved
  } catch {
    /* ignore */
  }
  // Desktop reveal can still succeed even if resolve endpoint is unavailable.
  if (isAbsoluteHostPath(path)) return path
  return ''
}

/** ``…/threads/<id>/user-data/workspace`` is a chat sandbox, not an employee workspace. */
export function isThreadSandboxWorkspacePath(path) {
  const s = String(path || '').replace(/\\/g, '/').toLowerCase()
  return /\/threads\/[^/]+\/user-data(\/|$)/.test(s)
}

/** Infer employee agent_code from ``docs/roles/<code>/…`` deliverable paths. */
export function agentCodeFromRoleOutputPath(path) {
  const m = String(path || '')
    .replace(/\\/g, '/')
    .match(/(?:^|\/)docs\/roles\/([^/]+)\//i)
  return m ? String(m[1] || '').trim() : ''
}

async function workspaceOfAgentCode(agentCode) {
  const code = String(agentCode || '').trim()
  if (!code) return ''
  try {
    const role = await api.proactiveGetRole(code)
    return String(role?.config?.workspace_path || role?.workspace_path || '').trim()
  } catch {
    return ''
  }
}

/**
 * Resolve the host folder that contains role deliverables (e.g. docs/roles/…).
 * Priority: explicit role workspace → agent_code role → path-inferred role → panel root.
 * Never falls back to LangGraph thread sandboxes from ``listWorkspaces``.
 */
export async function resolvePreviewWorkspaceRoot(opts = {}) {
  const explicit = String(opts.workspaceRoot || '').trim()
  if (explicit && !isThreadSandboxWorkspacePath(explicit)) return explicit

  const codes = []
  const push = (c) => {
    const v = String(c || '').trim()
    if (v && !codes.includes(v)) codes.push(v)
  }
  push(opts.agentCode)
  push(agentCodeFromRoleOutputPath(opts.path))

  for (const code of codes) {
    const ws = await workspaceOfAgentCode(code)
    if (ws && !isThreadSandboxWorkspacePath(ws)) return ws
  }

  try {
    const { getPanelSettingsSync } = await import('./panel-settings.js')
    const fromPanel = String(getPanelSettingsSync()?.userWorkspaceRoot || '').trim()
    if (fromPanel && !isThreadSandboxWorkspacePath(fromPanel)) return fromPanel
  } catch {
    /* ignore */
  }

  try {
    const info = await api.workspaceRuntimeInfo()
    const root = String(info?.configuredRoot || info?.workspaceRoot || info?.root || '').trim()
    if (root && !isThreadSandboxWorkspacePath(root)) return root
  } catch {
    /* ignore — browser / no Tauri */
  }

  return ''
}

function formatPreviewErrorMessage(err, path = '') {
  const msg = String(err?.message || err || '无法预览')
  if (/file not found/i.test(msg)) {
    const p = cleanHostPath(path).replace(/\\/g, '/')
    return p
      ? `文件尚未生成或路径不正确：\n${p}\n\n请确认自动化任务已成功执行并写入交付文件，或稍后重试。`
      : '文件尚未生成或路径不正确。请确认任务已成功执行并写入交付文件。'
  }
  if (msg.includes('Not Found') && !msg.includes('file not found')) {
    return '预览暂不可用，请稍后重试'
  }
  return msg
}

async function probeOutputFileExists(path, opts = {}) {
  const hintRoot = cleanHostPath(opts.workspaceRoot || '')
  let candidate = sanitizePreviewPath(path, hintRoot)
  if (!candidate) return false
  if (/^https?:\/\//i.test(candidate)) return true

  try {
    candidate = await resolveTaskOutputAbsolutePath({
      path: candidate,
      workspaceRoot: opts.workspaceRoot,
      agentCode: opts.agentCode,
    })
  } catch {
    /* fall through — may still resolve via roots below */
  }

  if (isAbsoluteHostPath(candidate)) {
    const probed = await probeAbsolutePath(candidate)
    if (probed) return true
  }

  const roots = await collectOutputRootCandidates(
    (await resolvePreviewWorkspaceRoot({
      workspaceRoot: opts.workspaceRoot,
      agentCode: opts.agentCode,
      path: candidate,
    })) || hintRoot,
  )
  for (const root of roots) {
    try {
      const rel = isAbsoluteHostPath(candidate)
        ? candidate.replace(/\\/g, '/').replace(new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?`, 'i'), '')
        : candidate
      const info = await api.resolveWorkspaceTarget(root, rel)
      if (info?.exists === true) return true
    } catch {
      /* ignore */
    }
  }
  return false
}

/**
 * Probe output cards and mark missing deliverables (automation UX).
 * @param {ParentNode} root
 * @param {{ workspaceRoot?: string, agentCode?: string }} [opts]
 */
export async function enrichOutputCardsExistence(root, opts = {}) {
  if (!root?.querySelectorAll) return
  const rows = root.querySelectorAll('.td-output-row[data-path-for-existence]')
  await Promise.all(
    Array.from(rows).map(async (row) => {
      const path = row.getAttribute('data-path-for-existence') || ''
      const badge = row.querySelector('[data-role="existence-badge"]')
      if (!path) return
      let exists = false
      try {
        exists = await probeOutputFileExists(path, opts)
      } catch {
        exists = false
      }
      row.classList.toggle('is-missing', !exists)
      row.classList.toggle('is-ready', exists)
      if (badge) {
        badge.textContent = exists ? '已生成' : '未生成'
        badge.classList.toggle('td-output-badge--ready', exists)
        badge.classList.toggle('td-output-badge--missing', !exists)
        badge.classList.remove('td-output-badge--pending')
      }
    }),
  )
}

function fileBasename(path) {
  const parts = String(path || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
  return parts[parts.length - 1] || path
}

/**
 * Preview a task output file using the shared chat WorkspaceFilePreviewModal.
 * Always prefers the employee role's bound workspace_path — never thread sandboxes.
 * Absolute host paths are healed (drive-stripped ``:/…``) then passed through — never re-joined to root.
 */
export async function showTaskOutputPreview(opts = {}) {
  const title = String(opts.title || '').trim()
  const hintRoot = String(opts.workspaceRoot || '').trim()
  let path = sanitizePreviewPath(opts.path, hintRoot)
  // Agents often leave JSON-ish blobs in value — peel to a clean file path.
  try {
    const { extractOutputPathFields } = await import('./task-summary.js')
    const peeled = extractOutputPathFields(path || opts.path).path
    if (peeled) path = sanitizePreviewPath(peeled, hintRoot) || peeled
  } catch {
    /* ignore */
  }

  if (opts.content != null && String(opts.content) !== '' && !path) {
    // Rare inline text output — keep a minimal fallback without the file modal.
    const { renderMarkdown } = await import('./markdown.js')
    const existing = document.querySelector('.td-output-preview-overlay')
    existing?.remove()
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay td-output-preview-overlay'
    overlay.innerHTML = `
      <div class="modal td-output-preview-modal" role="dialog" aria-modal="true">
        <div class="td-output-preview-head">
          <div class="td-output-preview-title">${title || '产出预览'}</div>
          <button type="button" class="btn btn-secondary btn-sm" data-act="close">关闭</button>
        </div>
        <div class="td-output-preview-body">${renderMarkdown(String(opts.content))}</div>
      </div>`
    document.body.appendChild(overlay)
    const close = () => overlay.remove()
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close()
    })
    overlay.querySelector('[data-act="close"]')?.addEventListener('click', close)
    // @@path@@ in inline markdown → same preview modal
    bindTaskOutputCardActions(overlay, {
      workspaceRoot: hintRoot,
      agentCode: opts.agentCode,
    })
    return
  }

  if (!path) {
    toast('没有可预览的内容', 'error')
    return
  }
  if (/^https?:\/\//i.test(path)) {
    window.open(path, '_blank', 'noopener,noreferrer')
    return
  }

  try {
    path = await resolveTaskOutputAbsolutePath({
      path,
      workspaceRoot: opts.workspaceRoot,
      agentCode: opts.agentCode,
    })
    const workspaceRoot = path.replace(/[\\/][^\\/]+$/, '') || path
    const { resolveOpenableWorkspaceFile } = await import('./workspace-preview-path.js')
    const openable = await resolveOpenableWorkspaceFile({
      workspaceRoot,
      path,
      name: title || fileBasename(path),
      workspaceScopeOpts: { configuredRoot: workspaceRoot },
    })
    openWorkspaceFilePreviewModal({
      workspaceRoot,
      path: openable.path || path,
      name: openable.name || fileBasename(openable.path || path) || title || undefined,
      workspaceScopeOpts: { configuredRoot: workspaceRoot },
    })
  } catch (err) {
    toast(formatPreviewErrorMessage(err, path), 'error')
  }
}

/**
 * Resolve a deliverable path to an absolute host path suitable for reveal / copy.
 * @param {{ path?: string, workspaceRoot?: string, agentCode?: string }} opts
 * @returns {Promise<string>}
 */
export async function resolveTaskOutputAbsolutePath(opts = {}) {
  const hintRoot = cleanHostPath(opts.workspaceRoot || '')
  let path = sanitizePreviewPath(opts.path, hintRoot)
  try {
    const peeled = extractOutputPathFields(path || opts.path).path
    if (peeled) path = sanitizePreviewPath(peeled, hintRoot) || cleanHostPath(peeled)
  } catch {
    /* ignore */
  }
  path = cleanHostPath(path)
  if (!path) throw new Error('没有可打开的路径')
  if (/^https?:\/\//i.test(path)) throw new Error('网络链接请用浏览器打开')

  let workspaceRoot = await resolvePreviewWorkspaceRoot({
    workspaceRoot: opts.workspaceRoot,
    agentCode: opts.agentCode,
    path,
  })
  path = healStrippedAbsolutePath(path, workspaceRoot || hintRoot)

  if (isAbsoluteHostPath(path)) {
    const probed = await probeAbsolutePath(path)
    return probed || path.replace(/\\/g, '/')
  }

  const roots = await collectOutputRootCandidates(workspaceRoot || hintRoot)
  for (const root of roots) {
    const candidate = joinRootRel(root, path)
    const probed = await probeAbsolutePath(candidate)
    if (probed) return probed
  }

  // Last attempt: ask gateway to resolve the relative path against each root.
  for (const root of roots) {
    try {
      const info = await api.resolveWorkspaceTarget(root, path)
      const resolved = cleanHostPath(info?.resolved || '').replace(/\\/g, '/')
      if (resolved && info?.exists !== false && isAbsoluteHostPath(resolved)) {
        return resolved
      }
    } catch {
      /* ignore */
    }
  }

  throw new Error(
    '无法解析为本地绝对路径。请确认文件仍在工作区，或重新运行工作流以写入绝对路径。',
  )
}

/**
 * Reveal a deliverable in the OS file manager (desktop only).
 * Button label in UI: 「打开位置」.
 */
export async function revealTaskOutputInFileManager(opts = {}) {
  try {
    const absolute = await resolveTaskOutputAbsolutePath(opts)
    // Pass native separators so Windows explorer /select lands on the real file.
    await api.revealPathInFileManager(toNativeHostPath(absolute))
  } catch (err) {
    toast(String(err?.message || err), 'error')
  }
}

/**
 * Bind click handlers for output cards inside a page root.
 * @param {ParentNode} root
 * @param {{ workspaceRoot?: string | (() => string), agentCode?: string | (() => string) }} [opts]
 */
export function bindTaskOutputCardActions(root, opts = {}) {
  if (!root || root.__tdOutputCardsBound) return
  root.__tdOutputCardsBound = true

  void enrichOutputCardsExistence(root, {
    workspaceRoot:
      typeof opts.workspaceRoot === 'function' ? opts.workspaceRoot() : opts.workspaceRoot,
    agentCode: typeof opts.agentCode === 'function' ? opts.agentCode() : opts.agentCode,
  })

  root.addEventListener('click', async (e) => {
    const fromOptsWs =
      typeof opts.workspaceRoot === 'function' ? opts.workspaceRoot() : opts.workspaceRoot
    const fromOptsCode =
      typeof opts.agentCode === 'function' ? opts.agentCode() : opts.agentCode
    const fromDatasetWs = root instanceof HTMLElement ? root.dataset.workspaceRoot || '' : ''
    const fromDatasetCode = root instanceof HTMLElement ? root.dataset.agentCode || '' : ''
    const workspaceRoot = String(fromOptsWs || fromDatasetWs || '').trim()
    const agentCodeBase = String(fromOptsCode || fromDatasetCode || '').trim()

    const revealBtn = e.target.closest?.('[data-act="reveal-path"]')
    if (revealBtn && root.contains(revealBtn)) {
      e.preventDefault()
      e.stopPropagation()
      const path = sanitizePreviewPath(revealBtn.getAttribute('data-path') || '', workspaceRoot)
      if (!path) return
      const fromCardCode =
        revealBtn.closest?.('[data-agent-code]')?.getAttribute?.('data-agent-code') || ''
      await revealTaskOutputInFileManager({
        path,
        workspaceRoot,
        agentCode: String(fromCardCode || agentCodeBase || '').trim(),
      })
      return
    }

    const copyBtn = e.target.closest?.('[data-act="copy-path"]')
    if (copyBtn && root.contains(copyBtn)) {
      e.preventDefault()
      e.stopPropagation()
      const path = sanitizePreviewPath(copyBtn.getAttribute('data-path') || '', workspaceRoot)
      if (!path) return
      try {
        await navigator.clipboard.writeText(path)
        toast('路径已复制', 'success')
      } catch {
        toast('复制失败', 'error')
      }
      return
    }

    // Markdown @@path@@ buttons (task brief / employee notes)
    const fileBtn = e.target.closest?.('[data-evf-file-path]')
    if (fileBtn && root.contains(fileBtn)) {
      e.preventDefault()
      e.stopPropagation()
      const rawPath = (fileBtn.getAttribute('data-evf-file-path') || '')
        .replace(/<[^>]*>/g, '')
        .trim()
      const label = (fileBtn.textContent || '').replace(/^\s*📄\s*/, '').trim()
      const fromCardCode =
        fileBtn.closest?.('[data-agent-code]')?.getAttribute?.('data-agent-code') || ''
      if (rawPath) {
        await showTaskOutputPreview({
          path: rawPath,
          title: label,
          workspaceRoot,
          agentCode: String(fromCardCode || agentCodeBase || '').trim(),
        })
      }
      return
    }

    const previewBtn = e.target.closest?.('[data-act="preview-output"]')
    const card = e.target.closest?.('.td-output-row.is-clickable, .td-output-card.is-clickable')
    const trigger = previewBtn && root.contains(previewBtn) ? previewBtn : card && root.contains(card) ? card : null
    if (!trigger) return
    if (!previewBtn && e.target.closest?.('a, button')) return

    e.preventDefault()
    e.stopPropagation()
    const path = sanitizePreviewPath(trigger.getAttribute('data-path') || '', workspaceRoot)
    const title = trigger.getAttribute('data-title') || ''
    const type = trigger.getAttribute('data-type') || ''
    const content = trigger.getAttribute('data-content')
    const fromCardCode =
      trigger.closest?.('[data-agent-code]')?.getAttribute?.('data-agent-code') || ''
    await showTaskOutputPreview({
      path,
      title,
      type,
      content: content != null && content !== '' ? content : undefined,
      workspaceRoot,
      agentCode: String(fromCardCode || agentCodeBase || '').trim(),
    })
  })
}
