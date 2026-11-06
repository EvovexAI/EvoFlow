/**
 * 应用中心工作流画布 — React Flow（与 FastGPT 同款 @xyflow/react）
 *
 * AppWorkflowCanvas / @xyflow 体积大：动态 import，避免 apps-detail 冷开时
 * 必须先解析整包才开始 getApp（「加载工作流…」被模块下载拖死）。
 */
import { createElement, createRef } from 'react'
import { createRoot } from 'react-dom/client'

const roots = new WeakMap()

/** @type {Promise<typeof import('../react/components/AppWorkflowCanvas.tsx').AppWorkflowCanvas> | null} */
let _canvasLoad = null
/** @type {typeof import('../react/components/AppWorkflowCanvas.tsx').AppWorkflowCanvas | null} */
let _AppWorkflowCanvas = null

/** 预热画布 chunk（列表 hover / 进详情时可并行于 getApp）。 */
export function preloadAppWorkflowCanvas() {
  if (_AppWorkflowCanvas) return Promise.resolve(_AppWorkflowCanvas)
  if (!_canvasLoad) {
    _canvasLoad = import('../react/components/AppWorkflowCanvas.tsx')
      .then((m) => {
        _AppWorkflowCanvas = m.AppWorkflowCanvas
        return _AppWorkflowCanvas
      })
      .catch((err) => {
        _canvasLoad = null
        throw err
      })
  }
  return _canvasLoad
}

/**
 * @param {HTMLElement} container
 * @param {{ goal?: string, steps?: object[], canvas?: object, variant?: string, onSave?: Function, onPublish?: Function }} options
 */
export async function mountAppWorkflowCanvas(container, options = {}) {
  const AppWorkflowCanvas = await preloadAppWorkflowCanvas()

  container.innerHTML = ''
  container.classList.add('app-wf-mounted')

  const host = document.createElement('div')
  host.className = 'app-wf-canvas-host'
  container.appendChild(host)

  const canvasRef = createRef()
  let planKey = 0
  let props = { variant: 'fullscreen', ...options }

  const root = createRoot(host)
  roots.set(container, root)

  function render() {
    root.render(
      createElement(AppWorkflowCanvas, {
        key: planKey,
        ref: canvasRef,
        variant: props.variant || 'fullscreen',
        goal: props.goal || '',
        steps: props.steps || [],
        canvas: props.canvas || null,
        projectPath: props.projectPath || props.project_path || '',
        onSave: props.onSave || (async () => {}),
        onPublish: props.onPublish || (async () => {}),
        onOpenAppSettings: props.onOpenAppSettings,
        onOpenHistory: props.onOpenHistory,
        onOpenVersions: props.onOpenVersions,
        onOpenHowToUse: props.onOpenHowToUse || props.onOpenApiAccess,
        onOpenApiAccess: props.onOpenApiAccess,
        appName: props.appName || '',
        appStatus: props.appStatus || 'draft',
        appParameters: props.appParameters || [],
        onBack: props.onBack,
        onRun: props.onRun,
        onRename: props.onRename,
        onInspectStep: props.onInspectStep,
        appId: props.appId,
        runId: props.runId,
        parameters: props.parameters,
      }),
    )
  }

  render()

  const api = () => canvasRef.current

  return {
    getPlan() {
      return (
        api()?.getPlan?.() || {
          goal: props.goal || '',
          steps: props.steps || [],
          canvas: props.canvas || undefined,
          flowchart_mermaid: '',
        }
      )
    },
    isDirty() {
      return api()?.isDirty?.() || false
    },
    saveDraft() {
      return api()?.saveDraft?.() || Promise.resolve()
    },
    publishApp() {
      return api()?.publishApp?.() || Promise.resolve()
    },
    addStep() {
      api()?.addStep?.()
    },
    deleteSelected() {
      api()?.deleteSelected?.()
    },
    getGoal() {
      return api()?.getGoal?.() || props.goal || ''
    },
    setGoal(goal) {
      api()?.setGoal?.(goal)
    },
    getProjectPath() {
      return api()?.getProjectPath?.() || props.projectPath || props.project_path || ''
    },
    setProjectPath(path) {
      api()?.setProjectPath?.(path)
    },
    setPlan(plan = {}) {
      props = {
        ...props,
        goal: plan.goal || '',
        steps: plan.steps || [],
        canvas: plan.canvas || null,
        projectPath: plan.project_path || plan.projectPath || '',
      }
      planKey += 1
      render()
    },
    setAppMeta(meta = {}) {
      props = { ...props, ...meta }
      render()
    },
    setExecStatus(byRef) {
      api()?.setExecStatus?.(byRef || {})
    },
    clearExecStatus() {
      api()?.clearExecStatus?.()
    },
    setInspectStep(handler) {
      props = { ...props, onInspectStep: handler || undefined }
      render()
    },
    destroy() {
      root.unmount()
      roots.delete(container)
      container.innerHTML = ''
      container.classList.remove('app-wf-mounted')
    },
  }
}

export function unmountAppWorkflowCanvas(container) {
  const root = roots.get(container)
  if (root) {
    root.unmount()
    roots.delete(container)
  }
}
