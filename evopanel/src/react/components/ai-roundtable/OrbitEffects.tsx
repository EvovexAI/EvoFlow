import React from 'react'

const PARTICLES = [
  { t: '12%', l: '18%', c: 'cyan', d: '0s' },
  { t: '22%', l: '78%', c: 'violet', d: '1.2s' },
  { t: '38%', l: '8%', c: 'blue', d: '2.4s' },
  { t: '48%', l: '92%', c: 'cyan', d: '0.6s' },
  { t: '62%', l: '14%', c: 'violet', d: '3.1s' },
  { t: '70%', l: '86%', c: 'blue', d: '1.8s' },
  { t: '28%', l: '52%', c: 'cyan', d: '4s' },
  { t: '78%', l: '48%', c: 'violet', d: '2.2s' },
  { t: '8%', l: '42%', c: 'blue', d: '0.9s' },
  { t: '16%', l: '66%', c: 'cyan', d: '3.6s' },
  { t: '34%', l: '28%', c: 'violet', d: '1.5s' },
  { t: '42%', l: '72%', c: 'blue', d: '2.8s' },
  { t: '54%', l: '38%', c: 'cyan', d: '0.3s' },
  { t: '58%', l: '58%', c: 'violet', d: '4.4s' },
  { t: '68%', l: '6%', c: 'blue', d: '2.0s' },
  { t: '74%', l: '32%', c: 'cyan', d: '3.3s' },
  { t: '82%', l: '68%', c: 'violet', d: '1.1s' },
  { t: '88%', l: '22%', c: 'blue', d: '2.6s' },
]

/** 桌外巨型空间轨道 + 微光粒子（纯装饰） */
export default function OrbitEffects() {
  return (
    <div className="ai-rt__orbits" aria-hidden="true">
      <div className="ai-rt__orbit ai-rt__orbit--1" />
      <div className="ai-rt__orbit ai-rt__orbit--2" />
      <div className="ai-rt__orbit ai-rt__orbit--3" />
      <div className="ai-rt__orbit ai-rt__orbit--4" />
      <div className="ai-rt__orbit ai-rt__orbit--5" />
      {PARTICLES.map((p, i) => (
        <span
          key={i}
          className={`ai-rt__particle ai-rt__particle--${p.c}`}
          style={{ top: p.t, left: p.l, animationDelay: p.d }}
        />
      ))}
    </div>
  )
}
