/**
 * 从流式/最终消息中的工具列表解析协作任务侧栏状态（supervisor 多步调用）。
 * 与 ChatApp 流式 tool / delta 同步，create_task 有结果后即可展示主任务。
 */

import { SUPERVISOR_ACTION_ZH } from './tool-display.js'
import { planHitFromToolRow } from './plan-pipeline.js'
import {
  structuredPlanFromToolOutput,
  structuredPlanInputFromToolInput,
  structuredPlanInputFromToolOutput,
  toolRowIsPlanTool,
} from './plan-from-task.js'

function parseToolInputObject(input) {
  if (input == null) return null
  if (typeof input === 'object') return input
  if (typeof input === 'string') {
    const t = input.trim()
    if (!t || t === '{}' || t === '[]') return null
    try {
      const p = JSON.parse(t)
      return typeof p === 'object' && p !== null ? p : null
    } catch {
      return null
    }
  }
  return null
}

function parseToolOutputObject(output) {
  if (output == null) return null
  if (typeof output === 'object') return output
  if (typeof output === 'string') {
    const t = output.trim()
    if (!t) return null
    try {
      const p = JSON.parse(t)
      return typeof p === 'object' && p !== null ? p : null
    } catch {
      return null
    }
  }
  return null
}

function isSupervisorLikeTool(name) {
  const n = String(name || '').trim().toLowerCase()
  return n === 'supervisor' || n === 'task_tool' || n === 'task' || n === 'subagent'
}

function isPlanToolName(name) {
  return String(name || '').trim().toLowerCase() === 'plan'
}

function isPlanTool(nameOrRow) {
  if (nameOrRow && typeof nameOrRow === 'object') return toolRowIsPlanTool(nameOrRow)
  return isPlanToolName(nameOrRow)
}

function extractTaskIdFromPlanOutput(output) {
  const o = output && typeof output === 'object' ? output : null
  if (!o) return ''
  let tid = String(o.boundTaskId || o.bound_task_id || o.taskId || o.task_id || '').trim()
  if (tid) return tid
  const sync = o.subtasksSync && typeof o.subtasksSync === 'object' ? o.subtasksSync : null
  if (sync) {
    tid = String(sync.task_id || sync.taskId || '').trim()
    if (tid) return tid
  }
  const created = Array.isArray(o.created)
    ? o.created
    : sync && Array.isArray(sync.created)
      ? sync.created
      : []
  for (const row of created) {
    if (!row || typeof row !== 'object') continue
    tid = String(row.parentTaskId || row.parent_task_id || row.taskId || row.task_id || '').trim()
    if (tid) return tid
  }
  return ''
}

function applyPlanToolToSidebar(input, output, subtasksMap, main) {
  const o = output && typeof output === 'object' ? output : null
  const inp = input && typeof input === 'object' ? input : null
  const taskId = extractTaskIdFromPlanOutput(o) || String(main?.taskId || '').trim()
  let nextMain = main
  if (o?.success !== false) {
    nextMain = {
      ...(main || {}),
      ...(taskId ? { taskId } : {}),
      boundPlanReady: true,
      ...(typeof o?.taskStatus === 'string' ? { status: o.taskStatus } : { status: main?.status || 'planned' }),
      ...(typeof o?.taskProgress === 'number' ? { progress: o.taskProgress } : {}),
    }
  } else if (taskId) {
    nextMain = {
      ...(main || {}),
      taskId,
      ...(typeof o?.taskStatus === 'string' ? { status: o.taskStatus } : { status: main?.status || 'planned' }),
      ...(typeof o?.taskProgress === 'number' ? { progress: o.taskProgress } : {}),
    }
  }
  const created = Array.isArray(o?.created)
    ? o.created
    : Array.isArray(o?.subtasksSync?.created)
      ? o.subtasksSync.created
      : []
  for (const row of created) {
    applySubtaskRowToMap(subtasksMap, row, taskId, 'planned')
  }
  const updated = Array.isArray(o?.subtasksSync?.updated) ? o.subtasksSync.updated : []
  for (const row of updated) {
    applySubtaskRowToMap(subtasksMap, row, taskId, 'planned')
  }
  return nextMain
}

