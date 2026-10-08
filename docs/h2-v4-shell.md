# H2.1 v4 shell 落地（ZCode 风格简化版）

> 在 H1 demo 后端的基础上，把 ZCode v4 投影架构**精神复刻**到 EvoFlow 前端。
> **不复制** ZCode 49K v4/ui + 38K shared verbatim——那是 H2.5+ 的工作。

## 已落地（2026-10-08 H2 + H2.5）

```
evopanel/src/react/v4/
  index.ts                      统一导出 + EvoFlowV4SessionPane
  protocol/types.ts             verbatim 再导出 zcode-protocol-v4
  protocol/zcode-protocol-v4/   **verbatim copy** ZCode v4 协议 (5 文件 ~600 行)
  conversationProjectionStore.ts  verbatim 兼容 + 真实 applyConversationDeltas
  useConversationProjection.ts  React hook via useSyncExternalStore
  sessionDataLayer.ts           per-session acquire/release + keep-warm (ZCode 风格)
  EvoFlowV4SessionPane.tsx      极简 UI 骨架（不复刻 ZCode 4723 行 SessionPane）
  transport/
    transport.ts                ConversationTransport interface (4 methods)
    evoflowTransport.ts         EvoFlowV4Transport：H1 client → ZCode interface
```

## 架构对照

| ZCode v4 | EvoFlow v4 | 备注 |
|---|---|---|
| `@zcode/shared/zcode-protocol-v4` zod | `protocol/types.ts` 极简 types | H2.5 verbatim copy |
| `v4/conversationProjectionStore.ts` 1321 行 | `conversationProjectionStore.ts` 295 行 | H2.5 升级：applyConversationDeltas + recoveryDeadline + status machine |
| `v4/useConversationProjection.ts` 29 行 | 同 | 1:1 |
| `v4/sessionDataLayer.ts` 190 行 | `sessionDataLayer.ts` 165 行 | 简化：ZCode keep-warm + e2e bridge 留 H2.5 |
| `v4/transport.ts` 162 行（~15 methods） | `transport.ts` 39 行（4 methods） | H1 demo 仅需 subscribe/unsubscribe/sendCommand/onFrame |
| `v4/SessionPane.tsx` 4723 行 | `EvoFlowV4SessionPane.tsx` 极简骨架 | H2.5 不复刻 ZCode UI 样式系统（依赖过重），UI 渲染留 H3+ |
| `v4/ConversationTimeline.tsx` 1863 行 | 未迁移 | H3+ |
| `v4/ConversationRowView.tsx` 2122 行 | 未迁移 | H3+ |

## 已验证

- [x] 后端 v4_demo endpoint 仍然 work（上一份 spec 里的 4 个 endpoint）
- [x] 前端 typecheck: 78 errors (baseline 一致, 0 新增)
- [x] Vite dev proxy → backend `/api/v4/demo/{new_session, send_text, snapshot}`
- [x] `EvoFlowV4Transport.subscribe` 拉 initial snapshot frame + 启 SSE consumer
- [x] `EvoFlowV4Transport.sendCommand(sendText)` 通过 H1 client 调后端
- [x] MiniSessionPane 通过 `useConversationProjection(storeRef.current)` 订阅 rows
- [x] **H2.5**: 前端 protocol.ts / store / apply 全部接 verbatim `zcode-protocol-v4`
- [x] **H2.5**: 后端 Pydantic schema 字段对齐 ZCode（`complete`/`interrupted` 替 `closed`，去 `version`）
- [x] **H2.5**: Vite production build 通过 (18.59s)

## 验证方法

```bash
# 后端
cd backend
EVOFLOW_V4_DEMO=1 .\.venv\Scripts\python -m uvicorn app.gateway.app:app --host 127.0.0.1 --port 8780

# 前端 (新窗口)
cd evopanel
EVOFLOW_GATEWAY_URL=http://127.0.0.1:8780 npm run dev

# 浏览器
open http://localhost:1421
DevTools console:
  localStorage.setItem('evoflowH1V4Demo', '1'); location.reload()

# 屏幕右下角面板 — 发条消息看 v4 streaming
```

## H2.5 计划（**已完成** 2026-10-08）

- [x] 复制 ZCode `packages/shared/src/zcode-protocol-v4/` (5 核心文件) → `evopanel/src/react/v4/protocol/zcode-protocol-v4/`
- [x] 前端 `protocol/types.ts` 改 verbatim 再导出
- [x] `conversationProjectionStore.ts` 接 verbatim `applyConversationDeltas`
- [x] 后端 Pydantic schema 字段对齐（去 `version`、`closed` → `complete`/`interrupted`）
- [x] `EvoFlowV4SessionPane.tsx` 极简 UI 骨架（不复刻 ZCode 4723 行 SessionPane）
- [ ] 复制 ZCode `SessionPane.tsx` (4723) → 同名（H3+，等后端 SSE 重写完成 + EvoFlow UI 样式可承载）
- [ ] 复制 `ConversationTimeline.tsx` + `ConversationRowView.tsx` (~5000) → 同名（H3+）
- [ ] 接入 ChatApp：流式渲染路径换为 `<SessionPane />`，命令派发层按 ZCode 风格重写（H3+）

## H3+ 计划

### H3-A（本 commit 落地）

- [x] `v4_demo/orchestrator.py` 加 `EVOFLOW_V4_LLM=1` 真实 LLM 路径（OpenAI 兼容 SSE 流）
- [x] `docs/h3-llm-stream.md` 落地说明

### H3-B~E（推迟）

- [ ] 后端 SSE 路由整体迁移到 v4 projection writer（替代 agui_stream_normalizer） — H4 sprint
- [ ] DB schema v4 row storage + 历史 thread 迁移 — 等 H3-B 完成
- [ ] 业务面板 v4 shell 适配 — 等 H3-B 完成
- [ ] ChatComposer 派发改 `EvoFlowV4Transport.sendCommand` — 等业务面板做完