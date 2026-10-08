# H1 v4 protocol demo

> 单 session 单消息端到端 demo：前端 MiniSessionPane 通过 v4 protocol 投影后端流。

## 启用方式

### 后端

```bash
cd backend
EVOFLOW_V4_DEMO=1 .\.venv\Scripts\python -m uvicorn app.gateway.app:app --host 127.0.0.1 --port 8780
```

### 前端

1. 启动 vite dev server，把后端代理到 8780：
   ```bash
   cd evopanel
   EVOFLOW_GATEWAY_URL=http://127.0.0.1:8780 npm run dev
   ```
2. 浏览器打开 `http://localhost:1421`
3. 在 DevTools console 设：
   ```js
   localStorage.setItem('evoflowH1V4Demo', '1')
   location.reload()
   ```
4. 屏幕右下角出现一个深色面板 — **H1 v4 demo**。
   - 顶部显示状态（connecting / live / error / closed）+ seq + rows + sessionId + reset
   - 中部显示 turnHeader / user / reasoning / assistantText row
   - 底部 input + send：发条消息 → 看 streaming 文字

## 架构

```
Browser
  ↓ fetch POST /api/v4/demo/new_session
  ↓ fetch POST /api/v4/demo/send_text?session_id=&text=
  ↓ fetch GET  /api/v4/demo/snapshot/{sid}
  ↓ fetch GET  /api/v4/demo/stream/{sid}        (SSE: event: frame)

vite dev (1421) ── /api proxy ──> uvicorn (8780)

uvicorn (FastAPI)
  ├─ /api/v4/demo/new_session     POST  → H1DemoOrchestrator.new_session()
  ├─ /api/v4/demo/send_text       POST  → orchestrator.send_text()  (writes turnHeader + userInput)
  ├─ /api/v4/demo/snapshot/{sid}  GET   → ConversationProjectionWriter.snapshot()
  └─ /api/v4/demo/stream/{sid}    GET   → SSE gen(): snapshot + drain pending frames
```

## 文件清单

```
backend/app/gateway/v4_demo/
  __init__.py
  protocol_v4_min.py        pydantic schemas: ConversationSnapshot / TopicFrame / Deltas
  projection.py             ConversationProjectionWriter: row.appended / row.upserted / row.removed
  orchestrator.py           H1DemoOrchestrator: per-session state + send_text producer
  routes.py                 FastAPI router mounted at /api/v4/demo

evopanel/src/react/v4_demo/
  protocol.ts               TypeScript types matching backend schema
  client.ts                 fetch + SSE consumer
  projection.ts             ConversationProjectionStore (useSyncExternalStore 适配)
  MiniSessionPane.tsx       React 渲染层
  index.ts                  exports + CSS bootstrap

evopanel/src/react/ChatApp.tsx  ← MiniSessionPane 通过 localStorage.evoflowH1V4Demo 挂载
```

## v4 frame wire shape

```ts
interface ConversationTopicFrame {
  subscriptionId: string
  logEpoch: string
  fromSeq: number
  toSeq: number
  payload: ConversationSnapshot | ConversationDeltas
}

interface ConversationSnapshot {
  kind: 'conversationSnapshot'
  sessionId: string
  logEpoch: string
  seq: number
  rows: { window: ConversationRow[]; firstRowId: number | null; totalCount: number }
}

interface ConversationDeltas {
  kind: 'conversationDeltas'
  deltas: Array<
    | { op: 'row.appended'; row: ConversationRow }
    | { op: 'row.upserted'; row: ConversationRow }
    | { op: 'row.removed'; fromRowId: number }
  >
}
```

完整 v4 spec 见 `EvoFlow/docs/protocol-evolution-spec.md` 与 `ZCode/packages/shared/src/zcode-protocol-v4/`。

## 验证清单

- [x] 后端 `EVOFLOW_V4_DEMO=1` 启动后 `POST /api/v4/demo/new_session` 返回 200 + JSON
- [x] `POST /api/v4/demo/send_text?session_id=&text=` 返回 200 + turnId
- [x] `GET /api/v4/demo/snapshot/{sid}` 返回完整 4-row snapshot (turnHeader + userInput + reasoning + assistantText)
- [x] `GET /api/v4/demo/stream/{sid}` 推送 SSE `event: frame` 数据
- [x] Vite dev proxy `localhost:1421/api/*` → `127.0.0.1:8780/api/*`
- [x] 前端 typecheck：78 errors（与 baseline 一致；0 新增）
- [x] MiniSessionPane 通过 `localStorage.evoflowH1V4Demo='1'` 挂载
- [ ] 端到端浏览器内手动验证（用户手工点击 send 看 streaming 文字）

## 已知限制（H1 仅）

- 1 个 demo orchestrator = 1 个内存 session；不接真实 LLM
- 后端 assistant text 写死 echo 字符串 + 固定 reasoning
- 仅 5 种 row kind；toolCall 行不验证 args/result 类型
- 不做会话持久化；服务重启 = session 丢失
- 不与 EvoFlow 现有 ag-ui / LangGraph 适配

## H2 计划

- 复制 ZCode v4/Conversation*.* + SessionPane.tsx + projectionStore.ts
- 替换 ChatApp.tsx 流式渲染路径
- 接入现有 agui_stream_normalizer → v4 projection writer
- 旧 SSE 路由保留作 fallback + feature flag