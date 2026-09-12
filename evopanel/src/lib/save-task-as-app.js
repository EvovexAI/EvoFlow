/**
 * Prompt + POST /tasks/{id}/save-as-app → navigate to app editor.
 * Shared by task-detail and chat PlanExecConfirm.
 */
import { api } from './tauri-api.js'
import { toast } from '../components/toast.js'
import { showModal } from '../components/modal.js'

/**
 * @param {{
 *   taskId: string,
 *   defaultName?: string,
 *   defaultDescription?: string,
 *   navigateToApp?: boolean,
 * }} opts
 */
export function promptSaveTaskAsApp(opts) {
  const taskId = String(opts?.taskId || '').trim()
  if (!taskId) {
    toast.error('无关联任务，无法另存为工作流')
    return
  }

  showModal({
    title: '另存为工作流',
    width: 480,
    fields: [
      {
        name: 'name',
        label: '工作流名称',
        value: String(opts.defaultName || '').trim() || '未命名工作流',
        placeholder: '例如：竞品分析周报',
      },
      {
        name: 'description',
        label: '描述',
        type: 'textarea',
        rows: 2,
        value: String(opts.defaultDescription || '').trim(),
        placeholder: '一句话说明这个工作流做什么',
      },
      {
        name: 'execution_mode',
        label: '默认执行模式',
        type: 'select',
        value: 'workflow',
        options: [
          { value: 'workflow', label: '按步骤自动跑完（推荐）' },
          { value: 'lead_supervised', label: '先生成计划再确认' },
        ],
      },
      {
        name: 'auto_extract',
        label: '自动抽取参数（{{…}}）',
        type: 'checkbox',
        value: true,
        hint: '从计划文本识别可变内容并生成运行参数（最多 5 个）',
      },
    ],
    onConfirm: async (result) => {
      try {
        const created = await api.saveTaskAsApp(taskId, {
          name: String(result.name || '').trim() || undefined,
          description: String(result.description || '').trim() || undefined,
          execution_mode: result.execution_mode || 'workflow',
          auto_extract: !!result.auto_extract,
          max_params: 5,
        })
        toast.success('已另存为工作流')
        if (opts.navigateToApp !== false && created?.id) {
          window.location.hash = `#/apps/${created.id}`
        }
      } catch (e) {
        toast.error('另存为工作流失败: ' + (e?.message || e))
      }
    },
  })
}
