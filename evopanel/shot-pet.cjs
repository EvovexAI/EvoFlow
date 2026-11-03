/* 临时：截图预览页，用完即删 */
const { chromium } = require('playwright')
;(async () => {
  const b = await chromium.launch()
  const p = await b.newPage({ viewport: { width: 1240, height: 620 }, deviceScaleFactor: 2 })
  const errs = []
  p.on('console', (m) => {
    if (m.type() === 'error') errs.push(m.text())
  })
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message))
  await p.goto('http://127.0.0.1:5178/xiaoxi-pet-preview.html', { waitUntil: 'load' })
  await p.waitForFunction(() => document.title === 'ready', null, { timeout: 20000 }).catch(() => {})
  await p.screenshot({ path: 'shot_pet_preview.png', fullPage: true })
  console.log('errors:', JSON.stringify(errs.slice(0, 5)))
  await b.close()
})()
