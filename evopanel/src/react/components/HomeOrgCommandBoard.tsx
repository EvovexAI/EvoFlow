/**
 * 首页「总览」指挥台：你（老板）→ 小V（大管家）→ 各部门员工。
 * 视觉对齐参考指挥台：深色底、青/橙描边、中文标签。
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { X } from 'lucide-react'
import { api } from '../../lib/tauri-api.js'
import { openShellPageInRightStage } from '../../lib/right-stage/open-shell-page-stage.js'
import { HomeDeptGroupChat } from './HomeDeptGroupChat.js'
import { DeptAvatar, normalizeDeptAvatarId } from './DeptAvatar.js'
import {
  deptChatSessionKey,
  rememberDeptChatMeta,
} from '../lib/dept-chat-session.js'

export type HomeCmdPerson = {
  agent_code: string
  role_name: string
  department: string
  reports_to: string
  status: string
  busy: boolean
  summary: string
  last_heartbeat_at?: string
  next_heartbeat_at?: string
  schedule_summary?: string
  busy_started_at?: string
}

function formatCmdClock(raw?: string | null): string {
  if (!raw) return ''
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startYesterday = new Date(startToday.getTime() - 86400000)
  const hh = `${d.getHours()}`.padStart(2, '0')
  const mm = `${d.getMinutes()}`.padStart(2, '0')
  const clock = `${hh}:${mm}`
  if (d >= startToday) return clock
  if (d >= startYesterday) return `昨天 ${clock}`
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${m}/${day} ${clock}`
}

export type HomeCmdDept = {
  id: string
  name: string
  /** 部门头像预设 id（裸 id，如 ``studio``）；空则头像兜底文字 */
  avatar?: string
  head_agent_code: string
  head_role_name: string
  members: HomeCmdPerson[]
  busyCount: number
  accent: string
}

/** 对标参考：小V=青，部门=青/绿轮换；老板保留橙作人类节点 */
const ACCENTS = ['cyan', 'green'] as const
const XIAOMI_CODE = 'xiaomi'

function roleCode(r: any): string {
  return String(r?.agent_code || r?.code || '').trim()
}

function roleName(r: any): string {
  return (
    String(r?.role_name || r?.display_name || r?.name || r?.agent_name || '').trim() ||
    '未命名'
  )
}

function roleDept(r: any): string {
  return String(r?.department || r?.config?.department || '').trim()
}

function roleReportsTo(r: any): string {
  return String(r?.reports_to || r?.config?.reports_to || '').trim()
}

function isBridge(r: any): boolean {
  return !!(r?.is_bridge || r?.isBridge)
}

function isBusyRes(busyRes: any): boolean {
  return !!(busyRes?.busy || busyRes?.is_busy)
}

/** 在岗 / 不在岗：暂停、草稿等视为不在岗 */
export function isPersonOnDuty(p: { status?: string; busy?: boolean }): boolean {
  if (p.busy) return true
  const st = String(p.status || 'active').trim().toLowerCase()
  return !st || st === 'active'
}

export function personDutyLabel(p: { status?: string; busy?: boolean }): string {
  if (p.busy) return '执行中'
  return isPersonOnDuty(p) ? '在岗' : '不在岗'
}

function deptLastActivityClock(members: HomeCmdPerson[]): string {
  let best = 0
  let label = ''
  for (const m of members) {
    const raw = m.busy_started_at || m.last_heartbeat_at
    if (!raw) continue
    const t = new Date(raw).getTime()
    if (Number.isNaN(t) || t <= best) continue
    best = t
    label = formatCmdClock(raw)
  }
  return label || '—'
}

function resolveXiaomi(roles: any[], roleBusyByCode: Record<string, any>): HomeCmdPerson {
  const hit = (Array.isArray(roles) ? roles : []).find((r) => roleCode(r).toLowerCase() === XIAOMI_CODE)
  const busySnap = roleBusyByCode?.[XIAOMI_CODE] || roleBusyByCode?.[hit ? roleCode(hit) : ''] || {}
  const busy = isBusyRes(busySnap)
  const st = String(hit?.status || 'active').trim() || 'active'
  return {
    agent_code: XIAOMI_CODE,
    role_name: hit ? roleName(hit) : '小V',
    department: '秘书处',
    reports_to: '',
    status: st,
    busy,
    summary: busy ? '正在协调各部门' : '汇总 / 派活 / 验收',
    last_heartbeat_at: String(hit?.last_heartbeat_at || '').trim() || undefined,
    next_heartbeat_at: String(hit?.next_heartbeat_at || '').trim() || undefined,
    schedule_summary: String(hit?.schedule_summary || hit?.heartbeat_schedule || '').trim() || undefined,
    busy_started_at: String(busySnap?.started_at || '').trim() || undefined,
  }
}

