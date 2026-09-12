/**
 * 会议室员工音色：女头像 → 女声，男头像 → 男声。
 * 优先 agent.tts_speaker（若与头像性别冲突则改回匹配池）；否则按头像预设 / 角色名推断。
 */
import { VOLCENGINE_TTS_SPEAKER_PRESETS } from './volcengine-tts-speakers.js'

/** 女声池（通用向） */
const FEMALE_VOICE_POOL = [
  'zh_female_vv_uranus_bigtts',
  'zh_female_xiaohe_uranus_bigtts',
  'zh_female_qingxinnvsheng_uranus_bigtts',
  'zh_female_shuangkuaisisi_uranus_bigtts',
  'zh_female_zhixingnv_uranus_bigtts',
  'zh_female_kailangjiejie_uranus_bigtts',
  'zh_female_wenroushunv_uranus_bigtts',
  'zh_female_tianmeixiaoyuan_uranus_bigtts',
  'zh_female_sophie_uranus_bigtts',
  'zh_female_linjianvhai_uranus_bigtts',
]

/** 男声池（通用向） */
const MALE_VOICE_POOL = [
  'zh_male_m191_uranus_bigtts',
  'zh_male_taocheng_uranus_bigtts',
  'zh_male_ruyayichen_uranus_bigtts',
  'zh_male_yuanboxiaoshu_uranus_bigtts',
  'zh_male_yangguangqingnian_uranus_bigtts',
  'zh_male_gaolengchenwen_uranus_bigtts',
  'zh_male_huolixiaoge_uranus_bigtts',
  'zh_male_cixingjieshuonan_uranus_bigtts',
  'zh_male_liufei_uranus_bigtts',
  'zh_male_wennuanahu_uranus_bigtts',
]

/**
 * 系统头像预设 → 视觉性别（对照 assets/avatar_presets/*.png）
 * @type {Record<string, 'female' | 'male'>}
 */
const PRESET_GENDER = {
  pm: 'female',
  analyst: 'female',
  designer: 'female',
  lead: 'female',
  researcher: 'female',
  guardian: 'female',
  scientist: 'female',
  engineer: 'male',
  ops: 'male',
  creator: 'male',
  intern: 'male',
  support: 'male',
}

const PRESET_SET = new Set(VOLCENGINE_TTS_SPEAKER_PRESETS.map((p) => p.value))

const FEMALE_NAME_RE =
  /女|姐|妹|妈|婆|姨|妞|姑娘|小姐|淑女|御姐|萝莉|美女|女孩|女神|闺蜜|护士|秘书|主播|文案|编导|设计|分析|产品|运营|小V|小薇|薇|娜|婷|丽|芳|静|雪|燕|梅|霞|娟|敏|慧|琳|颖|倩|悦|萌|甜|雅|瑶|萱|怡|彤|灿|何/
const MALE_NAME_RE =
  /男|哥|弟|叔|爷|爸|汉|仔|少年|先生|大叔|总裁|导演|工程|后端|前端|架构|运维|安全|技术总监|工程师|强|伟|磊|军|杰|涛|鹏|浩|凯|辉|刚|勇|峰|龙|博|轩|舟|飞|虎/

/** @param {string} code */
function hashCode(code) {
  const s = String(code || '').trim().toLowerCase()
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0
  return h
}

/**
 * @param {string} speaker
 * @returns {'female' | 'male' | ''}
 */
export function genderFromSpeakerId(speaker) {
  const s = String(speaker || '').toLowerCase()
  if (!s) return ''
  if (s.includes('female') || s.includes('_nv') || s.includes('woman') || s.includes('girl')) {
    return 'female'
  }
  if (s.includes('male') || s.includes('_nan') || s.includes('man') || s.includes('boy')) {
    return 'male'
  }
  return ''
}

/**
 * @param {unknown} agent
 * @returns {string}
 */
export function readAgentTtsSpeaker(agent) {
  if (!agent || typeof agent !== 'object') return ''
  const a = /** @type {Record<string, unknown>} */ (agent)
  const raw = a.tts_speaker || a.ttsSpeaker || a.voice_type || a.voiceType || ''
  return String(raw || '').trim()
}

/**
 * @param {unknown} agent
 * @returns {'female' | 'male' | ''}
 */
