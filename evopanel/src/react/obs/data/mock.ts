import type {
  AgentRecord,
  GatewayRoute,
  Metric,
  ModelRecord,
  ProviderRecord,
  RequestRecord,
  TimePoint,
  ToolCallRecord,
  ToolRecord,
  TraceRecord
} from '../types';

export const metrics: Metric[] = [
  { title: '请求总数', value: '128,430', delta: '+12.4% vs 7d 前', trend: 'up', icon: '〽', accent: 'blue', data: [24, 28, 26, 33, 31, 37, 42, 39, 35, 46, 44, 41] },
  { title: '成功率', value: '98.24%', delta: '-0.6pp vs 7d 前', trend: 'bad', icon: '✓', accent: 'green', data: [91, 92, 92, 94, 91, 90, 93, 92, 94, 95, 94, 93] },
  { title: '平均耗时', value: '842ms', delta: '+18ms vs 7d 前', trend: 'bad', icon: '◷', accent: 'purple', data: [42, 44, 48, 46, 50, 49, 47, 52, 51, 54, 53, 55] },
  { title: 'Token 消耗', value: '42.8M', delta: '+21.7% vs 7d 前', trend: 'up', icon: '◉', accent: 'orange', data: [32, 36, 39, 43, 41, 45, 48, 50, 46, 52, 55, 58] },
  { title: '预估成本', value: '$186.42', delta: '+16.3% vs 7d 前', trend: 'up', icon: '$', accent: 'cyan', data: [21, 23, 27, 25, 28, 31, 30, 34, 33, 36, 39, 41] }
];

export const requestTrend: TimePoint[] = [
  { label: '5/13', total: 19800, success: 14200, failed: 2100, warning: 3500, prompt: 3.2, completion: 4.1, cost: 14.8 },
  { label: '5/14', total: 17800, success: 12450, failed: 1900, warning: 3450, prompt: 2.4, completion: 5.8, cost: 15.2 },
  { label: '5/15', total: 21800, success: 15380, failed: 2600, warning: 3820, prompt: 3.6, completion: 4.2, cost: 16.9 },
  { label: '5/16', total: 17000, success: 11600, failed: 1800, warning: 3600, prompt: 2.8, completion: 6.1, cost: 15.7 },
  { label: '5/17', total: 20400, success: 14120, failed: 2300, warning: 3980, prompt: 4.2, completion: 5.3, cost: 18.1 },
  { label: '5/18', total: 22600, success: 15600, failed: 2200, warning: 4800, prompt: 3.9, completion: 7.6, cost: 20.4 },
  { label: '5/19', total: 18430, success: 12870, failed: 2450, warning: 3110, prompt: 4.4, completion: 5.9, cost: 17.3 }
];

