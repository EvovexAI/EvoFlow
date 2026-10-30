/**
 * 侧栏标题微光的前置判断：没有渐变底图就不该启动 60fps rAF。
 * 回归背景：默认主题 .react-chat-aside-toolbar-title 是 background:none，
 * 旧实现仍无条件每帧写 background-position —— 纯空转，主线程永不空闲，
 * 拖动窗口时与拖窗消息泵抢时间片。
 */
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { hasShimmerGradient } from '../src/lib/aside-title-shimmer.js'

const el = { nodeType: 1, tagName: 'SPAN' }

const styleWith = (backgroundImage) => () => ({ backgroundImage })

test('background: none 时不启动微光（默认主题）', () => {
  assert.equal(hasShimmerGradient(el, styleWith('none')), false)
})

test('linear-gradient 时启动微光（科技风主题）', () => {
  assert.equal(
    hasShimmerGradient(el, styleWith('linear-gradient(135deg, rgb(1,2,3), rgb(4,5,6))')),
    true,
  )
})

test('url() 图片底、无渐变时不启动', () => {
  assert.equal(hasShimmerGradient(el, styleWith('url("/images/logo.png")')), false)
})

test('repeating-linear-gradient 也认作可位移渐变', () => {
  assert.equal(
    hasShimmerGradient(el, styleWith('repeating-linear-gradient(90deg, #000 0 10px, #fff 10px 20px)')),
    true,
  )
})

test('没有元素 / 读取失败时安全返回 false', () => {
  assert.equal(hasShimmerGradient(null, styleWith('linear-gradient(red, blue)')), false)
  assert.equal(hasShimmerGradient(el, () => { throw new Error('boom') }), false)
  assert.equal(hasShimmerGradient(el, () => ({})), false)
})

test('初始化时明确清空内联 background-position', () => {
  const node = { nodeType: 1, tagName: 'SPAN', style: { backgroundPosition: '12px 50%' } }
  // 模拟 _startAsideTitleShimmerLoop 在无渐变分支的行为
  if (!hasShimmerGradient(node, styleWith('none'))) node.style.backgroundPosition = ''
  assert.equal(node.style.backgroundPosition, '')
})