/** supervisor 返回的 assignedAgentName（与网关 agent_name 一致） */
function assignedDisplayFromOutput(o) {
  if (!o || typeof o !== 'object') return ''
  const v =
    typeof o.assignedAgentName === 'string'
      ? o.assignedAgentName.trim()
      : typeof o.assigned_agent_name === 'string'
        ? o.assigned_agent_name.trim()
        : typeof o.assignedAgentDisplay === 'string'
          ? o.assignedAgentDisplay.trim()
          : ''
  return v
}

/**
 * 工具是否已有「可合并进侧栏」的完整 JSON。
 * start_execution：若 success 为 true 但尚未带回 delegatedSubtasks，视为仍在执行中（便于先根据入参显示转圈）。
 */
/** 侧栏占位子任务 id（工具入参已到达、正式 id 尚未写入 output 时） */
export const PENDING_SUBTASK_KEY_PREFIX = '__plan__:'

export function isPendingSubtaskKey(subtaskId) {
  return String(subtaskId || '').startsWith(PENDING_SUBTASK_KEY_PREFIX)
}

function pendingSubtaskKey(parentTaskId, name, index) {
  const tid = String(parentTaskId || 'task').trim()
  const nm = String(name || '').trim() || `step-${index + 1}`
  return `${PENDING_SUBTASK_KEY_PREFIX}${tid}:${nm}`
}

function dropPendingPlaceholdersForName(subtasksMap, name, parentTaskId) {
  const nm = String(name || '').trim()
  if (!nm) return
  for (const [k, v] of subtasksMap.entries()) {
    if (!isPendingSubtaskKey(k)) continue
    if (String(v?.name || '').trim() !== nm) continue
    const pt = String(v?.parentTaskId || '').trim()
    const want = String(parentTaskId || '').trim()
    if (want && pt && pt !== want) continue
    subtasksMap.delete(k)
  }
}

function assignedFromSubtaskSpec(spec) {
  if (!spec || typeof spec !== 'object') return ''
  const agent =
    typeof spec.assigned_agent === 'string'
      ? spec.assigned_agent.trim()
      : typeof spec.assigned_agent_code === 'string'
        ? spec.assigned_agent_code.trim()
        : typeof spec.assignedAgent === 'string'
          ? spec.assignedAgent.trim()
          : typeof spec.assigned_to === 'string'
            ? spec.assigned_to.trim()
            : ''
  return agent
}

function applySubtaskRowToMap(subtasksMap, row, parentTaskId, defaultStatus = 'planned') {
  if (!row || typeof row !== 'object') return
  const r = row
  const sid = String(r.subtaskId || r.subtask_id || r.id || '').trim()
  const nm = String(r.name || r.subtask_name || '').trim()
  const parent = String(r.parentTaskId || r.task_id || parentTaskId || '').trim()
  if (sid) {
    dropPendingPlaceholdersForName(subtasksMap, nm, parent)
    const prev = subtasksMap.get(sid) || {}
    const assignedFromOut =
      typeof r.assignedTo === 'string'
        ? r.assignedTo.trim()
        : typeof r.assigned_to === 'string'
          ? r.assigned_to.trim()
          : ''
    const dnRow = assignedDisplayFromOutput(r)
    const dependsRaw = r.dependsOn ?? r.depends_on
    const depends =
      Array.isArray(dependsRaw) ? dependsRaw.map((x) => String(x || '').trim()).filter(Boolean) : []
    const ref = String(r.ref || '').trim()
    const wc = r.workChecklist ?? r.work_checklist
    subtasksMap.set(sid, {
      ...prev,
      subtaskId: sid,
      ...(parent ? { parentTaskId: parent } : {}),
      ...(nm ? { name: nm } : {}),
      ...(typeof r.description === 'string' ? { description: r.description } : {}),
      ...(typeof r.status === 'string' ? { status: r.status } : { status: defaultStatus }),
      ...(typeof r.progress === 'number' ? { progress: r.progress } : {}),
      ...(assignedFromOut ? { assignedAgent: assignedFromOut } : {}),
      ...(dnRow ? { assignedAgentDisplay: dnRow } : {}),
      ...(ref ? { ref } : {}),
      ...(depends.length ? { dependsOn: depends } : {}),
      ...(Array.isArray(wc) && wc.length ? { workChecklist: wc } : {}),
      ...(Array.isArray(r.tools) && r.tools.length ? { tools: r.tools } : {}),
    })
    return
  }
  if (!nm) return
  const key = pendingSubtaskKey(parent, nm, subtasksMap.size)
  const prev = subtasksMap.get(key) || {}
  const assigned = assignedFromSubtaskSpec(r)
  subtasksMap.set(key, {
    ...prev,
    subtaskId: key,
    ...(parent ? { parentTaskId: parent } : {}),
    name: nm,
    ...(typeof r.description === 'string' ? r.description : {}),
    ...(typeof r.subtask_description === 'string' ? { description: r.subtask_description } : {}),
    status: prev.status || defaultStatus,
    ...(assigned ? { assignedAgent: assigned } : {}),
  })
}