export const recentRequests: RequestRecord[] = [
  { id: 'req_01HX2F8Z7V7J1P3Q6N8K5M2L7A', status: 'failed', time: '2025-05-19 14:35:21', relativeTime: '8 分钟前', agent: 'SummarizeAgent', model: 'GPT-4o mini', provider: 'OpenAI', latency: '5.21s', latencyMs: 5210, promptTokens: 812, completionTokens: 433, tokens: 1245, cost: 0.0056, threadId: 'thr_8H3QK92', runId: 'run_7VJ1P3', stage: 'model_call', modelCallSeq: 3, payloadMessageCount: 5, failureMessage: 'Rate limit exceeded', region: 'us-east-1' },
  { id: 'req_01HX2F8Z7V7J1P3Q6N8K5M2L7B', status: 'success', time: '2025-05-19 14:41:21', relativeTime: '2 分钟前', agent: 'ResearchAgent', model: 'GPT-4.1', provider: 'OpenAI', latency: '812ms', latencyMs: 812, promptTokens: 1220, completionTokens: 1131, tokens: 2351, cost: 0.0182, threadId: 'thr_2LPO990', runId: 'run_090KLM', stage: 'final', modelCallSeq: 1, payloadMessageCount: 8, region: 'us-east-1' },
  { id: 'req_01HX2F8Z7V7J1P3Q6N8K5M2L7C', status: 'warning', time: '2025-05-19 14:38:12', relativeTime: '5 分钟前', agent: 'CodeAgent', model: 'Claude 3.5 Sonnet', provider: 'Anthropic', latency: '1.24s', latencyMs: 1240, promptTokens: 3334, completionTokens: 1538, tokens: 4872, cost: 0.0321, threadId: 'thr_AQK0091', runId: 'run_PLK123', stage: 'tool_call', modelCallSeq: 5, payloadMessageCount: 12, failureMessage: 'Tool retry once', region: 'us-west-2' },
  { id: 'req_01HX2F8Z7V7J1P3Q6N8K5M2L7D', status: 'success', time: '2025-05-19 14:36:42', relativeTime: '7 分钟前', agent: 'DataAnalyst', model: 'Gemini 1.5 Pro', provider: 'Google', latency: '1.03s', latencyMs: 1030, promptTokens: 2070, completionTokens: 1837, tokens: 3907, cost: 0.0198, threadId: 'thr_GEM223', runId: 'run_GG401', stage: 'final', modelCallSeq: 2, payloadMessageCount: 6, region: 'asia-east1' },
  { id: 'req_01HX2F8Z7V7J1P3Q6N8K5M2L7E', status: 'success', time: '2025-05-19 14:32:01', relativeTime: '11 分钟前', agent: 'TranslateAgent', model: 'DeepSeek', provider: 'DeepSeek', latency: '932ms', latencyMs: 932, promptTokens: 1515, completionTokens: 1361, tokens: 2876, cost: 0.0112, threadId: 'thr_DSK009', runId: 'run_DSK782', stage: 'final', modelCallSeq: 1, payloadMessageCount: 3, region: 'cn-east' },
  { id: 'req_01HX2F8Z7V7J1P3Q6N8K5M2L7F', status: 'warning', time: '2025-05-19 14:21:45', relativeTime: '22 分钟前', agent: 'PlanningAgent', model: 'Local Llama', provider: 'Local', latency: '2.18s', latencyMs: 2180, promptTokens: 982, completionTokens: 702, tokens: 1684, cost: 0.0000, threadId: 'thr_LOC111', runId: 'run_LOC019', stage: 'planning', modelCallSeq: 4, payloadMessageCount: 15, failureMessage: 'Slow local inference', region: 'local' }
];

export const agents: AgentRecord[] = [
  { name: 'ResearchAgent', status: 'normal', requests: 28430, successRate: 98.9, avgLatency: '812ms', tokens: '8.2M', mainModel: 'GPT-4.1', tools: 12420, owner: 'Knowledge Team' },
  { name: 'CodeAgent', status: 'warning', requests: 18321, successRate: 96.4, avgLatency: '1.24s', tokens: '6.8M', mainModel: 'Claude 3.5 Sonnet', tools: 18220, owner: 'DevTools Team' },
  { name: 'DataAnalyst', status: 'normal', requests: 22104, successRate: 98.1, avgLatency: '1.03s', tokens: '7.4M', mainModel: 'Gemini 1.5 Pro', tools: 9730, owner: 'Data Team' },
  { name: 'SummarizeAgent', status: 'error', requests: 16781, successRate: 91.2, avgLatency: '5.21s', tokens: '3.9M', mainModel: 'GPT-4o mini', tools: 4220, owner: 'Docs Team' },
  { name: 'TranslateAgent', status: 'normal', requests: 10922, successRate: 99.1, avgLatency: '932ms', tokens: '3.1M', mainModel: 'DeepSeek', tools: 1290, owner: 'Localization' }
];

