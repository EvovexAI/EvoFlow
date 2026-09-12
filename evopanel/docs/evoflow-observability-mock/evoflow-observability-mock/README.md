# EvoFlow Observability Mock Frontend

这是一个基于 **Vite + React + TypeScript** 的 EvoFlow 观测平台前端 mock 项目。

已包含页面：

- Dashboard：观测总览
- Requests：请求日志
- Agents：Agent 管理
- Models：模型与厂商
- Tools：工具调用
- Gateway：网关日志
- Trace：会话追踪
- Analytics：成本与趋势分析
- Settings：设置

## 运行方式

```bash
npm install
npm run dev
```

默认访问：

```bash
http://localhost:5173
```

## 打包

```bash
npm run build
npm run preview
```

## 数据位置

mock 数据在：

```text
src/data/mock.ts
```

## 样式位置

整体深色观测平台风格在：

```text
src/styles/global.css
```

## 后续接后端建议

可以将 `src/data/mock.ts` 替换成真实 API 请求，例如：

- observabilityDashboard
- observabilityRequests
- observabilityModelDetail
- observabilityModels
- observabilityProviders
- observabilityTools
- observabilityGateway
- observabilityTrace
- listAgentsDetailed