function applySupervisorInputEarly(input, subtasksMap, main) {
  if (!input || typeof input !== 'object') return main
  const action = typeof input.action === 'string' ? input.action.trim() : ''
  const taskId = String(input.task_id || input.taskId || '').trim()
  const taskName = typeof input.task_name === 'string' ? input.task_name.trim() : ''

  if (action === 'create_task') {
    if (taskId || taskName) {
      return {
        ...(main || {}),
        ...(taskId ? { taskId } : {}),
        ...(taskName ? { name: taskName } : {}),
        status: main?.status || 'planned',
      }
    }
    return main
  }

  if (action === 'create_task_with_subtasks' || action === 'create_subtasks') {
    let nextMain = main
    if (taskId) {
      nextMain = {
        ...(main || {}),
        taskId,
        ...(taskName ? { name: taskName } : main?.name ? { name: main.name } : {}),
        status: main?.status || 'planned',
      }
    }
    const specs = input.subtasks
    if (Array.isArray(specs)) {
      specs.forEach((spec, idx) => {
        if (!spec || typeof spec !== 'object') return
        applySubtaskRowToMap(subtasksMap, spec, taskId, 'planned')
      })
    }
    return nextMain
  }

  if (action === 'create_subtask') {
    if (taskId) {
      main = {
        ...(main || {}),
        taskId,
        status: main?.status || 'planned',
      }
    }
    applySubtaskRowToMap(
      subtasksMap,
      {
        name: input.subtask_name || input.name,
        description: input.subtask_description || input.description,
        assigned_agent: input.assigned_agent || input.assigned_agent_code,
      },
      taskId,
      'planned',
    )
    return main
  }

  return main
}

function applySupervisorPartialOutput(output, input, action, subtasksMap, main) {
  const o = output
  if (!o || typeof o !== 'object') return main
  const act = action || (typeof o.action === 'string' ? o.action.trim() : '')
  const taskId = String(o.taskId || o.task_id || input?.task_id || input?.taskId || '').trim()

  if (act === 'create_task' && taskId) {
    return {
      ...(main || {}),
      taskId,
      ...(typeof o.name === 'string' ? { name: o.name } : {}),
      ...(typeof o.status === 'string' ? { status: o.status } : { status: main?.status || 'planned' }),
    }
  }

  if (act === 'create_task_with_subtasks' || act === 'create_subtasks') {
    let nextMain = main
    if (taskId) {
      nextMain = {
        ...(main || {}),
        taskId,
        ...(typeof o.name === 'string' ? { name: o.name } : {}),
        ...(typeof o.status === 'string' ? { status: o.status } : { status: main?.status || 'planned' }),
      }
    }
    const created = Array.isArray(o.created) ? o.created : []
    for (const row of created) {
      applySubtaskRowToMap(subtasksMap, row, taskId || String(input?.task_id || ''), 'planned')
    }
    return nextMain
  }

  if (act === 'create_subtask') {
    applySubtaskRowToMap(subtasksMap, o, taskId || String(input?.task_id || ''), 'planned')
    if (taskId) {
      return { ...(main || {}), taskId, status: main?.status || 'planned' }
    }
  }

  return main
}