export const providers: ProviderRecord[] = [
  { name: 'OpenAI', status: 'warning', requests: 84200, successRate: 98.1, avgLatency: '920ms', tokens: '31.2M', cacheReadTokens: '—', cacheHitRate: '—', estimatedSavingsCny: '—', cost: 142.8, errors: 'rate_limit 42, timeout 18' },
  { name: 'Anthropic', status: 'normal', requests: 24312, successRate: 99.0, avgLatency: '1.12s', tokens: '9.8M', cacheReadTokens: '—', cacheHitRate: '—', estimatedSavingsCny: '—', cost: 42.37, errors: 'timeout 7' },
  { name: 'Google', status: 'normal', requests: 18760, successRate: 98.4, avgLatency: '1.03s', tokens: '7.1M', cacheReadTokens: '—', cacheHitRate: '—', estimatedSavingsCny: '—', cost: 31.24, errors: 'quota 5' },
  { name: 'DeepSeek', status: 'normal', requests: 10234, successRate: 97.8, avgLatency: '932ms', tokens: '3.2M', cacheReadTokens: '—', cacheHitRate: '—', estimatedSavingsCny: '—', cost: 12.08, errors: 'network 3' },
  { name: 'Local', status: 'warning', requests: 6127, successRate: 94.2, avgLatency: '2.46s', tokens: '1.5M', cacheReadTokens: '—', cacheHitRate: '—', estimatedSavingsCny: '—', cost: 0, errors: 'gpu_busy 21' }
];

export const models: ModelRecord[] = [
  { model: 'GPT-4.1', provider: 'OpenAI', requests: 32145, successRate: 99.1, avgLatency: '812ms', p95Latency: '1.92s', promptTokens: '7.8M', completionTokens: '4.8M', tokens: '12.6M', tokensNum: 12600000, cacheReadTokens: '—', cacheReadNum: 0, cacheHitRate: '—', estimatedSavingsCny: '—', cost: 58.21, errorRate: 0.9, mainAgents: ['ResearchAgent', 'PlanningAgent'] },
  { model: 'Claude 3.5 Sonnet', provider: 'Anthropic', requests: 24312, successRate: 98.7, avgLatency: '1.24s', p95Latency: '2.81s', promptTokens: '6.2M', completionTokens: '3.6M', tokens: '9.8M', tokensNum: 9800000, cacheReadTokens: '—', cacheReadNum: 0, cacheHitRate: '—', estimatedSavingsCny: '—', cost: 42.37, errorRate: 1.3, mainAgents: ['CodeAgent'] },
  { model: 'Gemini 1.5 Pro', provider: 'Google', requests: 18760, successRate: 98.4, avgLatency: '1.03s', p95Latency: '2.11s', promptTokens: '4.5M', completionTokens: '2.6M', tokens: '7.1M', tokensNum: 7100000, cacheReadTokens: '—', cacheReadNum: 0, cacheHitRate: '—', estimatedSavingsCny: '—', cost: 31.24, errorRate: 1.6, mainAgents: ['DataAnalyst'] },
  { model: 'GPT-4o mini', provider: 'OpenAI', requests: 16852, successRate: 94.2, avgLatency: '1.86s', p95Latency: '5.21s', promptTokens: '3.4M', completionTokens: '2.2M', tokens: '5.6M', tokensNum: 5600000, cacheReadTokens: '—', cacheReadNum: 0, cacheHitRate: '—', estimatedSavingsCny: '—', cost: 21.15, errorRate: 5.8, mainAgents: ['SummarizeAgent'] },
  { model: 'DeepSeek', provider: 'DeepSeek', requests: 10234, successRate: 97.9, avgLatency: '932ms', p95Latency: '1.87s', promptTokens: '1.9M', completionTokens: '1.3M', tokens: '3.2M', tokensNum: 3200000, cacheReadTokens: '—', cacheReadNum: 0, cacheHitRate: '—', estimatedSavingsCny: '—', cost: 12.08, errorRate: 2.1, mainAgents: ['TranslateAgent'] },
  { model: 'Local Llama', provider: 'Local', requests: 6127, successRate: 94.2, avgLatency: '2.46s', p95Latency: '6.4s', promptTokens: '1.0M', completionTokens: '0.5M', tokens: '1.5M', tokensNum: 1500000, cacheReadTokens: '—', cacheReadNum: 0, cacheHitRate: '—', estimatedSavingsCny: '—', cost: 0, errorRate: 5.8, mainAgents: ['PlanningAgent'] }
];

