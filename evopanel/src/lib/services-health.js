export function getHealthProbeCandidates() {
  return [
    'http://localhost:2024/',
  ]
}

export function classifyHealthSource(url) {
  const u = String(url || '')
  if (u.includes(':2024/')) {
    return {
      title: '后端健康检查（LangGraph）',
      tip: '当前命中 LangGraph 端口',
    }
  }
  return {
    title: '服务健康检查',
    tip: '健康检查来源未识别',
  }
}
