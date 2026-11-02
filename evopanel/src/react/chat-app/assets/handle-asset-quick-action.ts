/**
 * One-click asset deposit prompts (episode / craft / journal).
 * Aligned with Entity Asset Hub: assets(action="note") → memory/_inbox/notes/
 * (Phase2 consolidates to episodic / craft / journal). Extracted from ChatApp.tsx (P33).
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

  const writeRule =
    '落盘方式（强制）：只用 `assets(action="note", content="…")`，首行带对应标签；工具会写入 `memory/_inbox/notes/<slug>.md`，由 Phase2 合并到正式目录。禁止直写 `memory/episodic/`、`memory/journal/`、`craft/`，禁止 `craft/<name>/SKILL.md`（已改为扁平 `craft/<name>.md`）。'

  const messages = {
    episode: [
      '请根据刚才整段对话，把「这次对话的过程」整理成一篇过程记录并沉淀到资产。',
      ownerLine,
      writeRule,
      '标签用 `[process]`。用途：给人以后回顾这段对话走过了什么、结论/约定是什么；不是沉淀经验（怎么做），也不是反思（日结/判断）。',
      'content 示例首行：`[process] 短标题`；正文按时间线或要点写清过程；标题旁可加一句 10～30 字摘要。',
      '不要再问我要写什么；自行总结并用 assets note 保存。',
    ].join('\n'),
    journal: [
      '请根据刚才的对话，直接写一段今日反思并沉淀到资产。',
      ownerLine,
      writeRule,
      '标签用 `[reflection]`。content 示例首行：`[reflection] 短标题`（短标题即主题，Phase2 后正式文件名也用主题 slug，**不要**带年月日）；正文写判断、教训与下次注意点；可附一句 10～30 字摘要。',
      '不要再问我要写什么；自行总结并用 assets note 保存。',
    ].join('\n'),
    craft: [
      '请把刚才对话里可复用的做法，直接沉淀成一条经验。',
      ownerLine,
      writeRule,
      '标签用 `[experience]`。content 示例首行：`[experience] 短标题`；正文写适用场景、关键步骤、反例/避坑；可附一句 10～30 字描述。',
      '不要再问我要标题或正文；自行总结并用 assets note 保存。',
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
