import React from 'react'

type Props = {
  round: string
  live: boolean
  showCenter: boolean
}

/** 5 层深色玻璃 AI 舞台 */
export default function RoundTableSurface({ round, live, showCenter }: Props) {
  return (
    <div className="ai-rt__table">
      <div className="ai-rt__table-glow" />
      <div className="ai-rt__table-outer-ring">
        <span className="ai-rt__table-arc ai-rt__table-arc--cyan" />
        <span className="ai-rt__table-arc ai-rt__table-arc--violet" />
        <span className="ai-rt__table-arc ai-rt__table-arc--cyan2" />
        <span className="ai-rt__table-arc ai-rt__table-arc--violet2" />
        <span className="ai-rt__table-arc ai-rt__table-arc--mint" />
      </div>
      <div className="ai-rt__table-main">
        <div className="ai-rt__table-grid" />
        <div className="ai-rt__table-scan" />
        <div className="ai-rt__table-hglow" />
        <div className="ai-rt__table-inner-ring ai-rt__table-inner-ring--1" />
        <div className="ai-rt__table-inner-ring ai-rt__table-inner-ring--2" />
        <div className="ai-rt__table-inner-ring ai-rt__table-inner-ring--3" />
        {showCenter ? (
          <div className="ai-rt__table-center">
            <div className="ai-rt__table-title">AI员工聊天</div>
            <div className="ai-rt__table-round">
              第 {Number(round) || 1} 轮 ·{' '}
              <strong className={live ? 'is-live' : 'is-idle'}>{live ? '讨论中' : '待命'}</strong>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