export const tools: ToolRecord[] = [
  { name: 'web_search', category: 'Retrieval', requests: 18320, successRate: 98.4, avgLatency: '642ms', p95Latency: '1.2s', failureRate: 1.6, mainAgent: 'ResearchAgent' },
  { name: 'code_interpreter', category: 'Compute', requests: 9220, successRate: 96.2, avgLatency: '2.8s', p95Latency: '7.1s', failureRate: 3.8, mainAgent: 'CodeAgent' },
  { name: 'sql_query', category: 'Database', requests: 7420, successRate: 97.1, avgLatency: '412ms', p95Latency: '1.0s', failureRate: 2.9, mainAgent: 'DataAnalyst' },
  { name: 'file_reader', category: 'IO', requests: 5210, successRate: 99.2, avgLatency: '223ms', p95Latency: '610ms', failureRate: 0.8, mainAgent: 'SummarizeAgent' },
  { name: 'vector_search', category: 'Retrieval', requests: 4821, successRate: 98.8, avgLatency: '384ms', p95Latency: '902ms', failureRate: 1.2, mainAgent: 'ResearchAgent' }
];

export const toolCalls: ToolCallRecord[] = [
  { id: 'tool_001', time: '2025-05-19 14:40:10', toolName: 'web_search', agent: 'ResearchAgent', requestId: 'req_01HX2F8Z7V7J1P3Q6N8K5M2L7B', traceId: 'trace_1001', status: 'success', latency: '642ms', input: '{"query":"agent observability"}', output: '{"results":8}' },
  { id: 'tool_002', time: '2025-05-19 14:38:03', toolName: 'code_interpreter', agent: 'CodeAgent', requestId: 'req_01HX2F8Z7V7J1P3Q6N8K5M2L7C', traceId: 'trace_1002', status: 'warning', latency: '2.8s', input: '{"language":"python"}', output: '{"stdout":"ok"}', error: 'retry once' },
  { id: 'tool_003', time: '2025-05-19 14:36:28', toolName: 'sql_query', agent: 'DataAnalyst', requestId: 'req_01HX2F8Z7V7J1P3Q6N8K5M2L7D', traceId: 'trace_1003', status: 'success', latency: '412ms', input: '{"sql":"select count(*)"}', output: '{"rows":1}' },
  { id: 'tool_004', time: '2025-05-19 14:35:18', toolName: 'file_reader', agent: 'SummarizeAgent', requestId: 'req_01HX2F8Z7V7J1P3Q6N8K5M2L7A', traceId: 'trace_1004', status: 'failed', latency: '5.21s', input: '{"file":"report.pdf"}', output: '{}', error: 'rate limit exceeded' },
  { id: 'tool_005', time: '2025-05-19 14:32:02', toolName: 'vector_search', agent: 'ResearchAgent', requestId: 'req_01HX2F8Z7V7J1P3Q6N8K5M2L7E', traceId: 'trace_1005', status: 'success', latency: '384ms', input: '{"top_k":5}', output: '{"matches":5}' }
];

