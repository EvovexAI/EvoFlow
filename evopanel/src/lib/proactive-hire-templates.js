/**
 * 雇佣弹窗「从模板开始」预填（与 playbooks 首批切口对齐）。
 * 岗位名用现实世界职称，仅前端预填职责/策略/节奏，不自动创建组织树。
 */

/** @typedef {{
 *   id: string,
 *   label: string,
 *   blurb: string,
 *   role_name: string,
 *   responsibilities: string[],
 *   autonomy_level: 'full_auto'|'approval_for_risky'|'approval_for_all',
 *   heartbeat_schedule: string,
 *   domain_scope?: string[],
 * }} HireTemplate */

/** @type {HireTemplate[]} */
export const HIRE_TEMPLATES = [
  {
    id: 'dev-assistant',
    label: '研发助理',
    blurb: '独立开发者：盯仓库脏文件、临时垃圾与异常目录',
    role_name: '研发助理',
    responsibilities: [
      '每轮检查管辖工作区：未提交的调试日志、超大临时文件、明显垃圾目录',
      '把问题写成清单落盘到工作区（路径写进任务总结），不要擅自大规模删除',
      '下班前写简短工作汇报：扫了哪、发现什么、建议人处理什么',
    ],
    autonomy_level: 'approval_for_all',
    heartbeat_schedule: '0 9-19/2 * * *',
  },
  {
    id: 'ops-oncall',
    label: '运维值班',
    blurb: '运维：探活服务、异常时写工作汇报',
    role_name: '运维值班',
    responsibilities: [
      '按职责检查关键服务是否可达（如 gateway / 数据库），先确认可达再看异常迹象',
      '异常时写出根因分析与建议，推送前若需审批则等待同意；不擅自改生产配置',
      '每轮/下班写值班报告到工作区，任务总结写清结论与报告路径',
    ],
    autonomy_level: 'approval_for_all',
    heartbeat_schedule: '*/30 9-19 * * *',
  },
  {
    id: 'study-coach',
    label: '学习助理',
    blurb: '学生：对照计划提醒与整理笔记',
    role_name: '学习助理',
    responsibilities: [
      '对照工作区里的学习计划文件，检查今日应完成项是否有对应笔记/产出',
      '列出拖延与缺项清单；可整理笔记提纲，但不代替考试作答或代写论文终稿',
      '晚上写简短工作汇报：今日进度与明日建议复习点',
    ],
    autonomy_level: 'approval_for_risky',
    heartbeat_schedule: '0 9-19 * * *',
  },
  {
    id: 'content-planner',
    label: '内容策划',
    blurb: '抖音/飞书获客：盯选题日历与素材缺口',
    role_name: '内容策划',
    responsibilities: [
      '对照工作区选题日历/大纲，检查今日应产出的标题、脚本草稿或素材是否齐',
      '列出缺口与可拍角度；草稿可写，不擅自发布到平台',
      '汇报里写清：还差什么、建议你拍哪一条、相关文件路径',
    ],
    autonomy_level: 'approval_for_risky',
    heartbeat_schedule: '0 9-19/3 * * *',
  },
  {
    id: 'docs-admin',
    label: '文档管理员',
    blurb: '知识库：断链、重复与过期页',
    role_name: '文档管理员',
    responsibilities: [
      '抽查管辖文档目录：断链、明显重复页、标注过期却仍当现行的说明',
      '把问题清单落盘到工作区；不擅自批量删改他人正文，除非职责明确允许',
      '汇报里写清：扫了哪几处、优先修哪三条',
    ],
    autonomy_level: 'approval_for_risky',
    heartbeat_schedule: '0 10 * * *',
  },
]

export function hireTemplateById(id) {
  return HIRE_TEMPLATES.find((t) => t.id === String(id || '').trim()) || null
}