function buildDeptBoard(
  roles: any[],
  departments: any[],
  roleBusyByCode: Record<string, any>,
): HomeCmdDept[] {
  const people = (Array.isArray(roles) ? roles : []).filter((r) => {
    const code = roleCode(r)
    if (!code || code === 'main') return false
    if (code.toLowerCase() === XIAOMI_CODE) return false
    if (isBridge(r)) return false
    const st = String(r?.status || 'active').trim().toLowerCase()
    return !st || st === 'active' || st === 'paused' || st === 'draft'
  })

  const byDept = new Map<string, any[]>()
  const unassigned: any[] = []
  for (const r of people) {
    const d = roleDept(r)
    if (!d) {
      unassigned.push(r)
      continue
    }
    if (!byDept.has(d)) byDept.set(d, [])
    byDept.get(d)!.push(r)
  }

  const toPerson = (r: any): HomeCmdPerson => {
    const code = roleCode(r)
    const busySnap = roleBusyByCode?.[code] || {}
    const busy = isBusyRes(busySnap)
    const st = String(r?.status || 'active').trim() || 'active'
    return {
      agent_code: code,
      role_name: roleName(r),
      department: roleDept(r),
      reports_to: roleReportsTo(r),
      status: st,
      busy,
      summary: busy ? '在岗执行' : st === 'paused' ? '已暂停' : '在岗待命',
      last_heartbeat_at: String(r?.last_heartbeat_at || '').trim() || undefined,
      next_heartbeat_at: String(r?.next_heartbeat_at || '').trim() || undefined,
      schedule_summary: String(r?.schedule_summary || r?.heartbeat_schedule || '').trim() || undefined,
      busy_started_at: String(busySnap?.started_at || '').trim() || undefined,
    }
  }

  const sortMembers = (members: HomeCmdPerson[], headCode: string) => {
    members.sort((a, b) => {
      if (headCode) {
        const ah = a.agent_code === headCode ? 0 : 1
        const bh = b.agent_code === headCode ? 0 : 1
        if (ah !== bh) return ah - bh
      }
      if (a.busy !== b.busy) return a.busy ? -1 : 1
      return a.role_name.localeCompare(b.role_name, 'zh-CN')
    })
    return members
  }

  const out: HomeCmdDept[] = []
  const seen = new Set<string>()
  let accentIdx = 0

  const pushDept = (
    id: string,
    name: string,
    membersRaw: any[],
    headCode = '',
    headName = '',
    avatar = '',
  ) => {
    const members = sortMembers(membersRaw.map(toPerson), headCode)
    // 指挥台只展示有人的部门，空壳部门不占位
    if (!members.length) return
    out.push({
      id,
      name,
      avatar: String(avatar || '').trim(),
      head_agent_code: headCode,
      head_role_name: headName,
      members,
      busyCount: members.filter((m) => m.busy).length,
      accent: ACCENTS[accentIdx % ACCENTS.length],
    })
    accentIdx += 1
  }

  for (const d of Array.isArray(departments) ? departments : []) {
    const name = String(d?.name || '').trim()
    if (!name) continue
    seen.add(name)
    const id = String(d?.id || '').trim() || `name:${name}`
    pushDept(
      id,
      name,
      byDept.get(name) || [],
      String(d?.head_agent_code || '').trim(),
      String(d?.head_role_name || '').trim(),
      String(d?.avatar || '').trim(),
    )
  }
  for (const [name, members] of byDept.entries()) {
    if (seen.has(name)) continue
    pushDept(`name:${name}`, name, members)
  }
  pushDept('__none__', '未分部门', unassigned)
  return out
}

export type HomeOrgCommandBoardProps = {
  roles?: any[]
  roleBusyByCode?: Record<string, any>
  waitForYou?: number
  loading?: boolean
}

