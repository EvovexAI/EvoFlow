import { describe, expect, it } from 'vitest'
import {
  automationExpectedOutputItems,
  coerceOutputsFromMessyText,
  filterDeliverableOutputs,
  isAutomationCollabTask,
  outputDisplayName,
  outputFileBasename,
  parseTaskResultSections,
  renderTaskOutputCardsHtml,
  resolveTaskOutputItems,
  splitPathLabelSuffix,
  taskOutputsOf,
  mergeRollupOutputsOntoTask,
} from '../src/lib/task-summary.js'
import {
  agentCodeFromRoleOutputPath,
  isThreadSandboxWorkspacePath,
} from '../src/lib/task-output-preview.js'

describe('splitPathLabelSuffix', () => {
  it('repairs path.md,label:标题}]', () => {
    const { path, label } = splitPathLabelSuffix(
      'docs/roles/x/20260722-14/抖音口播稿_EvoFlow智能体员工.md,label:抖音口播稿 - EvoFlow智能体员工}]',
    )
    expect(path).toBe('docs/roles/x/20260722-14/抖音口播稿_EvoFlow智能体员工.md')
    expect(label).toBe('抖音口播稿 - EvoFlow智能体员工')
  })
})

describe('coerceOutputsFromMessyText', () => {
  it('parses pseudo-JSON outputs blob', () => {
    const items = coerceOutputsFromMessyText(
      '[{docs/roles/evoflow-marketing-director/20260722-14/抖音口播稿_EvoFlow智能体员工.md,label:抖音口播稿 - EvoFlow智能体员工}]',
    )
    expect(items).toHaveLength(1)
    expect(items[0].value).toContain('抖音口播稿_EvoFlow智能体员工.md')
    expect(items[0].value).not.toContain('label:')
    expect(items[0].label).toBe('抖音口播稿 - EvoFlow智能体员工')
  })

  it('parses type:file,key:…,value:… blob', () => {
    const items = coerceOutputsFromMessyText(
      'type:file,key:口播稿,value:docs/roles/evoflow-marketing-director/20260722-14/抖音口播稿_EvoFlow智能体员工.md',
    )
    expect(items).toHaveLength(1)
    expect(items[0].key).toBe('口播稿')
    expect(items[0].value).toBe(
      'docs/roles/evoflow-marketing-director/20260722-14/抖音口播稿_EvoFlow智能体员工.md',
    )
  })
})

describe('taskOutputsOf', () => {
  it('repairs dirty value fields already in outputs array', () => {
    const items = taskOutputsOf({
      outputs: [
        {
          type: 'file',
          key: 'script',
          value:
            'type:file,key:口播稿,value:docs/roles/x/20260722-14/抖音口播稿_EvoFlow智能体员工.md',
          label: '抖音口播稿 - EvoFlow智能体员工',
        },
      ],
    })
    expect(items[0].value).toBe('docs/roles/x/20260722-14/抖音口播稿_EvoFlow智能体员工.md')
    expect(items[0].label).toBe('抖音口播稿 - EvoFlow智能体员工')
    expect(outputDisplayName(items[0])).toBe('抖音口播稿 - EvoFlow智能体员工')
    expect(outputFileBasename(items[0])).toBe('抖音口播稿_EvoFlow智能体员工.md')
  })
})

describe('parseTaskResultSections path capture', () => {
  it('does not swallow ,label: into mentionedPaths', () => {
    const { mentionedPaths } = parseTaskResultSections(
      '产出 docs/roles/x/a.md,label:标题}] 已写好。',
    )
    expect(mentionedPaths).toEqual(['docs/roles/x/a.md'])
  })
})

