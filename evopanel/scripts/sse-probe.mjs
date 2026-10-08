/**
 * Direct probe: POST /api/langgraph/threads/{tid}/runs/stream and timestamp every SSE chunk.
 * Usage: node sse-probe.mjs <JWT>
 */
const JWT = process.argv[2] || ''
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8070'
const t0 = Date.now()
const ts = () => `+${String(Date.now() - t0).padStart(6)}ms`

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${JWT}`,
  Accept: 'text/event-stream',
}

// 1) create thread
const tResp = await fetch(`${BASE}/api/langgraph/threads`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ metadata: { source: 'sse-probe' } }),
})
const tText = await tResp.text()
console.log(ts(), 'thread create', tResp.status, tText.slice(0, 200))
const thread = JSON.parse(tText)
const tid = thread.thread_id || thread.id
if (!tid) {
  console.error('no thread id', tText.slice(0, 500))
  process.exit(1)
}

// 2) runs/stream
const query =
  'ui_sse=1&stream_format=agui&cancel_on_disconnect=false&stream_mode=values&stream_mode=messages-tuple&stream_mode=custom'
const body = {
  assistant_id: 'lead_agent',
  input: {
    messages: [
      {
        type: 'human',
        content: [{ type: 'text', text: '请写一篇大约 600 字的短文，主题：城市傍晚的菜市场。要求分 5 个自然段，尽量写满。' }],
      },
    ],
  },
  stream_mode: ['values', 'messages-tuple', 'custom'],
  streamSubgraphs: true,
  streamResumable: true,
  durability: 'exit',
  multitask_strategy: 'interrupt',
  config: { recursion_limit: 150 },
  context: {},
}

const resp = await fetch(`${BASE}/api/langgraph/threads/${encodeURIComponent(tid)}/runs/stream?${query}`, {
  method: 'POST',
  headers,
  body: JSON.stringify(body),
})
console.log(ts(), 'stream status', resp.status, resp.headers.get('content-type'))
if (!resp.ok) {
  console.error(await resp.text())
  process.exit(1)
}

// 3) timestamp chunk arrivals + summarize events
const reader = resp.body.getReader()
const dec = new TextDecoder()
let buf = ''
let chunks = 0
let events = 0
let bytesTotal = 0
let firstEventAt = null
let lastEventAt = 0
let lastLog = 0
while (true) {
  const { value, done } = await reader.read()
  if (done) break
  chunks += 1
  const at = Date.now() - t0
  if (firstEventAt == null) firstEventAt = at
  lastEventAt = at
  bytesTotal += value.length
  buf += dec.decode(value, { stream: true })
  let idx
  while ((idx = buf.indexOf('\n\n')) !== -1) {
    const raw = buf.slice(0, idx)
    buf = buf.slice(idx + 2)
    const evLine = raw.split('\n').find((l) => l.startsWith('event:'))
    const dataLine = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')
    events += 1
    let desc = ''
    try {
      const obj = JSON.parse(dataLine)
      const t = obj.type || obj.kind || eventName(evLine) || '?'
      const len = typeof obj.delta === 'string' ? `delta=${obj.delta.length}` : ''
      const txt = typeof obj.content === 'string' ? `content=${obj.content.length}` : ''
      desc = `${t} ${len}${txt}`.trim()
    } catch {
      desc = dataLine.slice(0, 60)
    }
    // 每个事件都打：时间戳 + 类型 + 体量
    if (events <= 40 || at - lastLog > 400) {
      console.log(ts(), `#${events}`, desc)
      lastLog = at
    }
  }
}
console.log('---')
console.log(ts(), `done: chunks=${chunks} events=${events} bytes=${bytesTotal} firstChunk=+${firstEventAt}ms lastChunk=+${lastEventAt}ms span=${lastEventAt - firstEventAt}ms`)

function eventName(evLine) {
  return evLine ? evLine.slice(6).trim() : ''
}