function toolOutputLooksComplete(output, input) {
  const o = parseToolOutputObject(output)
  if (!o || typeof o !== 'object') return false
  if ('success' in o && o.success === false) return false
  const ia = input && typeof input === 'object' && typeof input.action === 'string' ? input.action.trim() : ''
  const oa = typeof o.action === 'string' ? o.action.trim() : ''
  const act = ia || oa
  if (act === 'start_execution' && o.success === true) {
    if (!Array.isArray(o.delegatedSubtasks)) return false
  }
  if (act === 'create_task_with_subtasks' || act === 'create_subtasks') {
    if (Array.isArray(o.created) && o.created.length > 0) return true
    if (o.taskId || o.task_id) return true
  }
  if (act === 'create_subtask' && (o.subtaskId || o.subtask_id || o.id)) return true
  if (act === 'create_task' && (o.taskId || o.task_id)) return true
  return true
}

function stepLabel(action) {
  const zh = action && SUPERVISOR_ACTION_ZH[action]
  return zh ? `任务调度 · ${zh}` : `任务调度 · ${action || '调度'}`
}

/** 不向用户展示的 supervisor 内部轮询/状态（避免侧栏步骤里刷屏「任务调度 · 监控…」） */
const SUPERVISOR_SIDEBAR_HIDDEN_ACTIONS = new Set([
  'monitor_execution_step',
  'monitor_execution',
  'get_status',
  'list_subtasks',
  'steer_subtask',
  'interrupt_subtask',
  'get_subtask_conversation',
  'get_task_memory',
  'set_task_planned',
  'set_task_state',
])

/**
 * @param {unknown[]} tools
 * @returns {{ main: object | null, subtasks: object[], supervisorSteps: object[] }}
 */
