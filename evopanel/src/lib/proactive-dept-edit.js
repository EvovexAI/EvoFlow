/**
 * 编辑部门 sheet（复用 hire-sheet 壳，与编辑员工同款交互）。
 * 可改：名称、头像、负责人、成员名单；成员直属上级可在表内改。
 *
 * 头像交互：顶部大预览；点头像 / 旁侧铅笔展开预设网格（缩略图，不是文字 chip）。
 */
import { api, getGatewayBaseUrl } from './tauri-api.js'
import { toast } from '../components/toast.js'

const PRESET_ID_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function closeOverlay(overlay) {
  try {
    overlay.remove()
  } catch {
    /* ignore */
  }
}

function normalizeDept(raw) {
  const d = raw && typeof raw === 'object' ? raw : {}
  const members = Array.isArray(d.members)
    ? d.members
        .map((m) => ({
          agent_code: String(m?.agent_code || m?.code || '').trim(),
          role_name: String(m?.role_name || m?.display_name || '').trim(),
          reports_to: String(m?.reports_to || '').trim(),
          status: String(m?.status || 'active').trim() || 'active',
        }))
        .filter((m) => m.agent_code && m.agent_code !== 'main')
    : []
  return {
    id: String(d.id || '').trim(),
    name: String(d.name || '').trim(),
    avatar: String(d.avatar || '').trim(),
    avatar_rev: d.avatar_rev ?? null,
    head_agent_code: String(d.head_agent_code || '').trim(),
    head_role_name: String(d.head_role_name || '').trim(),
    members,
  }
}

/** 负责人置顶，其余保持原序 */
function sortMembersHeadFirst(members, headCode) {
  const head = String(headCode || '').trim().toLowerCase()
  if (!head || !Array.isArray(members)) return members || []
  const copy = [...members]
  copy.sort((a, b) => {
    const aH = String(a.agent_code || '').trim().toLowerCase() === head
    const bH = String(b.agent_code || '').trim().toLowerCase() === head
    if (aH && !bH) return -1
    if (!aH && bH) return 1
    return 0
  })
  return copy
}

function avatarSrc(baseUrl, avatar, deptId, rev, objectUrl) {
  if (objectUrl) return objectUrl
  const raw = String(avatar || '').trim()
  const base = baseUrl ? String(baseUrl).replace(/\/$/, '') : ''
  if (raw.toLowerCase() === 'image') {
    const id = String(deptId || '').trim()
    if (!id) return ''
    const v = rev ? `?v=${encodeURIComponent(String(rev))}` : ''
    return `${base}/api/proactive/departments/${encodeURIComponent(id)}/avatar${v}`
  }
  let id = raw.toLowerCase().replace(/^preset:/, '')
  if (!PRESET_ID_RE.test(id)) return ''
  return `${base}/api/proactive/departments/avatar-presets/${encodeURIComponent(id)}`
}

function paintPreviewEl(el, src, name) {
  if (!(el instanceof HTMLElement)) return
  const initial = String(name || '').trim().slice(0, 1) || '部'
  const showInitial = () => {
    el.innerHTML = ''
    el.classList.remove('has-image')
    el.textContent = initial
  }
  if (!src) {
    showInitial()
    return
  }
  const img = new Image()
  img.alt = ''
  img.draggable = false
  img.decoding = 'async'
  img.onload = () => {
    el.innerHTML = ''
    el.appendChild(img)
    el.classList.add('has-image')
  }
  img.onerror = showInitial
  img.src = src
}

async function loadAllRoles() {
  try {
    const res = await api.proactiveListRoles('active')
    const raw = Array.isArray(res) ? res : Array.isArray(res?.roles) ? res.roles : []
    return raw
      .map((r) => ({
        agent_code: String(r?.agent_code || '').trim(),
        role_name: String(r?.role_name || r?.agent_name || '').trim(),
        reports_to: String(r?.reports_to || r?.config?.reports_to || '').trim(),
        department: String(r?.department || r?.config?.department || '').trim(),
        status: String(r?.status || 'active').trim() || 'active',
      }))
      .filter((r) => r.agent_code && r.agent_code !== 'main')
  } catch {
    return []
  }
}

