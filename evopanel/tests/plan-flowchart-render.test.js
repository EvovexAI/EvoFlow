import { describe, expect, it } from 'vitest'
import mermaid from 'mermaid'
import { sanitizeMermaidNodeLabels } from '../src/react/lib/parse-plan-markdown.js'

const USER_DIAGRAM = `flowchart TD
    subgraph 项目结构
        demo2['D:\\\\dev\\\\coding\\\\demo2']
        server['server/ (Express 后端)']
        client['client/ (React Vite 前端)']
    end

    subgraph 后端模块
        app_js['server/app.js<br/>Express 入口 + 中间件']
        routes['server/routes/api.js<br/>GET /api/hello 接口']
        package_server['server/package.json']
    end

    subgraph 前端模块
        vite_config['client/vite.config.js<br/>代理 /api → 后端']
        app_jsx['client/src/App.jsx<br/>调用后端 API 并展示']
        package_client['client/package.json']
    end

    demo2 --> server
    demo2 --> client
    server --> app_js
    server --> routes
    server --> package_server
    client --> vite_config
    client --> app_jsx
    client --> package_client

    app_jsx -- "fetch /api/hello" --> routes`

async function tryParse(code) {
  mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', flowchart: { htmlLabels: true } })
  try {
    await mermaid.parse(code)
    return true
  } catch {
    return false
  }
}

describe('plan flowchart mermaid render', () => {
  it('probes syntax fragments', async () => {
    expect(await tryParse("flowchart TD\n    server['server/ (Express 后端)']")).toBe(false)
    expect(await tryParse('flowchart TD\n    server["server/ (Express 后端)"]')).toBe(true)
    expect(await tryParse("flowchart TD\n    demo2['D:\\\\dev\\\\coding\\\\demo2']")).toBe(true)
  })

  it('renders typical plan analysis diagram after sanitization', async () => {
    const body = sanitizeMermaidNodeLabels(USER_DIAGRAM)
    expect(await tryParse(body)).toBe(true)
  })
})