export function buildCollabSidebarFromTools(tools) {
  /** @type {Record<string, unknown> | null} */
  let main = null
  /** @type {Map<string, Record<string, unknown>>} */
  const subtasksMap = new Map()
  /** @type {Array<{ id: string, action: string, label: string, done: boolean }>} */
  const supervisorSteps = []

  if (!Array.isArray(tools)) {
    return { main: null, subtasks: [], supervisorSteps: [] }
  }

  for (const tool of tools) {
    const t = tool && typeof tool === 'object' ? tool : {}
    const name = String(t.name || '')
    const input = parseToolInputObject(t.input)
    const output = parseToolOutputObject(t.output)
    const done = toolOutputLooksComplete(t.output, input)

    if (isPlanTool(t)) {
      if (output && typeof output === 'object' && output.success === false) continue
      const hinted = applyPlanToolToSidebar(input, output, subtasksMap, main)
      if (hinted) main = hinted
      const o = output && typeof output === 'object' ? output : null
      if (o?.success !== false) {
        main = { ...(main || {}), boundPlanReady: true }
      }
      if (!done) continue
      continue
    }

    if (!isSupervisorLikeTool(name)) continue

    const action = input && typeof input.action === 'string' ? input.action.trim() : ''
    const toolId = String(t.id || t.tool_call_id || `step-${supervisorSteps.length}`)

    if (!SUPERVISOR_SIDEBAR_HIDDEN_ACTIONS.has(action)) {
      supervisorSteps.push({
        id: toolId,
        action,
        label: stepLabel(action),
        done,
      })
    }

    // 流式：工具入参一到即可展示计划中的子任务（不必等 output 完整 JSON）
    if (input && typeof input === 'object') {
      const earlyAction = typeof input.action === 'string' ? input.action.trim() : ''
      const hinted = applySupervisorInputEarly(input, subtasksMap, main)
      if (hinted) main = hinted
      if (earlyAction === 'start_execution') {
        const tid = String(input.task_id || input.taskId || '').trim()
        const rawIds = input.subtask_ids ?? input.subtaskIds
        const ids = Array.isArray(rawIds) ? rawIds : []
        for (const raw of ids) {
          const sid = String(raw || '').trim()
          if (!sid) continue
          const prev = subtasksMap.get(sid) || {}
          subtasksMap.set(sid, {
            ...prev,
            subtaskId: sid,
            ...(tid ? { parentTaskId: tid } : {}),
            status: 'in_progress',
          })
        }
        if (tid) {
          if (main && String(main.taskId || '').trim() === tid) {
            main = { ...main, status: 'running' }
          } else if (!main || !String(main.taskId || '').trim()) {
            main = { ...(main || {}), taskId: tid, status: 'running' }
          }
        }
      }
    }

    // 流式：output 一旦可解析出 created/taskId 即合并（不必等 success 终态）
    if (output && typeof output === 'object') {
      const partialMain = applySupervisorPartialOutput(output, input, action, subtasksMap, main)
      if (partialMain) main = partialMain
    }

    if (!done || !output || typeof output !== 'object') continue

    const o = output

    if (action === 'create_task') {
      const taskId = String(o.taskId || o.id || o.task_id || '')
      if (taskId) {
        const projectId = String(o.projectId || o.project_id || o.parent_project_id || '').trim()
        main = {
          taskId,
          ...(projectId ? { projectId } : {}),
          ...(typeof o.name === 'string' ? { name: o.name } : {}),
          ...(typeof o.status === 'string' ? { status: o.status } : {}),
          ...(typeof o.progress === 'number' ? { progress: o.progress } : {}),
        }
      }
    }

    if (action === 'create_task_with_subtasks') {
      const taskId = String(o.taskId || o.id || o.task_id || '')
      if (taskId) {
        const projectId = String(o.projectId || o.project_id || o.parent_project_id || '').trim()
        main = {
          taskId,
          ...(projectId ? { projectId } : {}),
          ...(typeof o.name === 'string' ? { name: o.name } : {}),
          ...(typeof o.status === 'string' ? { status: o.status } : {}),
          ...(typeof o.progress === 'number' ? { progress: o.progress } : {}),
        }
      }
      const created = Array.isArray(o.created) ? o.created : []
      for (const row of created) {
        applySubtaskRowToMap(subtasksMap, row, taskId, 'planned')
      }
    }

    if (action === 'create_subtask') {
      const parentTaskId = String(o.parentTaskId || o.task_id || (input && input.task_id) || '')
      applySubtaskRowToMap(subtasksMap, o, parentTaskId, 'planned')
    }

    if (action === 'create_subtasks') {
      const parentTaskId = String((input && input.task_id) || o.taskId || o.task_id || '')
      const created = Array.isArray(o.created) ? o.created : []
      for (const row of created) {
        applySubtaskRowToMap(subtasksMap, row, parentTaskId, 'planned')
      }
    }

    if (action === 'assign_subtask') {
      const sid = String(o.subtaskId || o.subtask_id || (input && input.subtask_id) || '')
      const assigned = String(o.assignedTo || (input && input.assigned_agent) || '')
      const dnAssign = assignedDisplayFromOutput(o)
      if (sid) {
        const prev = subtasksMap.get(sid) || { subtaskId: sid }
        subtasksMap.set(sid, {
          ...prev,
          subtaskId: sid,
          ...(assigned ? { assignedAgent: assigned } : {}),
          ...(dnAssign ? { assignedAgentDisplay: dnAssign } : {}),
        })
      }
    }

    if (action === 'complete_subtask') {
      const sid = String(o.subtaskId || o.subtask_id || (input && input.subtask_id) || '')
      if (sid) {
        const prev = subtasksMap.get(sid) || { subtaskId: sid }
        subtasksMap.set(sid, {
          ...prev,
          subtaskId: sid,
          status: 'completed',
          progress: 100,
        })
      }
    }

    if (action === 'start_execution') {
      const tid = String(o.taskId || o.task_id || (input && input.task_id) || '')
      if (tid) {
        if (main && main.taskId === tid) {
          main = { ...main, status: o.status && typeof o.status === 'string' ? o.status : 'running' }
        } else {
          main = {
            ...(main || {}),
            taskId: tid,
            status: typeof o.status === 'string' ? o.status : 'running',
          }
        }
      }

      // start_execution 可能直接带回 delegatedSubtasks（每个子任务的执行结果）
      const delegated = Array.isArray(o.delegatedSubtasks) ? o.delegatedSubtasks : []
      for (const row of delegated) {
        if (!row || typeof row !== 'object') continue
        const r = row
        const sid = String(r.subtaskId || r.subtask_id || '')
        if (!sid) continue
        const detached = r.detached === true
        const ok = r.ok === true
        const prev = subtasksMap.get(sid) || { subtaskId: sid, parentTaskId: tid || undefined }
        subtasksMap.set(sid, {
          ...prev,
          subtaskId: sid,
          ...(tid ? { parentTaskId: tid } : {}),
          // 委派成功仅表示 worker 已启动；终态以 subtask_outcome_report / API 快照为准。
          status: ok || detached ? 'executing' : 'failed',
          progress:
            ok || detached
              ? typeof prev.progress === 'number'
                ? prev.progress
                : 10
              : typeof prev.progress === 'number'
                ? prev.progress
                : 0,
        })
      }

      // 主任务终态由 Lead 显式设置，不因 start_execution 委派返回值推断 completed。
    }

    if (action === 'continue_subtask_session') {
      const tid = String(o.taskId || o.task_id || (input && input.task_id) || '')
      const sid = String(o.subtaskId || o.subtask_id || (input && input.subtask_id) || '')
      if (tid) {
        if (main && main.taskId === tid) {
          main = { ...main, status: typeof o.taskStatus === 'string' ? o.taskStatus : (main.status || 'running') }
        } else {
          main = {
            ...(main || {}),
            taskId: tid,
            status: typeof o.taskStatus === 'string' ? o.taskStatus : 'running',
          }
        }
      }
      if (sid) {
        const prev = subtasksMap.get(sid) || { subtaskId: sid, parentTaskId: tid || undefined }
        const statusFromOut = typeof o.status === 'string' ? o.status : undefined
        const responseText =
          typeof o.responseText === 'string'
            ? o.responseText
            : typeof o.result === 'string'
              ? o.result
              : ''
        subtasksMap.set(sid, {
          ...prev,
          subtaskId: sid,
          ...(tid ? { parentTaskId: tid } : {}),
          ...(statusFromOut ? { status: statusFromOut } : { status: prev.status || 'executing' }),
          ...(typeof o.streamedLines === 'number' ? { progress: responseText ? 100 : (prev.progress || 0) } : {}),
          ...(responseText ? { result: responseText } : {}),
          ...(typeof o.sessionId === 'string' && o.sessionId ? { claudeSessionId: o.sessionId } : {}),
        })
      }
    }

    if (action === 'update_progress') {
      const tid = String(o.taskId || o.task_id || (input && input.task_id) || '')
      const sid = String(o.subtaskId || o.subtask_id || (input && input.subtask_id) || '')
      const prog = typeof o.progress === 'number' ? o.progress : undefined
      const st = typeof o.status === 'string' ? o.status : undefined
      if (sid && subtasksMap.has(sid)) {
        const prev = subtasksMap.get(sid)
        subtasksMap.set(sid, {
          ...prev,
          ...(prog !== undefined ? { progress: prog } : {}),
          ...(st ? { status: st } : {}),
        })
      } else if (tid && main && main.taskId === tid) {
        main = {
          ...main,
          ...(prog !== undefined ? { progress: prog } : {}),
          ...(st ? { status: st } : {}),
        }
      }
    }
  }

  return {
    main,
    subtasks: Array.from(subtasksMap.values()),
    supervisorSteps,
  }
}