describe('renderTaskOutputCardsHtml', () => {
  it('shows clean title and preview action', () => {
    const html = renderTaskOutputCardsHtml(
      {
        outputs: [
          {
            type: 'file',
            value: 'docs/roles/x/a.md',
            label: '抖音口播稿 - EvoFlow智能体员工',
          },
        ],
      },
      (s) =>
        String(s ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;'),
    )
    expect(html).toContain('抖音口播稿 - EvoFlow智能体员工')
    expect(html).toContain('data-act="preview-output"')
    expect(html).toContain('预览')
    expect(html).toContain('td-output-row')
    expect(html).not.toContain(',label:')
    expect(html).not.toContain('📄')
  })

  it('hides source code paths from 本岗交付物', () => {
    const html = renderTaskOutputCardsHtml(
      {
        outputs: [
          {
            type: 'file',
            label: '技术审核报告',
            value: 'ContentOS/docs/roles/quality-inspector/20260725-03/button-copy-review.md',
          },
          {
            type: 'file',
            label: '技术审核报告',
            value: 'docs/roles/quality-inspector/20260725-03/button-copy-review.md',
          },
          {
            type: 'file',
            label: 'page',
            value: 'ContentOS/apps/web/src/app/contents/page.tsx',
          },
        ],
        summary: '已改 ContentOS/apps/web/src/app/contents/page.tsx',
      },
      (s) => String(s ?? ''),
    )
    expect(html).toContain('button-copy-review.md')
    expect(html).not.toContain('page.tsx')
  })
})

describe('mergeRollupOutputsOntoTask', () => {
  it('prefers rollup summary outputs over intermediate step files', () => {
    const task = {
      outputs: [
        { type: 'file', key: 'a', value: 'out/step1.md' },
        { type: 'file', key: 'b', value: 'out/step2.md' },
      ],
      subtasks: [
        {
          ref: '1',
          status: 'completed',
          outputs: [{ type: 'file', key: 'a', value: 'out/step1.md' }],
        },
        {
          ref: '__rollup__',
          is_rollup_step: true,
          status: 'completed',
          outputs: [{ type: 'file', key: 'final', value: 'out/final_report.md', label: '汇总报告' }],
        },
      ],
    }
    const view = mergeRollupOutputsOntoTask(task)
    expect(view.outputs).toHaveLength(1)
    expect(view.outputs[0].value).toBe('out/final_report.md')
    const items = resolveTaskOutputItems(view)
    expect(items.every((i) => i.value.includes('final_report'))).toBe(true)
    expect(items.some((i) => i.value.includes('step1'))).toBe(false)
  })
})

describe('filterDeliverableOutputs', () => {
  it('drops code and dedupes repo-prefixed docs', () => {
    const items = filterDeliverableOutputs([
      {
        type: 'file',
        value: 'ContentOS/docs/roles/x/a.md',
        label: 'a',
      },
      { type: 'file', value: 'docs/roles/x/a.md', label: 'a' },
      { type: 'file', value: 'apps/web/src/page.tsx', label: 'code' },
    ])
    expect(items).toHaveLength(1)
    expect(items[0].value).toContain('a.md')
  })

  it('resolveTaskOutputItems ignores code in summary mentions', () => {
    const resolved = resolveTaskOutputItems({
      outputs: [{ type: 'file', value: 'docs/roles/x/a.md', label: '方案' }],
      summary: '已改 ContentOS/apps/web/src/app/contents/page.tsx 文案',
    })
    expect(resolved.every((i) => !String(i.value).endsWith('.tsx'))).toBe(true)
  })
})

describe('role workspace helpers', () => {
  it('detects thread sandbox paths', () => {
    expect(
      isThreadSandboxWorkspacePath(
        'C:\\Users\\admin\\.evoflow\\threads\\2b8e947a-b06a-47e2-9ad4-fc8eaa418a55\\user-data\\workspace',
      ),
    ).toBe(true)
    expect(isThreadSandboxWorkspacePath('D:/dev/github/EvoFlow')).toBe(false)
  })

  it('infers agent_code from docs/roles path', () => {
    expect(
      agentCodeFromRoleOutputPath(
        'docs/roles/evoflow-marketing-director/20260722-14/抖音口播稿_EvoFlow智能体员工.md',
      ),
    ).toBe('evoflow-marketing-director')
  })

  it('keeps Windows absolute deliverable paths (no drive strip)', async () => {
    const { healStrippedAbsolutePath } = await import('../src/lib/workspace-abs-path.js')
    const { extractOutputPathFields } = await import('../src/lib/task-summary.js')
    const root = 'D:/dev/github/EvoFlow'
    const abs = 'D:/dev/github/EvoFlow/output/smart-employee-test/note.md'
    expect(extractOutputPathFields(abs).path).toBe(abs)
    expect(healStrippedAbsolutePath(':/dev/github/EvoFlow/output/smart-employee-test/note.md', root)).toBe(
      abs,
    )
    expect(
      healStrippedAbsolutePath('/dev/github/EvoFlow/output/smart-employee-test/note.md', root),
    ).toBe(abs)
  })
})

describe('automation deliverable outputs', () => {
  it('detects automation collab tasks', () => {
    expect(isAutomationCollabTask({ automation_id: 'bd105575' })).toBe(true)
    expect(isAutomationCollabTask({})).toBe(false)
  })

  it('prefers canonical automation_output_path over summary mentions', () => {
    const items = resolveTaskOutputItems({
      automation_id: 'bd105575',
      automation_name: '每日AI日报',
      automation_output_path: 'C:/Users/admin/.evoflow/outputs/automations/bd105575/20260824.md',
      automation_output_rel: 'outputs/automations/bd105575/20260824.md',
      result: '产出 outputs/ai-daily-report-20260824.md 已写好',
    })
    expect(items.some((i) => i.value.includes('automations/bd105575/20260824.md'))).toBe(true)
    expect(items.some((i) => i.value.includes('ai-daily-report'))).toBe(false)
  })

  it('renders existence badge for automation expected deliverable', () => {
    const html = renderTaskOutputCardsHtml(
      {
        automation_id: 'bd105575',
        automation_name: '每日AI日报',
        automation_output_rel: 'outputs/automations/bd105575/20260824.md',
      },
      (s) => String(s ?? ''),
    )
    expect(html).toContain('td-output-badge')
    expect(html).toContain('data-path-for-existence')
    expect(automationExpectedOutputItems({ automation_output_rel: 'outputs/x/y.md' })).toHaveLength(1)
  })
})