async function loadPresets() {
  try {
    const rows = await api.proactiveListDeptAvatarPresets?.()
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

function renderIdentityBlock(dept, baseUrl) {
  const src = avatarSrc(baseUrl, dept.avatar, dept.id, dept.avatar_rev, null)
  const initial = String(dept.name || '').trim().slice(0, 1) || '部'
  return `
    <div class="hire-dept-identity">
      <div class="hire-dept-avatar-wrap">
        <button type="button" class="hire-dept-avatar-btn" data-act="avatar-toggle" title="点击更换部门头像" aria-label="更换部门头像">
          <span class="hire-dept-avatar-preview${src ? '' : ''}" data-role="avatar-preview">${
            src
              ? `<img src="${esc(src)}" alt="" draggable="false">`
              : esc(initial)
          }</span>
        </button>
        <button type="button" class="hire-dept-avatar-pencil" data-act="avatar-toggle" title="更换头像" aria-label="更换头像">✎</button>
      </div>
      <div class="hire-dept-identity-fields">
        <div class="hire-field" style="margin:0">
          <span>部门名称</span>
          <input class="hire-input" data-name="name" maxlength="64" value="${esc(dept.name)}" placeholder="部门名称">
        </div>
        <p class="hire-chip-hint">点头像或铅笔更换；可选预设或上传图片</p>
      </div>
      <input type="file" data-role="avatar-file" accept="image/png,image/jpeg,image/webp" hidden>
    </div>
    <div class="hire-dept-avatar-picker" data-role="avatar-picker" hidden></div>`
}

function renderAvatarPicker(presets, draft, baseUrl, dept) {
  const cur = String(draft.avatar || '').trim().toLowerCase()
  const isImage = cur === 'image' || !!draft.pendingUpload
  const presetOpts = (presets || [])
    .map((p) => {
      const id = String(p.id || '').trim()
      if (!id) return ''
      const on = !isImage && cur === id.toLowerCase()
      const thumb = avatarSrc(baseUrl, id, '', '', null)
      return `
        <button type="button" class="hire-dept-avatar-opt${on ? ' is-on' : ''}" data-act="avatar-preset" data-id="${esc(id)}" title="${esc(p.label || id)}">
          <span class="hire-dept-avatar-opt-img" data-thumb="${esc(thumb)}" data-label="${esc(p.label || id)}">${esc((p.label || id).slice(0, 1))}</span>
          <span class="hire-dept-avatar-opt-label">${esc(p.label || id)}</span>
        </button>`
    })
    .join('')
  return `
    <div class="hire-dept-avatar-grid" role="listbox" aria-label="选择部门头像">
      <button type="button" class="hire-dept-avatar-opt hire-dept-avatar-opt--upload${isImage ? ' is-on' : ''}" data-act="avatar-upload" title="上传自定义头像">
        <span class="hire-dept-avatar-opt-img hire-dept-avatar-upload-icon" aria-hidden>＋</span>
        <span class="hire-dept-avatar-opt-label">${isImage ? '重新上传' : '上传图片'}</span>
      </button>
      ${presetOpts || '<span class="hire-chip-hint">暂无预设</span>'}
    </div>`
}

function paintPickerThumbs(root) {
  root.querySelectorAll('.hire-dept-avatar-opt-img[data-thumb]').forEach((el) => {
    const thumb = String(el.getAttribute('data-thumb') || '').trim()
    const label = String(el.getAttribute('data-label') || '').trim()
    if (!thumb) return
    const img = new Image()
    img.alt = ''
    img.draggable = false
    img.onload = () => {
      el.innerHTML = ''
      el.appendChild(img)
      el.classList.add('has-image')
    }
    img.onerror = () => {
      el.textContent = label.slice(0, 1) || '部'
    }
    img.src = thumb
  })
}

function renderMembersBlock(dept, allRoles) {
  const ordered = sortMembersHeadFirst(dept.members, dept.head_agent_code)
  const memberCodes = new Set(dept.members.map((m) => m.agent_code))
  const memberRows = ordered
    .map((m) => {
      const code = m.agent_code
      const name = m.role_name || code
      const isHead = dept.head_agent_code && dept.head_agent_code === code
      const peers = dept.members.filter((x) => x.agent_code !== code)
      const reportsOpts = [
        `<option value="">无直属上级</option>`,
        ...peers.map((p) => {
          const on = m.reports_to === p.agent_code
          return `<option value="${esc(p.agent_code)}"${on ? ' selected' : ''}>${esc(p.role_name || p.agent_code)}</option>`
        }),
      ].join('')
      return `
        <li class="hire-dept-member" data-code="${esc(code)}">
          <div class="hire-dept-member-main">
            <strong>${esc(name)}${isHead ? ' <span class="hire-chip-hint">负责人</span>' : ''}</strong>
            <span class="hire-chip-hint">${esc(code)}</span>
          </div>
          <label class="hire-field hire-dept-member-reports">
            <span>上级</span>
            <select class="hire-input" data-act="member-reports" data-code="${esc(code)}">${reportsOpts}</select>
          </label>
          <button type="button" class="btn btn-sm btn-outline" data-act="remove-member" data-code="${esc(code)}">移出</button>
        </li>`
    })
    .join('')

  const candidates = allRoles.filter((r) => !memberCodes.has(r.agent_code))
  const addOpts = [
    `<option value="">添加成员…</option>`,
    ...candidates.map(
      (r) =>
        `<option value="${esc(r.agent_code)}">${esc(r.role_name || r.agent_code)} · ${esc(r.agent_code)}</option>`,
    ),
  ].join('')

  return `
    <div class="hire-field">
      <span>部门成员（${dept.members.length}）</span>
      <ul class="hire-dept-member-list">${memberRows || '<li class="hire-chip-hint">暂无成员</li>'}</ul>
      <select class="hire-input" data-act="add-member">${addOpts}</select>
    </div>`
}

/**
 * @param {object} deptInput
 * @param {{ onSaved?: (dept: object) => void | Promise<void> }} [opts]
 */
export async function showEditDeptModal(deptInput, { onSaved } = {}) {
  let dept = normalizeDept(deptInput)
  if (!dept.id) {
    toast('部门无效', 'error')
    return
  }

  const [allRoles, presets, baseUrl] = await Promise.all([
    loadAllRoles(),
    loadPresets(),
    getGatewayBaseUrl().catch(() => ''),
  ])
  const roleByCode = new Map(allRoles.map((r) => [r.agent_code, r]))
  dept.members = dept.members.map((m) => {
    const r = roleByCode.get(m.agent_code)
    return {
      ...m,
      role_name: m.role_name || r?.role_name || m.agent_code,
      reports_to: m.reports_to || r?.reports_to || '',
    }
  })

  /** @type {{ avatar?: string, pendingUpload?: File | null, objectUrl?: string | null }} */
  const draft = { avatar: dept.avatar, pendingUpload: null, objectUrl: null }
  /** @type {Map<string, string>} */
  const reportsDraft = new Map(dept.members.map((m) => [m.agent_code, m.reports_to || '']))
  let pickerOpen = false

  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay hire-overlay'
  overlay.innerHTML = `
    <div class="hire-sheet hire-sheet--edit" role="dialog" aria-labelledby="hire-dept-title">
      <header class="hire-sheet-head">
        <div>
          <p class="hire-sheet-kicker">部门</p>
          <h2 id="hire-dept-title" class="hire-sheet-title">编辑部门</h2>
        </div>
        <button type="button" class="hire-sheet-close" data-act="close" aria-label="关闭">&times;</button>
      </header>
      <div class="hire-sheet-body" style="padding-top:12px">
        ${renderIdentityBlock(dept, baseUrl)}
        <div class="hire-field">
          <span>负责人</span>
          <select class="hire-input" data-name="head">
            <option value="">未指定</option>
            ${sortMembersHeadFirst(dept.members, dept.head_agent_code)
              .map((m) => {
                const on = dept.head_agent_code === m.agent_code
                return `<option value="${esc(m.agent_code)}"${on ? ' selected' : ''}>${esc(m.role_name || m.agent_code)}</option>`
              })
              .join('')}
          </select>
          <label class="hire-toggle" style="margin-top:8px;display:flex;gap:8px;align-items:center">
            <input type="checkbox" data-name="align-unmanaged" checked>
            <span class="hire-chip-hint">保存负责人时，把「尚未设上级」的成员自动汇报给负责人</span>
          </label>
        </div>
        <div data-role="members-root">${renderMembersBlock(dept, allRoles)}</div>
      </div>
      <footer class="hire-sheet-foot">
        <button type="button" class="btn btn-outline" data-act="close">取消</button>
        <button type="button" class="btn btn-primary" data-act="save">保存部门</button>
      </footer>
    </div>`

  document.body.appendChild(overlay)

  // 预览图加载失败时回落首字
  const previewEl = overlay.querySelector('[data-role="avatar-preview"]')
  if (previewEl instanceof HTMLElement) {
    const img = previewEl.querySelector('img')
    if (img) {
      img.onerror = () => {
        previewEl.classList.remove('has-image')
        previewEl.textContent = String(dept.name || '').trim().slice(0, 1) || '部'
      }
      if (img.complete && img.naturalWidth) previewEl.classList.add('has-image')
    }
  }

  const membersRoot = () => overlay.querySelector('[data-role="members-root"]')
  const pickerRoot = () => overlay.querySelector('[data-role="avatar-picker"]')

  const refreshPreview = () => {
    const el = overlay.querySelector('[data-role="avatar-preview"]')
    const src = avatarSrc(baseUrl, draft.avatar, dept.id, dept.avatar_rev, draft.objectUrl)
    paintPreviewEl(el, src, dept.name)
  }

  const syncPicker = () => {
    const root = pickerRoot()
    if (!(root instanceof HTMLElement)) return
    if (!pickerOpen) {
      root.hidden = true
      root.innerHTML = ''
      return
    }
    root.hidden = false
    root.innerHTML = renderAvatarPicker(presets, draft, baseUrl, dept)
    paintPickerThumbs(root)
  }

  const markPickerOn = () => {
    if (!pickerOpen) return
    syncPicker()
  }

  const rerenderMembers = () => {
    const root = membersRoot()
    if (root) root.innerHTML = renderMembersBlock(dept, allRoles)
  }

  const syncHeadSelect = () => {
    const headSel = overlay.querySelector('[data-name="head"]')
    if (!(headSel instanceof HTMLSelectElement)) return
    headSel.innerHTML =
      `<option value="">未指定</option>` +
      sortMembersHeadFirst(dept.members, dept.head_agent_code)
        .map(
          (m) =>
            `<option value="${esc(m.agent_code)}"${dept.head_agent_code === m.agent_code ? ' selected' : ''}>${esc(m.role_name || m.agent_code)}</option>`,
        )
        .join('')
  }

  overlay.addEventListener('click', (e) => {
    const t = e.target
    if (!(t instanceof Element)) return
    if (t === overlay || t.closest('[data-act="close"]')) {
      if (draft.objectUrl) {
        try {
          URL.revokeObjectURL(draft.objectUrl)
        } catch {
          /* ignore */
        }
      }
      closeOverlay(overlay)
      return
    }
    if (t.closest('[data-act="avatar-toggle"]')) {
      pickerOpen = !pickerOpen
      syncPicker()
      return
    }
    const presetBtn = t.closest('[data-act="avatar-preset"]')
    if (presetBtn) {
      const id = String(presetBtn.getAttribute('data-id') || '').trim()
      if (!id) return
      if (draft.objectUrl) {
        try {
          URL.revokeObjectURL(draft.objectUrl)
        } catch {
          /* ignore */
        }
      }
      draft.objectUrl = null
      draft.pendingUpload = null
      draft.avatar = id
      refreshPreview()
      markPickerOn()
      return
    }
    if (t.closest('[data-act="avatar-upload"]')) {
      overlay.querySelector('[data-role="avatar-file"]')?.click()
      return
    }
    const rm = t.closest('[data-act="remove-member"]')
    if (rm) {
      const code = String(rm.getAttribute('data-code') || '').trim()
      dept.members = dept.members.filter((m) => m.agent_code !== code)
      reportsDraft.delete(code)
      if (dept.head_agent_code === code) dept.head_agent_code = ''
      syncHeadSelect()
      rerenderMembers()
      return
    }
    if (t.closest('[data-act="save"]')) {
      void save()
    }
  })

  overlay.addEventListener('change', (e) => {
    const t = e.target
    if (!(t instanceof HTMLElement)) return
    if (t.matches('[data-name="head"]') && t instanceof HTMLSelectElement) {
      dept.head_agent_code = String(t.value || '').trim()
      rerenderMembers()
      return
    }
    if (t.matches('[data-role="avatar-file"]') && t instanceof HTMLInputElement) {
      const file = t.files?.[0] || null
      if (!file) return
      if (draft.objectUrl) {
        try {
          URL.revokeObjectURL(draft.objectUrl)
        } catch {
          /* ignore */
        }
      }
      draft.pendingUpload = file
      draft.avatar = 'image'
      draft.objectUrl = URL.createObjectURL(file)
      refreshPreview()
      if (!pickerOpen) {
        pickerOpen = true
      }
      markPickerOn()
      return
    }
    if (t.matches('[data-act="add-member"]') && t instanceof HTMLSelectElement) {
      const code = String(t.value || '').trim()
      t.value = ''
      if (!code || dept.members.some((m) => m.agent_code === code)) return
      const r = roleByCode.get(code)
      dept.members.push({
        agent_code: code,
        role_name: r?.role_name || code,
        reports_to: r?.reports_to || '',
        status: r?.status || 'active',
      })
      reportsDraft.set(code, r?.reports_to || '')
      syncHeadSelect()
      rerenderMembers()
      return
    }
    if (t.matches('[data-act="member-reports"]') && t instanceof HTMLSelectElement) {
      const code = String(t.getAttribute('data-code') || '').trim()
      if (!code) return
      reportsDraft.set(code, String(t.value || '').trim())
    }
  })

  async function save() {
    const nameEl = overlay.querySelector('[data-name="name"]')
    const headEl = overlay.querySelector('[data-name="head"]')
    const alignEl = overlay.querySelector('[data-name="align-unmanaged"]')
    const name = String(nameEl instanceof HTMLInputElement ? nameEl.value : dept.name).trim()
    if (!name) {
      toast('请填写部门名称', 'warning')
      return
    }
    const head = String(headEl instanceof HTMLSelectElement ? headEl.value : '').trim()
    const align = !!(alignEl instanceof HTMLInputElement && alignEl.checked)
    const saveBtn = overlay.querySelector('[data-act="save"]')
    if (saveBtn instanceof HTMLButtonElement) {
      saveBtn.disabled = true
      saveBtn.textContent = '保存中…'
    }
    try {
      if (name !== dept.name) {
        await api.proactiveUpdateDepartment(dept.id, { name })
      }
      const memberCodes = dept.members.map((m) => m.agent_code)
      await api.proactiveSetDepartmentMembers(dept.id, memberCodes)

      if (draft.pendingUpload) {
        await api.uploadDeptAvatar(dept.id, draft.pendingUpload, draft.pendingUpload.name || 'avatar.png')
      } else if (draft.avatar !== undefined && draft.avatar !== dept.avatar) {
        await api.proactiveUpdateDepartment(dept.id, { avatar: draft.avatar })
      }

      if (head !== dept.head_agent_code) {
        await api.proactiveUpdateDepartment(dept.id, {
          head_agent_code: head,
          align_unmanaged: align,
        })
      } else if (head && align) {
        await api.proactiveUpdateDepartment(dept.id, {
          head_agent_code: head,
          align_unmanaged: true,
        })
      }

      for (const m of dept.members) {
        const next = String(reportsDraft.get(m.agent_code) || '').trim()
        const prev = String(m.reports_to || '').trim()
        if (next === prev) continue
        try {
          await api.proactiveUpdateRole(m.agent_code, { reports_to: next })
        } catch (err) {
          console.warn('[dept-edit] reports_to failed', m.agent_code, err)
        }
      }

      const refreshed = await api.proactiveListDepartments()
      let updated = {
        ...dept,
        name,
        head_agent_code: head,
        avatar: draft.avatar,
        members: dept.members,
      }
      try {
        const { deptRowsFromDepartmentsApi, setCachedDeptList } = await import(
          '../react/lib/dept-chat-session.js'
        )
        const rows = deptRowsFromDepartmentsApi(refreshed)
        setCachedDeptList(rows)
        updated = rows.find((d) => d.id === dept.id) || updated
      } catch {
        /* ignore cache sync */
      }
      if (draft.objectUrl) {
        try {
          URL.revokeObjectURL(draft.objectUrl)
        } catch {
          /* ignore */
        }
      }
      toast('部门已保存', 'success')
      closeOverlay(overlay)
      await onSaved?.(updated)
    } catch (e) {
      toast(`保存失败：${(e)?.message || e}`, 'error')
      if (saveBtn instanceof HTMLButtonElement) {
        saveBtn.disabled = false
        saveBtn.textContent = '保存部门'
      }
    }
  }
}