/**
 * 从工具列表中取最近一次成功的 plan 工具结果（用于底部「开始执行」确认条）。
 * @param {unknown[]} tools
 * @returns {{ taskId: string, preview: string, status?: string } | null}
 */
/** 成功 plan 工具行的 call id（用于在对应工具块下挂载「开始执行」确认） */
export function planToolCallIdIfSuccess(tool) {
  const t = tool && typeof tool === 'object' ? tool : {}
  if (!isPlanTool(t)) return ''
  const output = parseToolOutputObject(t.output)
  if (!output || output.success === false) return ''
  const rid = t.id != null && String(t.id).trim() !== '' ? String(t.id).trim() : ''
  const rtc =
    t.tool_call_id != null && String(t.tool_call_id).trim() !== ''
      ? String(t.tool_call_id).trim()
      : ''
  return rid || rtc || ''
}

/** 工具行 id / tool_call_id 是否与给定 call id 一致。 */
export function toolRowMatchesCallId(tool, callId) {
  const want = String(callId || '').trim()
  if (!want) return false
  const t = tool && typeof tool === 'object' ? tool : {}
  const rid = t.id != null && String(t.id).trim() !== '' ? String(t.id).trim() : ''
  const rtc =
    t.tool_call_id != null && String(t.tool_call_id).trim() !== ''
      ? String(t.tool_call_id).trim()
      : ''
  return rid === want || rtc === want
}

