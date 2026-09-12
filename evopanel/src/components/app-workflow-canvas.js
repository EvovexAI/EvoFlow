/**
 * 应用中心工作流画布 — React Flow（与 FastGPT 同款 @xyflow/react）
 */
import { createElement, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { AppWorkflowCanvas } from '../react/components/AppWorkflowCanvas.tsx'

const roots = new WeakMap()

/**
 * @param {HTMLElement} container
 * @param {{ goal?: string, steps?: object[], canvas?: object, variant?: string, onSave?: Function, onPublish?: Function }} options
 */
export function mountAppWorkflowCanvas(container, options = {}) {
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
        onSave: props.onSave || (async () => {}),
        onPublish: props.onPublish || (async () => {}),
        onOpenAppSettings: props.onOpenAppSettings,
        onOpenHistory: props.onOpenHistory,
        onOpenVersions: props.onOpenVersions,
        onOpenApiAccess: props.onOpenApiAccess,
        appName: props.appName || '',
        appStatus: props.appStatus || 'draft',
        appIcon: props.appIcon || '◇',
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
    setPlan(plan = {}) {
      props = {
        ...props,
        goal: plan.goal || '',
        steps: plan.steps || [],
        canvas: plan.canvas || null,
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