function genderFromExplicitField(agent) {
  if (!agent || typeof agent !== 'object') return ''
  const a = /** @type {Record<string, unknown>} */ (agent)
  const meta =
    a.avatar_meta && typeof a.avatar_meta === 'object'
      ? /** @type {Record<string, unknown>} */ (a.avatar_meta)
      : null
  const raw = a.gender || a.sex || meta?.gender || meta?.sex || ''
  const g = String(raw || '')
    .trim()
    .toLowerCase()
  if (!g) return ''
  if (['f', 'female', 'woman', 'girl', '女', '女性'].includes(g)) return 'female'
  if (['m', 'male', 'man', 'boy', '男', '男性'].includes(g)) return 'male'
  return ''
}

/**
 * @param {unknown} agent
 * @returns {'female' | 'male' | ''}
 */
function genderFromAvatarPreset(agent) {
  if (!agent || typeof agent !== 'object') return ''
  const avatar = String(/** @type {Record<string, unknown>} */ (agent).avatar || '')
    .trim()
    .toLowerCase()
  if (!avatar.startsWith('preset:')) return ''
  const id = avatar.slice('preset:'.length).trim()
  return PRESET_GENDER[id] || ''
}

/**
 * @param {string} agentCode
 * @param {unknown} agent
 * @returns {'female' | 'male' | ''}
 */
function genderFromNameHints(agentCode, agent) {
  const a = agent && typeof agent === 'object' ? /** @type {Record<string, unknown>} */ (agent) : {}
  const blob = [
    a.role_name,
    a.agent_name,
    a.name,
    a.description,
    agentCode,
  ]
    .map((x) => String(x || ''))
    .join(' ')
  const female = FEMALE_NAME_RE.test(blob)
  const male = MALE_NAME_RE.test(blob)
  if (female && !male) return 'female'
  if (male && !female) return 'male'
  if (female && male) {
    // 同时命中时：角色称谓里「女/姐/妹」优先
    if (/女|姐|妹|姑娘|小姐/.test(blob)) return 'female'
    if (/男|哥|叔|爷|先生/.test(blob)) return 'male'
  }
  const code = String(agentCode || '').toLowerCase()
  if (/(girl|woman|female|lady|nv_|_nv|her|xiaomi)/.test(code)) return 'female'
  if (/(boy|man|male|him|nan_|_nan)/.test(code)) return 'male'
  return ''
}

/**
 * @param {string} agentCode
 * @param {unknown} [agent]
 * @returns {'female' | 'male'}
 */
export function inferMeetingAgentGender(agentCode, agent) {
  return (
    genderFromExplicitField(agent) ||
    genderFromAvatarPreset(agent) ||
    genderFromNameHints(agentCode, agent) ||
    // 实在看不出：稳定落到一侧，避免随机乱跳（偏女声池更常见于当前预设库）
    (hashCode(String(agentCode || 'agent')) % 2 === 0 ? 'female' : 'male')
  )
}

/**
 * @param {'female' | 'male'} gender
 * @param {string} agentCode
 */
function pickPoolSpeaker(gender, agentCode) {
  const pool = gender === 'male' ? MALE_VOICE_POOL : FEMALE_VOICE_POOL
  const idx = hashCode(String(agentCode || 'agent').toLowerCase()) % pool.length
  return pool[idx]
}

/**
 * @param {string} agentCode
 * @param {unknown} [agent]
 * @returns {string} volcengine voice_type
 */
export function resolveMeetingAgentSpeaker(agentCode, agent) {
  const gender = inferMeetingAgentGender(agentCode, agent)
  const explicit = readAgentTtsSpeaker(agent)
  if (explicit && (PRESET_SET.has(explicit) || explicit.includes('_') || explicit.startsWith('ICL_'))) {
    const sg = genderFromSpeakerId(explicit)
    // 显式音色与头像性别冲突时，以头像为准（避免女头男声）
    if (sg && sg !== gender) {
      return pickPoolSpeaker(gender, agentCode)
    }
    return explicit
  }
  return pickPoolSpeaker(gender, agentCode)
}

/**
 * @param {string} agentCode
 * @param {unknown} [agent]
 */
export function meetingAgentVoiceLabel(agentCode, agent) {
  const speaker = resolveMeetingAgentSpeaker(agentCode, agent)
  const hit = VOLCENGINE_TTS_SPEAKER_PRESETS.find((p) => p.value === speaker)
  const gender = inferMeetingAgentGender(agentCode, agent)
  const tag = gender === 'male' ? '男声' : '女声'
  return hit ? `${hit.label} · ${tag}` : `${speaker} · ${tag}`
}