/** 列表中是否存在已成功的 plan 工具（用于确认条挂载，不要求 boundTaskId）。 */
export function listHasSuccessfulPlanTool(tools) {
  if (!Array.isArray(tools)) return false
  for (const tool of tools) {
    const t = tool && typeof tool === 'object' ? tool : {}
    if (!isPlanTool(t.name)) continue
    const output = parseToolOutputObject(t.output)
    if (output && output.success !== false) return true
  }
  return false
}

/**
 * 在若干工具列表（按时间顺序）中取最后一次成功的 plan 工具 call id。
 * @param {unknown[][]} toolsArrays
 * @returns {string}
 */
export function findLastSuccessfulPlanToolCallId(toolsArrays) {
  let last = ''
  if (!Array.isArray(toolsArrays)) return last
  for (const tools of toolsArrays) {
    if (!Array.isArray(tools)) continue
    for (const tool of tools) {
      const id = planToolCallIdIfSuccess(tool)
      if (id) last = id
    }
  }
  return last
}

/**
 * 按时间顺序收集会话内各 assistant 行的 tools（用于刷新后从落库消息恢复 plan/协作）。
 * @param {Array<{ role?: string, tools?: unknown[] }>} rows
 * @returns {unknown[][]}
 */
export function collectAssistantToolArraysFromRows(rows) {
  /** @type {unknown[][]} */
  const arrays = []
  if (!Array.isArray(rows)) return arrays
  for (const row of rows) {
    if (row?.role === 'assistant' && Array.isArray(row.tools) && row.tools.length) {
      arrays.push(row.tools)
    }
  }
  return arrays
}

/**
 * 合并全部 assistant 工具行（刷新后 patchCollab 须扫全历史，不能只看最后一轮 assistant）。
 * @param {Array<{ role?: string, tools?: unknown[] }>} rows
 * @returns {unknown[]}
 */
export function mergeAssistantToolsFromRows(rows) {
  const out = []
  for (const tools of collectAssistantToolArraysFromRows(rows)) {
    out.push(...tools)
  }
  return out
}

/** 仅最后一轮 assistant 落库工具（plan 检测用，避免全历史合并冲掉当前流式 plan 行）。 */
export function toolsFromLastAssistantRow(rows) {
  if (!Array.isArray(rows)) return []
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (row?.role === 'assistant' && Array.isArray(row.tools) && row.tools.length) {
      return row.tools
    }
  }
  return []
}

