import { useCallback } from 'react'
import { EVOFLOW_INTRO_SELF_LABEL, EVOFLOW_INTRO_SELF_PROMPT } from '../../lib/evoflow-intro-prompt.js'

const CARD_ASSET_BASE = '/assets/evoflow_card_png_assets'

const ACTION_CARDS: Array<{
  id: string
  title: string
  desc: string
  iconSrc: string
  illustrationSrc: string
  prompt: string
}> = [
  {
    id: 'intro',
    title: EVOFLOW_INTRO_SELF_LABEL,
    desc: '了解 EvoFlow 的核心能力\n与使用方式',
    iconSrc: `${CARD_ASSET_BASE}/intro_icon.png`,
    illustrationSrc: `${CARD_ASSET_BASE}/intro_3d.png`,
    prompt: EVOFLOW_INTRO_SELF_PROMPT,
  },
  {
    id: 'agent',
    title: '创建角色',
    desc: '让 AI 帮你设计并创建\n一个专属角色',
    iconSrc: `${CARD_ASSET_BASE}/role_icon.png`,
    illustrationSrc: `${CARD_ASSET_BASE}/role_3d.png`,
    prompt: '我想创建一个新的 AI 角色，请帮我分析需求并设计角色名称、性格设定、擅长领域和系统提示词。设计完成后，直接帮我创建这个角色。',
  },
  {
    id: 'skill',
    title: '创建技能',
    desc: '让 AI 帮你构建一个\n可复用的技能',
    iconSrc: `${CARD_ASSET_BASE}/skill_icon.png`,
    illustrationSrc: `${CARD_ASSET_BASE}/skill_3d.png`,
    prompt: '我想创建一个新的技能（Skill），请帮我分析需求并设计技能名称、描述、参数定义和提示词模板。设计完成后，直接帮我创建这个技能。',
  },
  {
    id: 'cron',
    title: '创建自动化',
    desc: '让 AI 帮你配置一个周期\n执行任务',
    iconSrc: `${CARD_ASSET_BASE}/schedule_icon.png`,
    illustrationSrc: `${CARD_ASSET_BASE}/schedule_3d.png`,
    prompt: '我想创建一个自动化（Cron Job），请帮我分析需求并确定执行周期、任务目标和触发逻辑。设计完成后，直接帮我配置好这个自动化。',
  },
  {
    id: 'hosted',
    title: '雇佣员工',
    desc: '雇佣一位 AI 员工\n帮你持续推进任务',
    iconSrc: `${CARD_ASSET_BASE}/agent_icon.png`,
    illustrationSrc: `${CARD_ASSET_BASE}/agent_3d.png`,
    prompt: '我想雇佣一位 AI 员工（Hosted Agent），请帮我设计岗位职责、执行步骤和监控策略。设计完成后，帮我写入员工面板并启动运行。',
  },
  {
    id: 'model',
    title: '配置模型',
    desc: '添加并管理 AI 模型\n接入与参数',
    iconSrc: `${CARD_ASSET_BASE}/model_icon.png`,
    illustrationSrc: `${CARD_ASSET_BASE}/model_3d.png`,
    prompt: '__nav__',
  },
]

const MODEL_ROUTE = '#/settings?tab=models'

export function QuickStartPanel({ onPrompt }: { onPrompt?: (text: string) => void }) {
  const handleCard = useCallback(
    (card: (typeof ACTION_CARDS)[number]) => {
      if (card.id === 'model') {
        window.location.hash = MODEL_ROUTE
        return
      }
      if (onPrompt) onPrompt(card.prompt)
    },
    [onPrompt],
  )

  return (
    <div className="quick-start-panel">
      <div className="quick-start-header">
        <h2 className="quick-start-title">
          欢迎来到{' '}
          <span className="quick-start-title-brand">EvoFlow</span>
          {' '}&#x1F44B;
        </h2>
        <p className="quick-start-desc">选择一个功能快速开始，或直接输入你的想法和任务</p>
      </div>

      <div className="quick-start-grid">
        {ACTION_CARDS.map((card) => (
          <button
            key={card.id}
            type="button"
            className="quick-start-card"
            onClick={() => handleCard(card)}
            title={card.prompt === '__nav__' ? '前往配置页面' : card.prompt}
          >
            <div className="quick-start-card-body">
              <div className="quick-start-card-text">
                <span className="quick-start-card-head">
                  <img className="quick-start-card-icon" src={card.iconSrc} alt="" aria-hidden="true" />
                  <span className="quick-start-card-title">{card.title}</span>
                </span>
                <span className="quick-start-card-desc">{card.desc}</span>
              </div>
              <span className="quick-start-card-arrow">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </span>
            </div>
            <div className="quick-start-card-illustration-area">
              <img
                className="quick-start-card-illustration"
                src={card.illustrationSrc}
                alt=""
                aria-hidden="true"
              />
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
