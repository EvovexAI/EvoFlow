/**
 * Mount the shared chat WorkspaceFilePreviewModal from vanilla JS pages
 * (task detail / employee work items).
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkspaceFilePreviewModal } from '../react/components/WorkspaceFilePreviewModal.tsx'

/** @type {import('react-dom/client').Root | null} */
let previewRoot = null
/** @type {HTMLElement | null} */
let previewHost = null

function ensureHost() {
  if (previewHost && previewRoot) return { host: previewHost, root: previewRoot }
  const host = document.createElement('div')
  host.className = 'td-workspace-file-preview-host'
  document.body.appendChild(host)
  const root = createRoot(host)
  previewHost = host
  previewRoot = root
  return { host, root }
}

function teardown() {
  if (previewRoot) {
    try {
      previewRoot.render(null)
    } catch {
      /* ignore */
    }
  }
}

/**
 * Open the full-size workspace file preview modal (same UI as chat).
 * @param {{
 *   workspaceRoot: string
 *   path: string
 *   name?: string
 *   threadId?: string
 *   workspaceScopeOpts?: { configuredRoot?: string, useVirtualPaths?: boolean }
 *   onClose?: () => void
 * }} opts
 * @returns {() => void} close handle
 */
export function openWorkspaceFilePreviewModal(opts) {
  const workspaceRoot = String(opts?.workspaceRoot || '').trim()
  const path = String(opts?.path || '').trim()
  if (!workspaceRoot || !path) {
    throw new Error('workspaceRoot and path are required')
  }

  const { root } = ensureHost()
  const close = () => {
    teardown()
    try {
      opts?.onClose?.()
    } catch {
      /* ignore */
    }
  }

  root.render(
    createElement(WorkspaceFilePreviewModal, {
      workspaceRoot,
      path,
      name: opts?.name || undefined,
      threadId: opts?.threadId || undefined,
      workspaceScopeOpts: opts?.workspaceScopeOpts || { configuredRoot: workspaceRoot },
      onClose: close,
    }),
  )

  return close
}
