import React from 'react'
import { bustCropStyle } from '../lib/agent-avatar-meta'

type AgentCustomImageProps = {
  src: string
  aspect: number
  headBox: { x: number; y: number; w: number; h: number }
  size?: number
  busy?: boolean
  onError?: () => void
}

const BUST_MAX_SIZE = 130

const AgentCustomImage: React.FC<AgentCustomImageProps> = ({ src, aspect, headBox, size = 40, busy, onError }) => {
  const bust = size <= BUST_MAX_SIZE
  const w = bust ? size : Math.round(size * aspect)
  const h = size
  const bustStyle = bustCropStyle(headBox, aspect, size)
  const radius = size <= 28 ? 8 : size <= 40 ? 10 : 12

  return (
    <span
      className={`agent-custom-figure${busy ? ' agent-custom-figure--busy' : ''}`}
      style={{
        width: w,
        height: h,
        borderRadius: radius,
        overflow: 'hidden',
        display: 'inline-block',
        background: 'var(--bg-secondary, #f1f5f9)',
        lineHeight: 0,
      }}
    >
      {bust ? (
        <img
          src={src}
          alt=""
          draggable={false}
          onError={onError}
          style={{
            position: 'relative',
            width: bustStyle.width,
            height: bustStyle.height,
            left: bustStyle.left,
            top: bustStyle.top,
            maxWidth: 'none',
            objectFit: 'contain',
          }}
        />
      ) : (
        <img
          src={src}
          alt=""
          draggable={false}
          onError={onError}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      )}
    </span>
  )
}

export default AgentCustomImage
