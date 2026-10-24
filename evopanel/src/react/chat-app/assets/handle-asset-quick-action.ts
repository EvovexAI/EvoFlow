/**
 * One-click asset deposit prompts (episode / craft / journal).
 * Extracted from ChatApp.tsx (P33).
 */
import { toast } from '../../../components/toast.js'

export type HandleAssetQuickActionCtx = {
  employeeSessionAgentCode: string | null | undefined
  isProactiveEmployeeSession: boolean
  selectedTurnBusy: boolean
  getApi: () => Promise<{
    assetsListEntities: () => Promise<{ entities?: Array<{ entityType?: unknown; entityId?: unknown }> }>
  }>
  setAssetQuickBusy: (busy: boolean) => void
  sendMessage: (text: string) => Promise<unknown> | unknown
}

export async function handleAssetQuickAction(
  ctx: HandleAssetQuickActionCtx,
  kind: 'episode' | 'craft' | 'journal',
): Promise<void> {
  const empCode = String(ctx.employeeSessionAgentCode || '').trim().toLowerCase()
  const forEmployee = ctx.isProactiveEmployeeSession && !!empCode
  let myUserRoot = 'user'
  try {
    const api = await ctx.getApi()
    const payload = await api.assetsListEntities()
    const rows = Array.isArray(payload?.entities) ? payload.entities : []
    const myEntity = rows.find(
      (e) => String(e?.entityType || '').toLowerCase() === 'user',
    )
    if (myEntity && String(myEntity.entityId || '').trim()) {
      myUserRoot = String(myEntity.entityId).trim()
    }
  } catch {
    // 网络失败时保持 legacy 'user' 回退，避免按钮报错卡死。
  }
  const ownerLine = forEmployee
    ? `写入智能体员工「${empCode}」自己的资产目录（employees/${empCode}/，与用户同级），不要写到用户「我」的资产目录（assets/${myUserRoot}/）。`
    : `写入用户「我」的资产目录（assets/${myUserRoot}/，多用户安装里形如 assets/users/<id>/）。`

  const messages = {
    episode: [
      '请根据刚才整段对话，把「这次对话的过程」整理成一篇过程记录，写入资产（memory/episodic/{日期}-{slug}.md）。',
      ownerLine,
      '用途：给人以后回顾这段对话走过了什么、结论/约定是什么；不是沉淀经验（怎么做），也不是反思（日结/判断）。',
      '文件必须带 YAML frontmatter：title + summary（短描述 10～30 字，能辨认即可，勿写长）+ 可选 tags；正文按时间线或要点写清过程。',
      '落盘前自检：soul 块内容若与 system_prompt 高度重叠，去重后再写——避免下一次注入时同义反复。',
      '不要再问我要写什么；自行总结并保存。',
    ].join('\n'),
    journal: [
      '请根据刚才的对话，直接写一段今日反思并沉淀到资产（memory/journal/{今天}.md）。',
      ownerLine,
      '文件必须带 YAML frontmatter：date + summary（短描述 10～30 字，能辨认即可，勿写长）+ 可选 tags；正文再写详细反思。',
      '落盘前自检：soul 块内容若与 system_prompt 高度重叠，去重后再写——避免下一次注入时同义反复。',
      '不要再问我要写什么；自行总结并保存。',
    ].join('\n'),
    craft: [
      '请把刚才对话里可复用的做法，直接沉淀成一条经验（craft/{name}/SKILL.md）。',
      ownerLine,
      'SKILL.md 必须带 frontmatter：name + description（短描述 10～30 字，能辨认即可，勿写长）；正文再写步骤/结论。',
      '落盘前自检：soul 块内容若与 system_prompt 高度重叠，去重后再写——避免下一次注入时同义反复。',
      '不要再问我要标题或正文；自行总结并保存。',
    ].join('\n'),
  } as const

  if (ctx.selectedTurnBusy) {
    toast('当前正在回复，请稍后再沉淀', 'warning')
    return
  }
  ctx.setAssetQuickBusy(true)
  void Promise.resolve(ctx.sendMessage(messages[kind])).finally(() => {
    ctx.setAssetQuickBusy(false)
  })
}