export const gatewayRoutes: GatewayRoute[] = [
  { route: '/v1/chat/completions', method: 'POST', requests: 54820, avgLatency: '912ms', p95Latency: '2.6s', status2xx: 53120, status4xx: 912, status5xx: 248, rateLimited: 540, upstream: 'OpenAI / Anthropic' },
  { route: '/v1/agents/run', method: 'POST', requests: 22340, avgLatency: '1.34s', p95Latency: '3.1s', status2xx: 21670, status4xx: 311, status5xx: 102, rateLimited: 257, upstream: 'Agent Runtime' },
  { route: '/v1/tools/call', method: 'POST', requests: 18392, avgLatency: '682ms', p95Latency: '2.4s', status2xx: 17800, status4xx: 302, status5xx: 91, rateLimited: 199, upstream: 'Tool Router' },
  { route: '/v1/traces/:id', method: 'GET', requests: 9042, avgLatency: '124ms', p95Latency: '342ms', status2xx: 8974, status4xx: 48, status5xx: 5, rateLimited: 15, upstream: 'SQLite' },
  { route: '/v1/dashboard', method: 'GET', requests: 7120, avgLatency: '88ms', p95Latency: '214ms', status2xx: 7088, status4xx: 21, status5xx: 3, rateLimited: 8, upstream: 'SQLite' }
];

export const traces: TraceRecord[] = [
  {
    id: 'trace_1004',
    threadId: 'thr_8H3QK92',
    agent: 'SummarizeAgent',
    duration: '5.21s',
    steps: 7,
    status: 'failed',
    startedAt: '2025-05-19 14:35:21',
    summary: '文档摘要请求在模型调用阶段被限流。',
    items: [
      { id: 's1', type: 'message', title: 'User Message', duration: '0ms', status: 'success', meta: '输入 812 tokens' },
      { id: 's2', type: 'agent', title: 'Agent Planning', duration: '86ms', status: 'success', meta: '生成摘要计划' },
      { id: 's3', type: 'tool', title: 'Tool Call: file_reader', duration: '223ms', status: 'success', meta: '读取 report.pdf' },
      { id: 's4', type: 'model', title: 'Model Call: GPT-4o mini', duration: '5.21s', status: 'failed', meta: 'Rate limit exceeded' },
      { id: 's5', type: 'error', title: 'Error Handler', duration: '32ms', status: 'failed', meta: '没有可用 fallback model' }
    ]
  },
  {
    id: 'trace_1001',
    threadId: 'thr_2LPO990',
    agent: 'ResearchAgent',
    duration: '1.42s',
    steps: 8,
    status: 'success',
    startedAt: '2025-05-19 14:41:21',
    summary: '完成检索、推理和最终答复。',
    items: [
      { id: 's1', type: 'message', title: 'User Message', duration: '0ms', status: 'success', meta: '研究主题' },
      { id: 's2', type: 'tool', title: 'Tool Call: web_search', duration: '642ms', status: 'success', meta: '返回 8 条结果' },
      { id: 's3', type: 'model', title: 'Model Call: GPT-4.1', duration: '812ms', status: 'success', meta: '生成最终答案' }
    ]
  },
  {
    id: 'trace_1002',
    threadId: 'thr_AQK0091',
    agent: 'CodeAgent',
    duration: '3.18s',
    steps: 6,
    status: 'warning',
    startedAt: '2025-05-19 14:38:12',
    summary: '代码解释器首次超时，重试成功。',
    items: [
      { id: 's1', type: 'message', title: 'User Message', duration: '0ms', status: 'success', meta: '代码分析请求' },
      { id: 's2', type: 'tool', title: 'Tool Call: code_interpreter', duration: '2.8s', status: 'warning', meta: 'retry once' },
      { id: 's3', type: 'model', title: 'Model Call: Claude 3.5 Sonnet', duration: '1.24s', status: 'success', meta: '补全分析' }
    ]
  }
];

export const health = [
  { label: 'Normal', value: 132, percent: 82, color: 'success' },
  { label: 'Warning', value: 18, percent: 11, color: 'warning' },
  { label: 'Error', value: 7, percent: 6, color: 'failed' }
];

export const jsonPreview = {
  request_id: 'req_01HX2F8Z7V7J1P3Q6N8K5M2L7A',
  agent: 'SummarizeAgent',
  model: 'gpt-4o-mini',
  provider: 'openai',
  status: 'failed',
  latency_ms: 5210,
  tokens: {
    prompt: 812,
    completion: 433,
    total: 1245
  },
  cost_usd: 0.0056,
  failure_message: 'Rate limit exceeded',
};