/** 正式 subtaskId 已出现时，去掉同名占位行，避免侧栏重复。 */
export function pruneSupersededPendingSubtasks(list, incoming) {
  if (!Array.isArray(list) || !list.length) return list || []
  const inc = Array.isArray(incoming) ? incoming : []
  const realKeys = new Set(
    inc
      .filter((s) => s && !isPendingSubtaskKey(s.subtaskId))
      .map((s) => `${String(s.parentTaskId || '').trim()}:${String(s.name || '').trim()}`),
  )
  if (!realKeys.size) return list
  return list.filter((s) => {
    if (!isPendingSubtaskKey(s.subtaskId)) return true
    const k = `${String(s.parentTaskId || '').trim()}:${String(s.name || '').trim()}`
    return !realKeys.has(k)
  })
}

function planToolOutputStructured(output) {
  return structuredPlanFromToolOutput(output && typeof output === 'object' ? output : null)
}

/**
 * @param {unknown[][]} toolsArrays
 * @returns {import('./plan-from-task.js').ParsedPlan | null}
 */
export function extractLastPlanToolStructuredFromArrays(toolsArrays) {
  /** @type {import('./plan-from-task.js').ParsedPlan | null} */
  let last = null
  if (!Array.isArray(toolsArrays)) return last
  for (const tools of toolsArrays) {
    const hit = extractLastPlanToolStructured(tools)
    if (hit) last = hit
  }
  return last
}

export function extractLastPlanToolStructured(tools) {
  if (!Array.isArray(tools)) return null
  /** @type {import('./plan-from-task.js').ParsedPlan | null} */
  let last = null
  for (const tool of tools) {
    const t = tool && typeof tool === 'object' ? tool : {}
    if (!isPlanTool(t)) continue
    const output = parseToolOutputObject(t.output)
    const plan = planToolOutputStructured(output)
    if (plan) last = plan
  }
  return last
}

/** 最近一次成功 plan 工具返回的正文（用于任务行尚未落库时的弹窗回退）。 */
export function extractLastPlanToolGoal(tools) {
  if (!Array.isArray(tools)) return ''
  let last = ''
  for (const tool of tools) {
    const t = tool && typeof tool === 'object' ? tool : {}
    if (!isPlanTool(t)) continue
    const input = parseToolInputObject(t.input)
    const g = input && typeof input.goal === 'string' ? input.goal.trim() : ''
    if (g) last = g
  }
  return last
}

/**
 * @param {unknown[][]} toolsArrays
 * @returns {string}
 */
export function extractLastPlanToolGoalFromArrays(toolsArrays) {
  let last = ''
  if (!Array.isArray(toolsArrays)) return last
  for (const tools of toolsArrays) {
    const g = extractLastPlanToolGoal(tools)
    if (g) last = g
  }
  return last
}

export function extractLastPlanToolMarkdown(tools) {
  if (!Array.isArray(tools)) return ''
  let last = ''
  for (const tool of tools) {
    const t = tool && typeof tool === 'object' ? tool : {}
    if (!isPlanTool(t)) continue
    const output = parseToolOutputObject(t.output)
    const md = extractLastPlanToolMarkdown(output)
    if (md) last = md
  }
  return last
}

/**
 * @param {unknown[][]} toolsArrays
 * @returns {string}
 */
export function extractLastPlanToolMarkdownFromArrays(toolsArrays) {
  let last = ''
  if (!Array.isArray(toolsArrays)) return last
  for (const tools of toolsArrays) {
    const md = extractLastPlanToolMarkdown(tools)
    if (md) last = md
  }
  return last
}

/**
 * @param {unknown[][]} toolsArrays
 * @returns {ReturnType<typeof extractLastPlanToolSuccess>}
 */
export function extractLastPlanToolSuccessFromArrays(toolsArrays) {
  /** @type {ReturnType<typeof extractLastPlanToolSuccess>} */
  let last = null
  if (!Array.isArray(toolsArrays)) return last
  for (const tools of toolsArrays) {
    const hit = extractLastPlanToolSuccess(tools)
    if (hit) last = hit
  }
  return last
}

export function extractLastPlanToolSuccess(tools) {
  if (!Array.isArray(tools)) return null
  /** @type {ReturnType<typeof planHitFromToolRow>} */
  let last = null
  for (const tool of tools) {
    const hit = planHitFromToolRow(tool)
    if (hit) last = hit
  }
  return last
}