export function HomeOrgCommandBoard({
  roles = [],
  roleBusyByCode = {},
  waitForYou = 0,
  loading = false,
}: HomeOrgCommandBoardProps) {
  const [departments, setDepartments] = useState<any[]>([])
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  /** 部门侧栏：默认部门信息；群聊为次要入口 */
  const [deptPanel, setDeptPanel] = useState<'info' | 'chat'>('info')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await api.proactiveListDepartments()
        if (cancelled) return
        const rows = Array.isArray(res?.departments) ? res.departments : Array.isArray(res) ? res : []
        setDepartments(rows)
      } catch {
        if (!cancelled) setDepartments([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const depts = useMemo(
    () => buildDeptBoard(roles, departments, roleBusyByCode),
    [roles, departments, roleBusyByCode],
  )
  const xiaomi = useMemo(() => resolveXiaomi(roles, roleBusyByCode), [roles, roleBusyByCode])
  const allPeople = useMemo(() => [xiaomi, ...depts.flatMap((d) => d.members)], [xiaomi, depts])

  const selectedPerson = useMemo(() => {
    if (!selectedKey?.startsWith('person:')) return null
    const code = selectedKey.slice('person:'.length)
    return allPeople.find((p) => p.agent_code === code) || null
  }, [selectedKey, allPeople])

  const selectedDept = useMemo(() => {
    if (!selectedKey?.startsWith('dept:')) return null
    const id = selectedKey.slice('dept:'.length)
    return depts.find((d) => d.id === id) || null
  }, [selectedKey, depts])

  const openPerson = (code: string) => {
    const key = `person:${code}`
    setDeptPanel('info')
    setSelectedKey((cur) => (cur === key ? null : key))
  }
  const openDept = (id: string) => {
    const key = `dept:${id}`
    setDeptPanel('info')
    setSelectedKey((cur) => (cur === key ? null : key))
  }

  const hasDetail = !!(selectedPerson || selectedDept)
  const stewardSelected = selectedPerson?.agent_code === XIAOMI_CODE
  /** 选中下级时，点亮「该节点 → 部门 → 小V」整条祖先链；未选中则全部正常色、不发亮 */
  const litDeptId = useMemo(() => {
    if (selectedDept) return selectedDept.id
    if (!selectedPerson || selectedPerson.agent_code === XIAOMI_CODE) return null
    const hit = depts.find((d) => d.members.some((m) => m.agent_code === selectedPerson.agent_code))
    return hit?.id || null
  }, [selectedDept, selectedPerson, depts])
  const litDeptIndex = litDeptId ? depts.findIndex((d) => d.id === litDeptId) : -1
  const pathActive = !!(stewardSelected || litDeptId)
  const stewardOnPath = pathActive
  /** 点小V：全扇脉冲；点部门/员工：只脉冲那条支路 */
  const fanBroadcast = stewardSelected
  const fanLive = fanBroadcast || litDeptIndex >= 0
  const n = Math.max(depts.length, 1)
  const fanRef = useRef<HTMLDivElement | null>(null)
  const deptsRef = useRef<HTMLDivElement | null>(null)
  /** 各部门卡中心在扇形 SVG viewBox(0–1000) 上的 x；换行到第二排的为 null */
  const [branchXs, setBranchXs] = useState<(number | null)[]>(() =>
    Array.from({ length: n }, (_, i) => ((i + 0.5) / n) * 1000),
  )

  useLayoutEffect(() => {
    const fanEl = fanRef.current
    const deptsEl = deptsRef.current
    if (!fanEl || !deptsEl || !depts.length) return

    const measure = () => {
      const fanRect = fanEl.getBoundingClientRect()
      if (fanRect.width < 8) return
      const cards = Array.from(deptsEl.querySelectorAll<HTMLElement>('.evo-home-cmd__dept-node'))
      if (!cards.length) return
      const tops = cards.map((card) => card.getBoundingClientRect().top)
      const rowTop = Math.min(...tops)
      const next = cards.map((card) => {
        const r = card.getBoundingClientRect()
        /* 第二行及以后不连线，避免错位 */
        if (r.top > rowTop + 28) return null
        const cx = r.left + r.width / 2
        return Math.max(8, Math.min(992, ((cx - fanRect.left) / fanRect.width) * 1000))
      })
      setBranchXs((prev) => {
        if (
          prev.length === next.length &&
          prev.every((v, i) => {
            const n = next[i]
            if (v == null && n == null) return true
            if (v == null || n == null) return false
            return Math.abs(v - n) < 0.8
          })
        ) {
          return prev
        }
        return next
      })
    }

    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(fanEl)
    ro.observe(deptsEl)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [depts, hasDetail, selectedKey, n])

  const busyPeople = allPeople.filter((p) => p.busy && p.agent_code !== XIAOMI_CODE).length
  const lastBeat = formatCmdClock(xiaomi.busy_started_at || xiaomi.last_heartbeat_at)
  const nextBeat = formatCmdClock(xiaomi.next_heartbeat_at)
  const scheduleHint = xiaomi.schedule_summary
    ? String(xiaomi.schedule_summary).replace(/\s+/g, ' ').slice(0, 28)
    : '按值班节奏巡视'

  return (
    <div className={`evo-home-cmd${pathActive ? ' is-path-live' : ''}`}>
      <div
        className={`evo-home-cmd__stage${hasDetail ? ' has-detail' : ''}${
          selectedDept && deptPanel === 'chat' ? ' has-group-chat' : ''
        }`}
      >
        <div className="evo-home-cmd__canvas" aria-label="组织流转图">
          <div className="evo-home-cmd__tree">
            {/* 老板：橙边胶囊 + 等你 N 件 */}
            <div className="evo-home-cmd__tier evo-home-cmd__tier--you">
              <button
                type="button"
                className={`evo-home-cmd__you${pathActive ? ' is-path' : ''}`}
                onClick={() => setSelectedKey(null)}
              >
                <span className="evo-home-cmd__you-avatar" aria-hidden>
                  你
                </span>
                <span className="evo-home-cmd__you-body">
                  <span className="evo-home-cmd__you-title">老板</span>
                  <span className="evo-home-cmd__you-name">创始人 · 拍板定方向</span>
                </span>
                <span className="evo-home-cmd__you-aside">
                  <span className="evo-home-cmd__you-badge">等你 {waitForYou || 0} 件</span>
                  {waitForYou > 0 ? (
                    <span className="evo-home-cmd__you-due">需尽快处理</span>
                  ) : (
                    <span className="evo-home-cmd__you-due">暂无待办</span>
                  )}
                </span>
              </button>
            </div>

            {/* 双向流转：双轨竖线 + 橙↓ / 青↑（时间用真实心跳，无则省略） */}
            <div className="evo-home-cmd__flow" aria-hidden>
              <div className="evo-home-cmd__flow-rail">
                <span className="evo-home-cmd__flow-line evo-home-cmd__flow-line--down" />
                <span className="evo-home-cmd__flow-line evo-home-cmd__flow-line--up" />
              </div>
              <div className="evo-home-cmd__flow-tags">
                <span className="evo-home-cmd__flow-tag evo-home-cmd__flow-tag--down">
                  ↓ 指令下发{nextBeat ? ` ${nextBeat}` : ''}
                </span>
                <span className="evo-home-cmd__flow-tag evo-home-cmd__flow-tag--up">
                  ↑ 汇总上报{lastBeat ? ` ${lastBeat}` : ''}
                </span>
              </div>
            </div>

            {/* 小V = 大管家（对标 CEO 卡） */}
            <div className="evo-home-cmd__tier evo-home-cmd__tier--steward">
              <button
                type="button"
                className={`evo-home-cmd__steward${xiaomi.busy ? ' is-busy' : ''}${
                  stewardSelected ? ' is-selected' : ''
                }${stewardOnPath ? ' is-path' : ''}`}
                onClick={() => openPerson(XIAOMI_CODE)}
              >
                <div className="evo-home-cmd__steward-top">
                  <span className="evo-home-cmd__steward-left">
                    <span
                      className={`evo-home-cmd__status${isPersonOnDuty(xiaomi) ? ' is-on' : ' is-off'}`}
                      aria-hidden
                    />
                    <span className="evo-home-cmd__steward-name">{xiaomi.role_name}</span>
                    <span className="evo-home-cmd__steward-duties">汇总 / 派活 / 验收</span>
                  </span>
                </div>
                <div className="evo-home-cmd__steward-body">
                  {scheduleHint} · 在忙 {busyPeople + (xiaomi.busy ? 1 : 0)} 人 · 待你拍板{' '}
                  {waitForYou} 件
                </div>
                <div className="evo-home-cmd__steward-foot">
                  {lastBeat ? `上次 ${lastBeat}` : '尚无巡视记录'}
                  {nextBeat ? ` · 下次 ${nextBeat}` : ''}
                  {` · ${xiaomi.busy ? '巡视中' : '在岗'}`}
                </div>
              </button>
            </div>

            {!depts.length ? (
              <div className="evo-home-cmd__empty">
                {loading ? '正在加载组织…' : '还没有部门或员工。去「员工」页建部门、加人。'}
              </div>
            ) : (
              <div
                className="evo-home-cmd__org-lower"
                style={{ '--dept-cols': Math.min(Math.max(depts.length, 1), 5) } as CSSProperties}
              >
                {/* 扇形与部门同宽：标签浮层，支路 x 实测部门卡中心 */}
                <div
                  className={`evo-home-cmd__fan-wrap${fanLive ? ' is-live' : ''}${
                    fanBroadcast ? ' is-broadcast' : ''
                  }`}
                  aria-hidden
                >
                  <span className="evo-home-cmd__fan-side evo-home-cmd__fan-side--l">
                    <span>↓ 派工</span>
                    <span>↑ 汇报</span>
                  </span>
                  <div className="evo-home-cmd__fan" ref={fanRef}>
                    <svg
                      className="evo-home-cmd__fan-svg"
                      viewBox="0 0 1000 80"
                      preserveAspectRatio="none"
                    >
                      <defs>
                        <filter id="evo-cmd-fan-glow" x="-50%" y="-50%" width="200%" height="200%">
                          <feGaussianBlur stdDeviation="1.6" result="b" />
                          <feMerge>
                            <feMergeNode in="b" />
                            <feMergeNode in="SourceGraphic" />
                          </feMerge>
                        </filter>
                      </defs>
                      <path
                        className="evo-home-cmd__fan-trunk"
                        d="M500 0 V16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        pathLength={100}
                      />
                      <path
                        className="evo-home-cmd__fan-pulse evo-home-cmd__fan-pulse--tail evo-home-cmd__fan-pulse--trunk"
                        d="M500 0 V16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        pathLength={100}
                      />
                      <path
                        className="evo-home-cmd__fan-pulse evo-home-cmd__fan-pulse--head evo-home-cmd__fan-pulse--trunk"
                        d="M500 0 V16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3.2"
                        pathLength={100}
                      />
                      {depts.map((dept, i) => {
                        const measured = branchXs[i]
                        if (measured == null && branchXs.length) return null
                        const x =
                          typeof measured === 'number' && Number.isFinite(measured)
                            ? measured
                            : ((i + 0.5) / n) * 1000
                        const xf = x.toFixed(1)
                        /* 落到卡顶外缘（略收，避免线头扎进框内） */
                        const d = `M500 16 C500 34, ${xf} 40, ${xf} 56 V76`
                        const active = fanBroadcast || (litDeptIndex >= 0 && i === litDeptIndex)
                        return (
                          <g
                            key={dept.id}
                            className={`evo-home-cmd__fan-branch${active ? ' is-active' : ''}`}
                          >
                            <path
                              className="evo-home-cmd__fan-path"
                              d={d}
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.4"
                              pathLength={100}
                            />
                            <path
                              className="evo-home-cmd__fan-pulse evo-home-cmd__fan-pulse--tail"
                              d={d}
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.7"
                              pathLength={100}
                            />
                            <path
                              className="evo-home-cmd__fan-pulse evo-home-cmd__fan-pulse--head"
                              d={d}
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="3.4"
                              pathLength={100}
                            />
                          </g>
                        )
                      })}
                    </svg>
                  </div>
                  <span className="evo-home-cmd__fan-side evo-home-cmd__fan-side--r">
                    <span>↓ 验收</span>
                    <span>↑ 产出</span>
                  </span>
                </div>

                <div
                  ref={deptsRef}
                  className={`evo-home-cmd__tier evo-home-cmd__tier--depts${
                    fanLive ? ' is-linked' : ''
                  }`}
                >
                  {depts.map((dept) => (
                    <DeptColumn
                      key={dept.id}
                      dept={dept}
                      selectedPersonCode={selectedPerson?.agent_code || null}
                      selectedDeptId={selectedDept?.id || null}
                      onPath={litDeptId === dept.id}
                      showFloat={
                        !selectedPerson &&
                        deptPanel === 'info' &&
                        selectedDept?.id === dept.id
                      }
                      onSelectDept={() => openDept(dept.id)}
                      onSelectPerson={openPerson}
                      onCloseFloat={() => setSelectedKey(null)}
                      onAvatarChanged={(deptId, avatar) => {
                        setDepartments((prev) =>
                          (Array.isArray(prev) ? prev : []).map((d) =>
                            String(d?.id || '') === deptId ? { ...d, avatar } : d,
                          ),
                        )
                      }}
                      onOpenChat={() => {
                        try {
                          rememberDeptChatMeta(dept)
                        } catch {
                          /* ignore */
                        }
                        const sk = deptChatSessionKey(dept.id)
                        if (!sk) {
                          setDeptPanel('chat')
                          return
                        }
                        window.dispatchEvent(
                          new CustomEvent('evopanel:shell-select-session', {
                            detail: { sessionKey: sk },
                          }),
                        )
                      }}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {selectedPerson ? (
          <PersonDetail
            person={selectedPerson}
            onClose={() => setSelectedKey(null)}
            onOpenEmployee={() => {
              const code = String(selectedPerson.agent_code || '').trim()
              if (!code) return
              const name = String(selectedPerson.role_name || '').trim() || code
              openShellPageInRightStage({
                path: `/proactive/${encodeURIComponent(code)}`,
                mountId: 'employees.detail',
                title: name,
                entityLabel: name,
                agentCode: code,
                layout: 'wide',
              })
            }}
          />
        ) : selectedDept && deptPanel === 'chat' ? (
          <HomeDeptGroupChat
            dept={selectedDept}
            onClose={() => setDeptPanel('info')}
            onOpenEmployeePage={(code) => {
              const agentCode = String(code || '').trim()
              if (!agentCode) return
              const member = selectedDept.members.find((m) => m.agent_code === agentCode)
              const name = String(member?.role_name || '').trim() || agentCode
              openShellPageInRightStage({
                path: `/proactive/${encodeURIComponent(agentCode)}`,
                mountId: 'employees.detail',
                title: name,
                entityLabel: name,
                agentCode,
                layout: 'wide',
              })
            }}
          />
        ) : null}
      </div>
    </div>
  )
}

function DeptColumn({
  dept,
  selectedPersonCode,
  selectedDeptId,
  onPath = false,
  showFloat = false,
  onSelectDept,
  onSelectPerson,
  onCloseFloat,
  onOpenChat,
  onAvatarChanged,
}: {
  dept: HomeCmdDept
  selectedPersonCode: string | null
  selectedDeptId: string | null
  onPath?: boolean
  showFloat?: boolean
  onSelectDept: () => void
  onSelectPerson: (code: string) => void
  onCloseFloat: () => void
  onOpenChat: () => void
  onAvatarChanged?: (deptId: string, avatar: string) => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [dockLeft, setDockLeft] = useState(false)
  const selected = selectedDeptId === dept.id
  const personInDept = !!selectedPersonCode && dept.members.some((m) => m.agent_code === selectedPersonCode)
  /** 参考 UI：未点开只露父卡；点开（或选中其下员工）才挂子节点 */
  const expanded = selected || personInDept || (onPath && !!selectedPersonCode)
  const total = dept.members.length
  const onDutyCount = dept.members.filter((m) => isPersonOnDuty(m)).length
  const busyCount = dept.members.filter((m) => m.busy).length
  const lastAt = deptLastActivityClock(dept.members)
  const shown = dept.members.slice(0, 10)
  const more = Math.max(0, total - shown.length)

  /** 右缘不够放下 276px 浮层时翻到左侧，避免被首页 scroller / 右栏裁半 */
  useLayoutEffect(() => {
    if (!showFloat) {
      setDockLeft(false)
      return
    }
    const el = rootRef.current
    if (!el) return

    const DOCK_W = 276
    const GAP = 14
    const need = DOCK_W + GAP

    const measure = () => {
      const rect = el.getBoundingClientRect()
      const clip =
        el.closest('.chat-messages-inner--home') ||
        el.closest('.react-chat-messages-wrap') ||
        el.closest('.evo-home-cmd__stage') ||
        document.documentElement
      const bounds = clip.getBoundingClientRect()
      const spaceRight = bounds.right - rect.right
      const spaceLeft = rect.left - bounds.left
      if (spaceRight >= need) {
        setDockLeft(false)
        return
      }
      setDockLeft(spaceLeft >= need || spaceLeft > spaceRight)
    }

    measure()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [showFloat, expanded, dept.id])

  return (
    <div
      ref={rootRef}
      className={`evo-home-cmd__dept-tree evo-home-cmd__dept-tree--${dept.accent}${
        selected || personInDept ? ' is-selected' : ''
      }${dept.busyCount ? ' is-busy' : ''}${onPath ? ' is-path' : ''}${
        expanded ? ' is-expanded' : ''
      }${showFloat ? ' has-float' : ''}${dockLeft ? ' is-dock-left' : ''}`}
    >
      <button
        type="button"
        className={`evo-home-cmd__dept-node${selected || personInDept ? ' is-selected' : ''}${
          onPath ? ' is-path' : ''
        }`}
        onClick={onSelectDept}
      >
        <span className="evo-home-cmd__dept-node-top">
          <span className="evo-home-cmd__dept-node-id">
            <DeptAvatar avatar={dept.avatar} name={dept.name} size={28} title={dept.name} />
            <span className="evo-home-cmd__dept-name">{dept.name}</span>
          </span>
          <span
            className={`evo-home-cmd__status${onDutyCount > 0 ? ' is-on' : ' is-off'}`}
            aria-hidden
          />
        </span>
        <span className="evo-home-cmd__dept-kpi-row">
          <span className="evo-home-cmd__dept-kpi">
            {busyCount}
            <small> 执行中</small>
          </span>
          <span className="evo-home-cmd__dept-kpi-side">
            {onDutyCount}/{total}
            <small> 在岗</small>
          </span>
        </span>
        <span className="evo-home-cmd__dept-head-meta">
          {dept.head_role_name ? `${dept.head_role_name} · ` : ''}
          上次 {lastAt}
        </span>
      </button>

      {expanded ? (
        <div className="evo-home-cmd__dept-branch">
          <ul className="evo-home-cmd__dept-leaves">
            {shown.length ? (
              shown.map((p, idx) => {
                const onDuty = isPersonOnDuty(p)
                const clock =
                  formatCmdClock(p.busy_started_at || p.last_heartbeat_at) || '—'
                const kind = p.busy
                  ? String(p.summary || '执行中')
                  : onDuty
                    ? '待命'
                    : '已暂停'
                return (
                  <li key={p.agent_code}>
                    <button
                      type="button"
                      className={`evo-home-cmd__leaf evo-home-cmd__leaf--tone${(idx % 4) + 1}${
                        selectedPersonCode === p.agent_code ? ' is-selected' : ''
                      }${p.busy ? ' is-busy' : ''}${onDuty ? ' is-on-duty' : ' is-off-duty'}`}
                      title={personDutyLabel(p)}
                      aria-label={`${p.role_name}，${personDutyLabel(p)}`}
                      onClick={() => onSelectPerson(p.agent_code)}
                    >
                      <span className="evo-home-cmd__leaf-dot" aria-hidden />
                      <span className="evo-home-cmd__leaf-body">
                        <span className="evo-home-cmd__leaf-name">{p.role_name}</span>
                        <span className="evo-home-cmd__leaf-kind">{kind}</span>
                      </span>
                      <span className="evo-home-cmd__leaf-meta">{clock}</span>
                    </button>
                  </li>
                )
              })
            ) : (
              <li className="evo-home-cmd__people-empty">暂无员工</li>
            )}
            {more > 0 ? <li className="evo-home-cmd__people-more">还有 {more} 人</li> : null}
          </ul>
        </div>
      ) : null}

      {showFloat ? (
        <DeptDetail
          dept={dept}
          onClose={onCloseFloat}
          onOpenChat={onOpenChat}
          onAvatarChanged={(avatar) => onAvatarChanged?.(dept.id, avatar)}
        />
      ) : null}
    </div>
  )
}

function DeptDetail({
  dept,
  onClose,
  onOpenChat,
  onAvatarChanged,
}: {
  dept: HomeCmdDept
  onClose: () => void
  onSelectPerson?: (code: string) => void
  onOpenChat: () => void
  onAvatarChanged?: (avatar: string) => void
}) {
  const total = dept.members.length
  const onDutyCount = dept.members.filter((m) => isPersonOnDuty(m)).length
  const busyCount = dept.members.filter((m) => m.busy).length
  const offDutyCount = Math.max(0, total - onDutyCount)
  const lastAt = deptLastActivityClock(dept.members)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [presets, setPresets] = useState<Array<{ id: string; label: string; url?: string }>>([])
  const [presetsLoading, setPresetsLoading] = useState(false)
  const [savingAvatar, setSavingAvatar] = useState(false)
  const [avatarError, setAvatarError] = useState('')

  const loadPresets = () => {
    if (presets.length || presetsLoading) return
    setPresetsLoading(true)
    void api
      .proactiveListDeptAvatarPresets?.()
      .then((rows: Array<{ id: string; label: string; url?: string }>) => {
        setPresets(Array.isArray(rows) ? rows : [])
      })
      .catch(() => setPresets([]))
      .finally(() => setPresetsLoading(false))
  }

  const applyAvatar = (presetId: string) => {
    if (!presetId || savingAvatar) return
    setSavingAvatar(true)
    setAvatarError('')
    void api
      .proactiveUpdateDepartment(dept.id, { avatar: presetId })
      .then(() => {
        onAvatarChanged?.(presetId)
        setPickerOpen(false)
      })
      .catch((err: unknown) => {
        setAvatarError(String((err as Error)?.message || err || '换头像失败'))
      })
      .finally(() => setSavingAvatar(false))
  }

  return (
    <aside
      className={`evo-home-cmd__detail evo-home-cmd__detail--float evo-home-cmd__detail--dock evo-home-cmd__detail--${dept.accent}`}
      aria-label={`${dept.name} 部门信息`}
    >
      <header className="evo-home-cmd__detail-head">
        <div className="evo-home-cmd__detail-titles">
          <div className="evo-home-cmd__detail-title-row">
            <button
              type="button"
              className="evo-home-cmd__detail-dept-avatar-btn"
              onClick={() => {
                setPickerOpen((v) => !v)
                loadPresets()
              }}
              disabled={savingAvatar}
              aria-expanded={pickerOpen}
              aria-label={pickerOpen ? '收起部门头像选择' : '更换部门头像'}
              title={pickerOpen ? '收起部门头像选择' : '点击更换部门头像'}
            >
              <DeptAvatar
                avatar={dept.avatar}
                name={dept.name}
                size={32}
                className="evo-home-cmd__detail-dept-avatar"
              />
            </button>
            <h3 className="evo-home-cmd__detail-title">{dept.name}</h3>
            <span
              className={`evo-home-cmd__status${onDutyCount > 0 ? ' is-on' : ' is-off'}`}
              title={onDutyCount > 0 ? `${onDutyCount} 人在岗` : '暂无人在岗'}
              aria-label={onDutyCount > 0 ? `${onDutyCount} 人在岗` : '暂无人在岗'}
            />
          </div>
          <p className="evo-home-cmd__detail-sub">
            {dept.head_role_name ? `负责人 ${dept.head_role_name}` : '暂无负责人'}
            {` · ${total} 人编制`}
          </p>
        </div>
        <button type="button" className="evo-home-cmd__detail-close" aria-label="关闭" onClick={onClose}>
          <X className="evo-home-ic" />
        </button>
      </header>

      {pickerOpen || avatarError ? (
        <div className="evo-home-cmd__dept-avatar-editor">
          {avatarError ? <span className="evo-home-cmd__dept-avatar-err">{avatarError}</span> : null}
          {pickerOpen ? (
            <div className="evo-home-cmd__dept-avatar-grid" role="listbox" aria-label="选择部门头像">
              {presetsLoading && !presets.length ? (
                <span className="evo-home-cmd__people-empty">加载中…</span>
              ) : null}
              {presets.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="option"
                  aria-selected={normalizeDeptAvatarId(dept.avatar) === p.id}
                  className={`evo-home-cmd__dept-avatar-opt${
                    normalizeDeptAvatarId(dept.avatar) === p.id ? ' is-active' : ''
                  }`}
                  title={p.label}
                  onClick={() => applyAvatar(p.id)}
                  disabled={savingAvatar}
                >
                  <DeptAvatar avatar={p.id} name={p.label} size={30} title={p.label} />
                  <span>{p.label}</span>
                </button>
              ))}
              {!presetsLoading && !presets.length ? (
                <span className="evo-home-cmd__people-empty">暂无头像预设</span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="evo-home-cmd__detail-snap">
        <span>今日快照</span>
        <strong>
          在岗 {onDutyCount} · 执行 {busyCount} · 上次 {lastAt}
        </strong>
      </div>

      <div className="evo-home-cmd__detail-stats">
        <div>
          <strong>{onDutyCount}</strong>
          <span>人在岗</span>
        </div>
        <div>
          <strong>{busyCount}</strong>
          <span>执行中</span>
        </div>
        <div>
          <strong>{offDutyCount}</strong>
          <span>不在岗</span>
        </div>
        <div>
          <strong>{lastAt}</strong>
          <span>上次活动</span>
        </div>
      </div>

      <button type="button" className="evo-home-cmd__detail-link" onClick={onOpenChat}>
        打开部门群聊 →
      </button>
    </aside>
  )
}

function PersonDetail({
  person,
  onClose,
  onOpenEmployee,
}: {
  person: HomeCmdPerson
  onClose: () => void
  onOpenEmployee: () => void
}) {
  const isSteward = person.agent_code.toLowerCase() === XIAOMI_CODE
  const lastAt = formatCmdClock(person.busy_started_at || person.last_heartbeat_at) || '—'
  const nextAt = formatCmdClock(person.next_heartbeat_at) || '—'
  return (
    <aside className="evo-home-cmd__detail evo-home-cmd__detail--float" aria-label={`${person.role_name} 明细`}>
      <header className="evo-home-cmd__detail-head">
        <div className="evo-home-cmd__detail-titles">
          <div className="evo-home-cmd__detail-title-row">
            <h3 className="evo-home-cmd__detail-title">{person.role_name}</h3>
            <span
              className={`evo-home-cmd__status${isPersonOnDuty(person) ? ' is-on' : ' is-off'}`}
              title={personDutyLabel(person)}
              aria-label={personDutyLabel(person)}
            />
          </div>
          <p className="evo-home-cmd__detail-sub">
            {isSteward ? '汇总 · 派活 · 验收' : `${person.department || '未分部门'} · 执行与产出`}
          </p>
        </div>
        <button type="button" className="evo-home-cmd__detail-close" aria-label="关闭" onClick={onClose}>
          <X className="evo-home-ic" />
        </button>
      </header>

      <div className="evo-home-cmd__detail-stats">
        <div>
          <strong>{person.busy ? '执行中' : '待命'}</strong>
          <span>当前状态</span>
        </div>
        <div>
          <strong>{isSteward ? '大管家' : '一线'}</strong>
          <span>角色定位</span>
        </div>
        <div>
          <strong>{lastAt}</strong>
          <span>上次活动</span>
        </div>
        <div>
          <strong>{nextAt}</strong>
          <span>下次巡视</span>
        </div>
      </div>

      <p className="evo-home-cmd__detail-summary">
        {isSteward
          ? '你的大管家：承接指令、协调各部门，并把需要拍板的事交回给你。'
          : person.reports_to
            ? '按汇报线向上协同，任务结果汇入本部门。'
            : '与小V协同，承接派工与验收。'}
      </p>

      <button type="button" className="evo-home-cmd__detail-btn" onClick={onOpenEmployee}>
        点一下看细节 →
      </button>
    </aside>
  )
}

export function HomeOrgPulseStrip({
  busyCount = 0,
  totalCount = 0,
  waitCount = 0,
  onOpenOverview,
}: {
  busyCount?: number
  totalCount?: number
  waitCount?: number
  onOpenOverview: () => void
}) {
  return (
    <div className="evo-home-cmd-pulse">
      <div className="evo-home-cmd-pulse__left">
        <span className="evo-home-cmd__pulse-dot" aria-hidden />
        <strong>
          {busyCount}/{totalCount || '—'}
        </strong>
        <span>人在岗</span>
        <span className="evo-home-cmd__toolbar-sep" aria-hidden>
          ·
        </span>
        <span className="evo-home-cmd__toolbar-wait">待你处理 {waitCount}</span>
      </div>
      <button type="button" className="evo-home-btn evo-home-btn--chip" onClick={onOpenOverview}>
        流转图
      </button>
    </div>
  )
}
